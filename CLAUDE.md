# someday — TikTok bookmarks → Japan trip planner

Personal project: take the owner's bookmarked TikToks about Japan, extract the
places they reference (OCR of on-screen text + transcripts + captions), geocode
them, and produce a map (KML for Google My Maps + Organic Maps offline) and a
trip-planning doc.

## Where the project is right now (2026-06-11)

**Done:**

- `research/tiktok-bookmarks-to-japan-trip.md` — full research report
  (verified): how to get bookmarks out of TikTok, extraction approach, costs.
  Read this first for any architectural question.
- `data/collection-list.txt` — the actual input: 131 video URLs + titles,
  fetched from the owner's public TikTok collection
  `https://vt.tiktok.com/ZS9jNhdA85hmE-DuQGT/` (yt-dlp `tiktok:collection`
  extractor, no login needed).
- `spike/` — validated local extraction spike. `spike/sample-report.md` shows
  real signal quality for 8 sample videos: TikTok auto-captions (.vtt) existed
  for all 8 (free transcripts), PaddleOCR (ja+en) catches overlay text and
  signage. Don't rerun this unless re-validating; it's superseded by `cf/`.
- `cf/` — the deployable all-Cloudflare pipeline (Worker + Workflows +
  Container + Workers AI + D1). Typechecked, **never yet deployed**.
  `cf/README.md` is the deploy + run guide.

**Not done yet (the actual next task):**

1. Deploy `cf/` per `cf/README.md`: `wrangler d1 create someday` → paste id
   into `wrangler.jsonc` → `npm run db:init` → set secrets (`API_TOKEN` =
   generate a random string and tell the owner; `GOOGLE_MAPS_API_KEY` from env)
   → `npm run deploy` (builds a ~4 GB Docker image — slow first time; the
   sandbox's Docker daemon may need starting: `dockerd &`).
2. Smoke-test `/ingest` with ONE video first (or the collection URL above),
   check `/status`, then let all 131 run (~45 min, 3 container shards).
3. Review outputs (`/outputs/trip.md`, `/outputs/map.kml`), especially places
   flagged `ambiguous`/`not_found`, then hand the KML + doc to the owner.
4. Likely follow-ups: itinerary day-clustering (research doc §5.2), a vision
   fallback pass for videos where OCR found no text.

**Environment expectations:** the owner adds `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `GOOGLE_MAPS_API_KEY` (and optionally `PROXY_URL`,
`ANTHROPIC_API_KEY`) as session env vars. Wrangler reads the Cloudflare ones
automatically.

## Hard-won gotchas (do not rediscover these)

- **TikTok blocks datacenter IPs.** Downloads from Cloudflare egress may fail
  even with `--impersonate chrome` (already wired in). Escape hatch: set the
  `PROXY_URL` Worker secret (residential proxy) and `POST /retry`. This is the
  pipeline's most likely failure point — check it before debugging anything
  else when `/process` 502s.
- **TikTok throttles repeat hits on share links** (503s). yt-dlp calls already
  sleep between requests; just retry after a pause.
- **PaddleOCR crashes with oneDNN** on some CPUs
  ("ConvertPirAttribute2RuntimeAttribute not support") — `enable_mkldnn=False`
  is required everywhere PaddleOCR is constructed (already done in
  `cf/container/server.py` and `spike/extract.py`).
- **`SHARDS` in `cf/src/index.ts` must equal `max_instances`** in
  `cf/wrangler.jsonc` (currently 3) — workflow steps route audio fetches to
  the same shard that processed the video, so the mapping matters.
- **Skip Whisper when a `.vtt` exists** (already implemented) — TikTok
  auto-captions covered 8/8 spike samples.
- In this sandbox, pip installs need a venv (system PyYAML conflict) and
  TLS to TikTok needs `--no-check-certificates` (egress proxy MITM).
- Git pushes 403 right after a GitHub-app permission change — the session
  proxy refreshes its token after a few minutes; retry rather than rework.

## Decisions already made (don't relitigate without the owner)

- Whole pipeline on Cloudflare (owner's call; Workers Paid plan accepted).
- OCR-first extraction (PaddleOCR in the container), NOT vision-LLM frames —
  cost reasons. Fusion is Workers AI llama-3.3-70b; swapping to Claude is a
  sanctioned option if `ANTHROPIC_API_KEY` is provided.
- Acquisition via public-collection workaround, not the official data export
  (too slow) and not browser extensions.
- Outputs: KML (My Maps + Organic Maps) + markdown trip doc; native Google
  Maps saved lists have no API.
