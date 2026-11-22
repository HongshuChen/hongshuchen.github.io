# visitor-stats

A Cloudflare Worker that counts visits to the homepage and serves the numbers behind the "🌍 Visitor Map" above the footer
(`_includes/visitor_map.liquid`, `assets/js/visitor-map.js`). It runs on Cloudflare's free plan (Workers and D1).

- `POST /collect` counts one visit. The page sends it at most once per browser session, and a repeat from the same visitor
  within 30 minutes is ignored.
- `GET /stats` returns the visits by country and city that the globe shows.

Locating a visit: the page finds its public IPv4 address with `api.ipify.org` (which only answers over IPv4), looks up that
address's city at [ipwho.is](https://ipwho.is) and sends both with the visit. IP databases know the cities of IPv4
addresses far better than those of IPv6 ones, which matters for the many visitors (most in China) whose browsers reach the
Worker over IPv6. The lookup runs in the browser because ipwho.is's free tier (no key) allows 1,000 lookups a day per
address: plenty for one visitor, while requests from Workers all come from Cloudflare's shared addresses and are refused
with HTTP 429. The Worker uses the page's city when it agrees with Cloudflare about the country and belongs to the address
the request came from (requests over IPv6 cannot be compared); otherwise, and whenever a lookup fails or takes more than
1.8 seconds, it uses Cloudflare's own IP geolocation. IP geolocation stays approximate: home and mobile connections are
often placed in a capital or a large city (many in the UK in London), and a VPN shows up where its server is.

Visits from cloud and hosting networks (Amazon, Google Cloud, Azure, DigitalOcean and the others in `HOSTING_ASNS` in
`src/index.js`) are not counted: they come from crawlers that run scripts like a browser, link checkers of mail and chat
apps, and VPN servers.

IP addresses are never stored (see `schema.sql`). Besides the places, the Worker keeps visits per day, per referring site and
per device type for a possible statistics page later.

## First deployment

```sh
cd visitor-stats
npx wrangler login
npx wrangler d1 create visitor-stats   # put the printed database_id into wrangler.toml
npx wrangler d1 execute visitor-stats --remote --file schema.sql
openssl rand -hex 32 | npx wrangler secret put IP_SALT
npx wrangler deploy
```

Then set `visitor_map.api_url` in `_config.yml` to the Worker's address. The button only appears once it is set.

## Addresses

The page uses the Worker's custom domain `https://stats.hongshuchen.top` (the `routes` line in `wrangler.toml`, which needs
hongshuchen.top's DNS on Cloudflare). Unlike `*.workers.dev`, it can be reached from mainland China. It is
`visitor_map.api_url` in `_config.yml`. The Worker also stays on `https://visitor-stats.hongshuchen.workers.dev`, which is
`visitor_map.fallback_api_url`. The page tries that address when the custom domain cannot be reached, for instance while a
visitor's DNS still has the domain's old records.

## Tests

```sh
node --test visitor-stats/test/   # Node 22.5 or later; the built-in SQLite stands in for D1
```

`npx wrangler dev` runs the Worker locally (`npx wrangler d1 execute visitor-stats --local --file schema.sql` first). Away
from the live site the visitor map shows sample data and records nothing.

## Globe files

- `assets/visitor-map/globe.gl.min.js` is [globe.gl](https://github.com/vasturiano/globe.gl) 2.46.2 (MIT licence,
  `globe.gl-LICENSE.txt`), from `https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js`. It is only downloaded
  when the map is opened.
- `assets/visitor-map/land-dots-light.png` and `land-dots-dark.png` are made by `scripts/make_land_dots.py` from Natural Earth
  land outlines (public domain) in the [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 package:
  `python3 scripts/make_land_dots.py land-50m.json ../assets/visitor-map`.
