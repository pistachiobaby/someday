# someday — TikTok bookmarks → Japan trip plan, on Cloudflare

Whole pipeline runs on Cloudflare: a **Worker** is the API, **Workflows** run
one durable, retryable pipeline per video, a **Container** (Docker: yt-dlp +
ffmpeg + PaddleOCR) does the heavy media work, **Workers AI** does Whisper
transcription + LLM place extraction, **D1** is the ledger, and the Worker
renders the outputs (KML map, trip doc) on demand.

```
POST /ingest ──► container /list (yt-dlp) ──► D1 videos ──► Workflow per video
                                                              │
  1. download+ocr   container: yt-dlp → ffmpeg frames → PaddleOCR (ja+en)
  2. transcribe     Workers AI whisper-large-v3-turbo (skipped when TikTok
                    auto-captions exist or the track is a commercial song)
  3. fuse           Workers AI llama-3.3-70b → structured place entities
  4. geocode        Google Places Text Search (New), Pro SKU (5k free/mo)
  5. save           D1 (videos.signals + places rows)

GET /outputs/map.kml   → import into Google My Maps + Organic Maps (offline)
GET /outputs/trip.md   → reviewable trip doc with evidence + source links
GET /outputs/places.json
GET /status            POST /retry
```

## Prerequisites

- **Workers Paid plan** ($5/mo) — required for Containers.
- A **Google Maps Platform** key with Places API (New) enabled.
- Docker running locally (wrangler builds the container image on deploy).

## Deploy

```bash
cd cf
npm install

# 1. D1 database — paste the returned id into wrangler.jsonc
npx wrangler d1 create someday
npm run db:init

# 2. Secrets
npx wrangler secret put API_TOKEN            # any random string; used as Bearer token
npx wrangler secret put GOOGLE_MAPS_API_KEY
# optional, see "TikTok vs datacenter IPs" below:
# npx wrangler secret put PROXY_URL          # e.g. http://user:pass@residential-proxy:8080

# 3. Deploy (builds + pushes the container image too)
npm run deploy
```

## Run

```bash
TOKEN=...; HOST=https://someday.<your-subdomain>.workers.dev

# kick off the whole collection
curl -X POST $HOST/ingest -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"collection_url": "https://www.tiktok.com/@you/collection/Japan-7111..."}'

curl -s $HOST/status -H "authorization: Bearer $TOKEN"        # watch progress
curl -X POST $HOST/retry -H "authorization: Bearer $TOKEN"    # respawn errored videos

# outputs
curl -s $HOST/outputs/map.kml  -H "authorization: Bearer $TOKEN" -o japan.kml
curl -s $HOST/outputs/trip.md  -H "authorization: Bearer $TOKEN" -o trip.md
```

Import `japan.kml` into [Google My Maps](https://mymaps.google.com) for
planning and into **Organic Maps** on your phone for offline use in Japan.

## Tests

The map UI (`src/mapClient.ts`) is decoupled from D1: it reads its places from
`window.__PLACES__` / `window.__BUCKETS__`, so the exact code the Worker ships
also runs in a Vite harness against fixtures — no database or network.

```bash
cd cf
npm install
npx playwright install chromium   # first time only
npm test                          # Vite serves test/harness.html, Playwright drives it
```

`test/map.spec.ts` covers pin rendering, category chips, search, and the
home-location + radius filter (including localStorage persistence).

## Cost (one full run, ~130 videos)

| Item | Cost |
|---|---|
| Workers Paid plan | $5/mo |
| Container compute (standard-2, ~1.5 min/video) | ~$0 — inside included 375 vCPU-min |
| Whisper (only videos without auto-captions) | pennies ($0.0005/min, free daily allowance) |
| Llama fusion calls | pennies |
| Google Places (~150–400 calls) | $0 (5k/mo free Pro tier) |

## Known constraints

- **TikTok vs datacenter IPs.** TikTok aggressively blocks cloud IP ranges.
  The container uses `--impersonate chrome`, but downloads from Cloudflare
  egress IPs may still be refused. If `/ingest` or processing fails with
  IP-block errors, set the `PROXY_URL` secret to a residential proxy and
  `/retry`. (Fallback we deliberately skipped for now: download locally and
  upload to R2.)
- **Container image is large** (~4 GB with PaddlePaddle + baked OCR models) —
  first deploy takes a while; fits standard-2's 12 GB disk.
- **Shard count** (`SHARDS` in `src/index.ts`) must match `max_instances` in
  `wrangler.jsonc`. 3 shards ≈ 130 videos / ~45 min wall clock.
- The fusion model is Workers AI llama-3.3-70b. Swapping in Claude
  (better on garbled Japanese OCR) is a ~10-line change in
  `workflow.ts` + an `ANTHROPIC_API_KEY` secret.
