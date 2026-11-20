# visitor-stats

A Cloudflare Worker that counts visits to the homepage and serves the numbers behind the "🌍 Visitor Map" above the footer
(`_includes/visitor_map.liquid`, `assets/js/visitor-map.js`). It runs on Cloudflare's free plan (Workers and D1).

- `POST /collect` counts one visit. The page sends it at most once per browser session, and a repeat from the same visitor
  within 30 minutes is ignored.
- `GET /stats` returns the visits by country and city that the globe shows.

Visitors are located with Cloudflare's IP geolocation. IP addresses are never stored (see `schema.sql`). Besides the
places, the Worker keeps visits per day, per referring site and per device type for a possible statistics page later.

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

## Custom domain

While hongshuchen.top's DNS is on Cloudflare, the Worker can answer at `stats.hongshuchen.top`, which (unlike `*.workers.dev`)
is reachable from mainland China. Add this to `wrangler.toml`, run `npx wrangler deploy`, and use the new address as
`visitor_map.api_url`:

```toml
routes = [{ pattern = "stats.hongshuchen.top", custom_domain = true }]
```

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
