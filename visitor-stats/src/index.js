// visitor-stats: counts visits to the homepage and serves the totals behind its "🌍 Visitor Map".
//   POST /collect  counts one visit; the page sends it at most once per browser session
//   GET  /stats    visits by country and city, for the globe
// Locating a visit: the page finds its public IPv4 address with api.ipify.org, looks up that address's city at ipwho.is and
// sends both along. IP databases know the cities of IPv4 addresses far better than those of IPv6 ones. The page does the
// lookup because ipwho.is's free tier allows 1,000 lookups a day per address: plenty for one browser, while requests from
// Workers all share Cloudflare's addresses and are refused. The page's city is used when it agrees with Cloudflare about
// the country and belongs to the address the request came from (a request over IPv6 cannot be compared); otherwise
// Cloudflare's own IP geolocation (request.cf) is used.
// Requests from cloud and hosting networks are not counted at all: they come from crawlers, link scanners and VPN servers,
// never from where a person is.
// IP addresses are never stored: a repeat visit within 30 minutes is recognised by a salted hash of IP address, browser and
// day (see the `recent` table in schema.sql).

const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 500;
const MAX_BODY_BYTES = 2048;
const BOT_PATTERN =
  /bot\b|bot\/|crawl|spider|slurp|archiver|preview|fetcher|headless|lighthouse|pagespeed|monitor|uptime|scanner|curl|wget|python|httpclient|okhttp|java\/|go-http|node-fetch|axios/i;

// Autonomous system numbers of cloud and hosting providers. Pages opened from these networks are opened by servers: crawlers
// that run scripts with an ordinary browser's User-Agent, the link checkers of mail and chat apps, uptime monitors and VPN
// servers. Networks that carry people's own traffic are deliberately absent, such as Cloudflare (WARP) and Akamai and Fastly
// (iCloud Private Relay).
const HOSTING_ASNS = new Set([
  // Amazon Web Services
  16509, 14618, 8987, 7224, 38895,
  // Google and Google Cloud
  15169, 396982, 19527, 43515, 139070, 139190,
  // Microsoft Azure
  8075, 8068, 8069, 12076,
  // Oracle Cloud, IBM Cloud
  31898, 36351,
  // Alibaba Cloud, Tencent (Tencent Cloud and WeChat's link checker), Huawei Cloud, Baidu
  45102, 37963, 134963, 132203, 45090, 136907, 55990, 38365, 55967,
  // DigitalOcean, Linode, Vultr, OVH, Hetzner, Contabo, Scaleway, Leaseweb, Hostinger, IONOS, netcup
  14061, 63949, 20473, 16276, 24940, 213230, 51167, 40021, 141995, 12876, 60781, 28753, 16265, 59253, 47583, 8560, 197540,
  // Other server and VPN hosts: M247, Datacamp (CDN77), G-Core, Zenlayer, Kamatera, Psychz, QuadraNet, ColoCrossing,
  // Hostwinds, IT7 (BandwagonHost), DMIT, Equinix Metal, Fly.io, Selectel, Yandex Cloud, Clouvider
  9009, 60068, 212238, 199524, 21859, 36007, 40676, 8100, 36352, 54290, 25820, 906, 54825, 40509, 49505, 200350, 62240,
  // Internet-wide scanners (Censys)
  398324, 398705, 398722,
]);

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
  const cf = request.cf || {};
  if (HOSTING_ASNS.has(Number(cf.asn))) {
    console.log(JSON.stringify({ skipped: "hosting network", asn: Number(cf.asn) }));
    return;
  }

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const visitor = await sha256(`${env.IP_SALT || ""}|${day}|${ip}|${userAgent}`);
  const seen = await env.DB.prepare("SELECT seen FROM recent WHERE visitor = ?1").bind(visitor).first("seen");
  if (seen !== null && seen !== undefined && now - seen < REPEAT_WINDOW_MS) return;

  const body = await readBody(request);
  const { country, city, lat, lon, source } = locate(ip, body, cf);
  const hasPoint = lat !== null && lon !== null;
  console.log(JSON.stringify({ located: source }));

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

// Where a visit came from: the city the page found with ipwho.is when that can be trusted, otherwise Cloudflare's.
function locate(ip, body, cf) {
  const cfCountry = /^[A-Z]{2}$/.test(cf.country || "") && cf.country !== "XX" && cf.country !== "T1" ? cf.country : "";
  // T1 is Tor, whose exit relays are nowhere near the visitor.
  const found = cf.country === "T1" ? null : pagePlace(body.place);
  // Over IPv4 the page must have looked up the very address the request came from: a VPN that only carried one of the two
  // requests would otherwise put the visit where the VPN is.
  const sameAddress = ip.includes(":") || body.ipv4 === ip;
  if (found && sameAddress && (!cfCountry || found.country === cfCountry)) return { ...found, source: "ipwho.is" };

  const lat = coordinate(cf.latitude, 90);
  const lon = coordinate(cf.longitude, 180);
  return {
    country: cfCountry || "XX",
    city: placeName(cf.city),
    lat: lon === null ? null : lat,
    lon: lat === null ? null : lon,
    source: "cloudflare",
  };
}

// The place the page sent ({ country, city, lat, lon, asn }, from ipwho.is), checked; null when unusable.
function pagePlace(value) {
  if (!value || typeof value !== "object") return null;
  // A VPN server's address, for instance, while the request to the Worker came another way.
  if (HOSTING_ASNS.has(Number(value.asn))) return null;
  const country = typeof value.country === "string" && /^[A-Z]{2}$/.test(value.country) && value.country !== "XX" ? value.country : "";
  const city = placeName(value.city);
  const lat = typeof value.lat === "number" ? coordinate(value.lat, 90) : null;
  const lon = typeof value.lon === "number" ? coordinate(value.lon, 180) : null;
  return country && city && lat !== null && lon !== null ? { country, city, lat, lon } : null;
}

// A city name as stored: without control characters and at most 100 characters long.
function placeName(value) {
  if (typeof value !== "string") return "";
  const printable = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return printable.trim().slice(0, 100);
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
