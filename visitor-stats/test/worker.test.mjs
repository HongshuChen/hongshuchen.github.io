// Tests for the visitor-stats Worker against an in-memory SQLite database standing in for D1.
// Run with: node --test visitor-stats/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";

import worker from "../src/index.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const SITE = "https://hongshuchen.top";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const EDINBURGH = { country: "GB", city: "Edinburgh", latitude: "55.95330", longitude: "-3.18830" };
const SHENYANG = { country: "CN", city: "Shenyang", latitude: "41.79220", longitude: "123.43280" };

// The parts of the D1 API that the Worker uses.
class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return column ? row[column] : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }
  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }
}

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.sql).run(...s.args);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

let env;
beforeEach(() => {
  env = { DB: fakeD1(), ALLOWED_ORIGINS: `${SITE},https://www.hongshuchen.top`, IP_SALT: "test-salt" };
});

function request(path, { method = "GET", origin = SITE, ip = "203.0.113.7", ua = CHROME, cf = EDINBURGH, body } = {}) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (origin) headers.set("Origin", origin);
  if (ua) headers.set("User-Agent", ua);
  if (body !== undefined) headers.set("Content-Type", "text/plain;charset=UTF-8");
  const req = new Request(`https://stats.hongshuchen.top${path}`, { method, headers, body });
  Object.defineProperty(req, "cf", { value: cf });
  return req;
}

const visit = (options = {}) =>
  worker.fetch(request("/collect", { method: "POST", body: JSON.stringify({ referrer: "", touch: false }), ...options }), env);
const getStats = async (origin = SITE) => {
  const response = await worker.fetch(request("/stats", { origin }), env);
  return { response, data: await response.json() };
};
const rows = (sql) =>
  env.DB.raw
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

test("counts a visit and reports it by country and city", async () => {
  const response = await visit();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), SITE);

  const { response: statsResponse, data } = await getStats();
  assert.equal(statsResponse.status, 200);
  assert.equal(statsResponse.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.deepEqual(data, {
    total: 1,
    cities: 1,
    countries: [{ code: "GB", count: 1 }],
    points: [{ country: "GB", city: "Edinburgh", lat: 56, lon: -3.2, count: 1 }],
  });
});

test("does not count the same visitor again within 30 minutes", async () => {
  await visit();
  await visit();
  assert.equal((await getStats()).data.total, 1);
  // Another IP address in the same city is a new visitor.
  await visit({ ip: "198.51.100.20" });
  const { data } = await getStats();
  assert.equal(data.total, 2);
  assert.equal(data.points[0].count, 2);
});

test("stores no IP address", async () => {
  await visit({ ip: "203.0.113.99" });
  const dump = JSON.stringify([rows("SELECT * FROM recent"), rows("SELECT * FROM places"), rows("SELECT * FROM sources")]);
  assert.ok(!dump.includes("203.0.113.99"));
});

test("ignores other sites, bots and the wrong methods", async () => {
  assert.equal((await visit({ origin: "https://example.com" })).status, 403);
  assert.equal((await visit({ origin: null })).status, 403);
  assert.equal((await visit({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" })).status, 204);
  assert.equal((await visit({ ua: "curl/8.7.1" })).status, 204);
  assert.equal((await visit({ ua: null })).status, 204);
  assert.equal((await getStats()).data.total, 0);

  assert.equal((await worker.fetch(request("/collect"), env)).status, 405);
  assert.equal((await worker.fetch(request("/stats", { method: "POST", body: "{}" }), env)).status, 405);
  assert.equal((await worker.fetch(request("/"), env)).status, 404);
  const preflight = await worker.fetch(request("/collect", { method: "OPTIONS" }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), SITE);
});

test("statistics are not shared with other sites' pages", async () => {
  const { response } = await getStats("https://example.com");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("adds up countries and cities and leaves unknown places off the globe", async () => {
  await visit({ ip: "1.1.1.1" });
  await visit({ ip: "1.1.1.2", cf: SHENYANG });
  await visit({ ip: "1.1.1.3", cf: SHENYANG });
  await visit({ ip: "1.1.1.4", cf: { country: "CN", city: "Beijing", latitude: "39.9", longitude: "116.4" } });
  await visit({ ip: "1.1.1.5", cf: {} });
  await visit({ ip: "1.1.1.6", cf: { country: "T1" } });
  const { data } = await getStats();
  assert.equal(data.total, 6);
  assert.equal(data.cities, 3);
  assert.deepEqual(data.countries, [
    { code: "CN", count: 3 },
    { code: "GB", count: 1 },
  ]);
  assert.deepEqual(
    data.points.map((p) => [p.city, p.count]),
    [
      ["Shenyang", 2],
      ["Beijing", 1],
      ["Edinburgh", 1],
    ]
  );
});

test("counts the site owner's visits at OWNER_PLACE", async () => {
  const LONDON = { country: "GB", city: "London", latitude: "51.50850", longitude: "-0.12570" };
  const owner = (token) => JSON.stringify({ referrer: "", touch: false, owner: token });
  env.OWNER_TOKEN = "0123456789abcdef0123456789abcdef";
  env.OWNER_PLACE = { country: "GB", city: "Edinburgh", latitude: 55.9533, longitude: -3.1883 };
  await visit({ ip: "198.51.100.1", cf: LONDON, body: owner("0123456789abcdef0123456789abcdef") });
  await visit({ ip: "198.51.100.2", cf: LONDON, body: owner("0123456789abcdef0123456789abcdee") });
  await visit({ ip: "198.51.100.3", cf: LONDON, body: owner(["0123456789abcdef0123456789abcdef"]) });
  await visit({ ip: "198.51.100.4", cf: LONDON });
  // Without a configured token, nothing a page sends moves a visit.
  delete env.OWNER_TOKEN;
  await visit({ ip: "198.51.100.5", cf: LONDON, body: owner("") });
  const { data } = await getStats();
  assert.deepEqual(
    data.points.map((p) => [p.city, p.lat, p.lon, p.count]),
    [
      ["London", 51.5, -0.1, 4],
      ["Edinburgh", 56, -3.2, 1],
    ]
  );
});

test("records the day, the referring site and the device type", async () => {
  await visit({ body: JSON.stringify({ referrer: "www.Google.com", touch: false }) });
  await visit({ ip: "198.51.100.1", ua: IPHONE, body: JSON.stringify({ referrer: "<script>", touch: true }) });
  await visit({ ip: "198.51.100.2", body: JSON.stringify({ referrer: "github.com", touch: true }) });
  await visit({ ip: "198.51.100.3", body: "not json" });
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(rows("SELECT day, visits FROM daily"), [{ day: today, visits: 4 }]);
  const sources = Object.fromEntries(rows("SELECT kind || ':' || name AS k, visits FROM sources").map((r) => [r.k, r.visits]));
  assert.deepEqual(sources, {
    "referrer:google.com": 1,
    "referrer:direct": 2,
    "referrer:github.com": 1,
    "device:Desktop": 2,
    "device:Mobile": 1,
    "device:Tablet": 1,
  });
});
