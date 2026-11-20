// visitor-stats: counts visits to the homepage and serves the totals behind its "🌍 Visitor Map".
//   POST /collect  counts one visit; the page sends it at most once per browser session
//   GET  /stats    visits by country and city, for the globe
// Visitors are located with Cloudflare's IP geolocation (request.cf). IP addresses are never stored: a repeat visit within
// 30 minutes is recognised by a salted hash of IP address, browser and day (see the `recent` table in schema.sql).
// The site owner's own browsers send the OWNER_TOKEN secret and are counted at OWNER_PLACE instead, because IP geolocation
// often puts a home connection in the wrong city (see README.md).

const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 500;
const MAX_BODY_BYTES = 2048;
const BOT_PATTERN =
  /bot\b|bot\/|crawl|spider|slurp|archiver|preview|fetcher|headless|lighthouse|pagespeed|monitor|uptime|scanner|curl|wget|python|httpclient|okhttp|java\/|go-http|node-fetch|axios/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env).includes(origin);
    const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };

    if (request.method === "OPTIONS") {
      const headers = { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" };
      return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Max-Age": "86400" } });
    }

    if (url.pathname === "/collect") {
      if (request.method !== "POST") return text("Method not allowed", 405, cors);
      if (!allowed) return text("Forbidden", 403, cors);
      try {
        await collect(request, env);
      } catch (error) {
        console.error("collect failed", error);
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/stats") {
      if (request.method !== "GET") return text("Method not allowed", 405, cors);
      try {
        const body = JSON.stringify(await stats(env));
        return new Response(body, {
          headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" },
        });
      } catch (error) {
        console.error("stats failed", error);
        return text("Statistics unavailable", 500, cors);
      }
    }

    return text("Not found", 404, cors);
  },
};

function text(body, status, headers) {
  return new Response(body, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function collect(request, env) {
  const userAgent = request.headers.get("User-Agent") || "";
  if (!userAgent || BOT_PATTERN.test(userAgent)) return;

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const visitor = await sha256(`${env.IP_SALT || ""}|${day}|${ip}|${userAgent}`);
  const seen = await env.DB.prepare("SELECT seen FROM recent WHERE visitor = ?1").bind(visitor).first("seen");
  if (seen !== null && seen !== undefined && now - seen < REPEAT_WINDOW_MS) return;

  const body = await readBody(request);
  const cf = (await ownerPlace(body, env)) || request.cf || {};
  const country = /^[A-Z]{2}$/.test(cf.country || "") && cf.country !== "XX" && cf.country !== "T1" ? cf.country : "XX";
  const city = typeof cf.city === "string" ? cf.city.trim().slice(0, 100) : "";
  const lat = coordinate(cf.latitude, 90);
  const lon = coordinate(cf.longitude, 180);
  const hasPoint = lat !== null && lon !== null;

  await env.DB.batch([
    env.DB.prepare("INSERT INTO recent (visitor, seen) VALUES (?1, ?2) ON CONFLICT (visitor) DO UPDATE SET seen = ?2").bind(visitor, now),
    env.DB.prepare(
      `INSERT INTO places (country, city, lat, lon, visits) VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT (country, city) DO UPDATE SET visits = visits + 1, lat = COALESCE(lat, ?3), lon = COALESCE(lon, ?4)`
    ).bind(country, city, hasPoint ? lat : null, hasPoint ? lon : null),
    env.DB.prepare("INSERT INTO daily (day, visits) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET visits = visits + 1").bind(day),
    env.DB.prepare(
      "INSERT INTO sources (kind, name, visits) VALUES ('referrer', ?1, 1) ON CONFLICT (kind, name) DO UPDATE SET visits = visits + 1"
    ).bind(referrerName(body.referrer)),
    env.DB.prepare(
      "INSERT INTO sources (kind, name, visits) VALUES ('device', ?1, 1) ON CONFLICT (kind, name) DO UPDATE SET visits = visits + 1"
    ).bind(deviceType(userAgent, body.touch === true)),
    env.DB.prepare("DELETE FROM recent WHERE seen < ?1").bind(now - DAY_MS),
  ]);
}

async function stats(env) {
  const { results } = await env.DB.prepare(
    "SELECT country, city, lat, lon, visits FROM places WHERE visits > 0 ORDER BY visits DESC, country, city"
  ).all();
  let total = 0;
  let cities = 0;
  const countries = new Map();
  const points = [];
  for (const row of results) {
    total += row.visits;
    if (row.country !== "XX") countries.set(row.country, (countries.get(row.country) || 0) + row.visits);
    if (row.city) cities += 1;
    if (row.country !== "XX" && row.lat !== null && row.lon !== null && points.length < MAX_POINTS) {
      points.push({ country: row.country, city: row.city, lat: row.lat, lon: row.lon, count: row.visits });
    }
  }
  return {
    total,
    cities,
    countries: [...countries].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    points,
  };
}

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return {};
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// OWNER_PLACE (in wrangler.toml, shaped like request.cf) when the visit comes with the OWNER_TOKEN secret. The token is
// compared by digest, so the time taken says nothing about how much of it matched.
async function ownerPlace(body, env) {
  const place = env.OWNER_PLACE;
  if (!env.OWNER_TOKEN || typeof body.owner !== "string" || !place || typeof place !== "object") return null;
  const [given, expected] = await Promise.all([sha256(body.owner), sha256(env.OWNER_TOKEN)]);
  return given === expected ? place : null;
}

// Rounded to 0.1 degree (about 10 km): enough to place a city on the globe.
function coordinate(value, limit) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) return null;
  return Math.round(number * 10) / 10;
}

function referrerName(value) {
  if (typeof value !== "string") return "direct";
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return /^[a-z0-9.-]{1,100}$/.test(host) && host.includes(".") ? host : "direct";
}

function deviceType(userAgent, touch) {
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(userAgent) || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent))) return "Tablet";
  // iPadOS Safari reports itself as a Mac; a touch screen gives it away.
  if (/Macintosh/i.test(userAgent) && touch) return "Tablet";
  if (/Mobi|iPhone|iPod|Windows Phone/i.test(userAgent)) return "Mobile";
  return "Desktop";
}

async function sha256(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
