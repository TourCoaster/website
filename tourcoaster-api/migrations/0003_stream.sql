-- 0003_stream.sql — Cloudflare Stream live ingest support.
-- Adds:
--   * tours.replay_hls_url      — populated when a recording lands so the
--                                 tour page can offer on-demand replay.
--   * live_streams.last_status_at — timestamp of the most recent webhook
--                                   transition; lets clients tell stale rows
--                                   from fresh ones.
PRAGMA foreign_keys = ON;

ALTER TABLE tours ADD COLUMN replay_hls_url TEXT;
ALTER TABLE live_streams ADD COLUMN last_status_at TEXT;

-- At most one *active* live_streams row per tour. Without this a guide who
-- double-clicks "Generate stream credentials" can race two Cloudflare live
-- inputs into existence; the second INSERT now fails fast and the route
-- falls back to returning the existing row.
CREATE UNIQUE INDEX idx_live_streams_active_per_tour
  ON live_streams (tour_id)
  WHERE status IN ('idle','connecting','live');

INSERT INTO schema_version (version) VALUES (3);
