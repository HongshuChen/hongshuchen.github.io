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

## Addresses

The page uses the Worker's custom domain `https://stats.hongshuchen.top` (the `routes` line in `wrangler.toml`, which needs
hongshuchen.top's DNS on Cloudflare). Unlike `*.workers.dev`, it can be reached from mainland China. It is
`visitor_map.api_url` in `_config.yml`. The Worker also stays on `https://visitor-stats.hongshuchen.workers.dev`, which is
`visitor_map.fallback_api_url`. The page tries that address when the custom domain cannot be reached, for instance while a
visitor's DNS still has the domain's old records.

## Your own visits

IP geolocation often puts a home connection in the wrong city, so the site owner's browsers can be marked and their
visits counted at `OWNER_PLACE` in `wrangler.toml` (Edinburgh) instead. The mark is the `OWNER_TOKEN` secret:

```sh
openssl rand -hex 16 | tee /dev/stderr | npx wrangler secret put OWNER_TOKEN   # prints the token once
```

Open `https://hongshuchen.top/#owner=<token>` once in each of your browsers. The page keeps the token in that browser,
removes it from the address bar and sends it with each visit; a visit with the wrong token or none is located as usual.
`https://hongshuchen.top/#owner=off` removes the mark. Setting a new token unmarks every browser.

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
