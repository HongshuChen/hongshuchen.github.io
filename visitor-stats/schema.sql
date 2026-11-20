-- Tables of the visitor-stats Worker (Cloudflare D1). Apply with:
--   npx wrangler d1 execute visitor-stats --remote --file schema.sql

-- Visits per place; the globe draws one point per row that has coordinates.
CREATE TABLE IF NOT EXISTS places (
  country TEXT NOT NULL, -- ISO 3166-1 alpha-2 code, XX when unknown
  city TEXT NOT NULL DEFAULT '', -- empty when Cloudflare could not tell the city
  lat REAL,
  lon REAL,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (country, city)
);

-- Visits per UTC day (kept for a statistics page; the globe does not use it).
CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY, -- YYYY-MM-DD
  visits INTEGER NOT NULL DEFAULT 0
);

-- Visits per referring site ('referrer') and per device type ('device'), also kept for a statistics page.
CREATE TABLE IF NOT EXISTS sources (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, name)
);

-- Recently counted visitors, so a repeat visit within 30 minutes is not counted again. A visitor is a salted hash of
-- the IP address, browser and day; IP addresses are never stored. Rows older than a day are deleted.
CREATE TABLE IF NOT EXISTS recent (
  visitor TEXT PRIMARY KEY,
  seen INTEGER NOT NULL -- Unix time in milliseconds
);

CREATE INDEX IF NOT EXISTS recent_seen ON recent (seen);
