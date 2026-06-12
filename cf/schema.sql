CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,            -- tiktok video id
  url TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|error
  error TEXT,
  signals TEXT,                   -- json: {caption, auto_captions, transcript, ocr_lines}
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id),
  name TEXT NOT NULL,
  name_japanese TEXT,
  city TEXT,
  category TEXT,
  evidence TEXT,
  evidence_quote TEXT,
  confidence TEXT,
  role TEXT DEFAULT 'destination',  -- destination|incidental (transit/navigation mentions)
  is_chain INTEGER DEFAULT 0,       -- chain/franchise: geocoded to nearby branches
  -- geocoding results
  place_id TEXT,
  resolved_name TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  geocode_status TEXT             -- ok|ambiguous|not_found|skipped
);

CREATE INDEX IF NOT EXISTS idx_places_video ON places(video_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
