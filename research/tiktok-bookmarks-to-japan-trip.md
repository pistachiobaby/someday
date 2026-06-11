# Research: Turning TikTok Bookmarks into a Japan Trip Plan

**Goal.** You have a TikTok account with a large set of bookmarked (favorited) videos collected for an upcoming Japan trip. We want to fetch those bookmarks, process each video visually and through its audio to extract *location context* (restaurants, shrines, neighborhoods, shops, viewpoints), and turn the result into things that actually help plan the trip: a map, an itinerary draft, and a readable planning doc.

**Scope assumptions** (from our kickoff Q&A): 50–300 bookmarked videos, one personal account, deliverables are a **Google My Maps / KML map**, an **itinerary draft**, and a **Markdown planning doc**.

---

## TL;DR

1. **There is no official TikTok API an individual can use to read their bookmarks.** The Display API has no favorites endpoint at all; the Research API is academic-only (and also lacks favorites); the only API that includes favorites — the EU DMA "Data Portability API" — is restricted to EEA/UK user accounts and gated behind a product-grade privacy review. *(Detail in §1.)*
2. **The practical, phone-native path is the collections workaround**: in the TikTok app, bulk-select your favorites into 1–3 collections ("Manage videos" supports multi-select), toggle them shareable/public, copy the links — then `yt-dlp` reads the whole list from each public collection URL with no login, no extension, no waiting. Works identically from iOS and Android, ~20–40 min for 300 bookmarks.
3. **`yt-dlp` then downloads every video + rich metadata** (caption, hashtags, creator, music info, auto-captions) from that URL list — no login or scraping of your account needed, low risk at this scale.
4. **Location extraction is a multi-signal problem**: on-screen overlay text (the highest-value signal — ffmpeg frame sampling + **local PaddleOCR**, free), caption + hashtags (cheap prior), and speech (transcribe only videos with original audio; ~$2 total or free locally). A tiny text-only LLM pass (<$1) fuses the signals into structured place entities.
5. **Geocode with Google Places Text Search (New)** — free at this scale, and the only geocoder that reliably resolves both "Ichiran Shibuya" and "チームラボプラネッツ". Output one KML → import to **Google My Maps** (planning) and **Organic Maps** (offline on-phone in Japan), plus an LLM-clustered day-by-day itinerary in Markdown.
6. **Total cost: roughly $1–3 in API calls for 300 videos** (OCR and frame extraction run locally for free); the pipeline is a few hundred lines of Python. Consumer apps (Triply, TripTok, TokSpot) do a shallow version of this, but nothing open-source does it end-to-end — building it is justified.

---

## 1. Getting the bookmarks out of TikTok

### 1.1 Official APIs — the direct answer to "doesn't TikTok have an API for this?"

| API | Has favorites? | Can you use it? | Verdict |
|---|---|---|---|
| **Display API** | ❌ No — endpoints are user info, your *own posted* videos, and posting. No favorites/bookmarks/liked scope exists. | Anyone can make a sandbox app; going live requires app review of a real product. | Dead end regardless of approval. |
| **Research API** | ❌ No favorites endpoint (has *liked* videos, only if public). | Academic/non-profit researchers in US/EEA/UK/CH only, with a research proposal. | Not available to individuals. |
| **Data Portability API** (EU DMA, launched 2024) | ✅ Yes — "Likes and Favourites" category in the full-archive scope. | Developers can apply globally, but the API **only returns data for EEA/UK users**, and approval requires a defined product use case, UX mockups, and a privacy & security review (~3–4 weeks). | The only official API with favorites, but effectively out of reach for a personal one-off tool (and useless for a non-EEA/UK account). |

Sources: [developers.tiktok.com Display API overview](https://developers.tiktok.com/doc/display-api-overview), [API scopes](https://developers.tiktok.com/doc/tiktok-api-scopes), [Research API](https://developers.tiktok.com/products/research-api/), [Data Portability API data types](https://developers.tiktok.com/doc/data-portability-data-types), [Data Portability product page](https://developers.tiktok.com/products/data-portability-api/).

**Bottom line: effectively no.** TikTok deliberately exposes bookmarks only through GDPR/DMA-style data export channels, not developer APIs.

### 1.2 The collections workaround — recommended (phone-native, no wait, no extension)

The TikTok app itself provides everything needed, on both iOS and Android:

1. **In the app:** Profile → Favorites (bookmark tab) → Collections → create a collection (1–3 are enough, e.g. by city). Use **"Manage videos"** to **bulk-select** favorites (tap-select many at once, then Move/Add) — not one-by-one. ~20–40 min for 300 bookmarks.
2. **Make each collection shareable/public** and copy its link ("Share this collection"). Public collections get a web URL of the form `https://www.tiktok.com/@<user>/collection/<title>-<id>`.
3. **On any machine** (laptop, or even Termux/iSH on the phone): yt-dlp's `tiktok:collection` extractor (verified in source, added May 2024) reads the entire collection **without any login or cookies**:
   ```bash
   yt-dlp --flat-playlist --print webpage_url "https://www.tiktok.com/@you/collection/Japan-7111..."
   ```
   …or skip the URL-listing step and feed the collection URL straight into the download command in §2.
4. Flip the collections back to private afterward.

**Trade-off:** your favorites are briefly publicly visible (to anyone with the link / profile visitors) while the collections are public. Minutes of exposure for a trip-planning list is a non-issue for most people, but worth knowing.

Sources: [yt-dlp tiktok.py — TikTokCollectionIE](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py) ([commit](https://github.com/yt-dlp/yt-dlp/commit/119d41f27061d220d276a2d38cfc8d873437452a)), [Minter.io collections guide](https://minter.io/blog/how-to-create-edit-and-delete-tiktok-collections/), [ScreenRant on bulk-organizing favorites](https://screenrant.com/organize-tiktok-favorites-collections-how/).

> **Action item #1:** in the TikTok app, bulk-move your Japan bookmarks into collections and copy the share links. That's the only manual step in the whole pipeline.

### 1.3 Other extraction options, ranked

- **Android phone-only: Firefox for Android + tiktok-to-ytdlp add-on.** Firefox Android has supported open extensions since Dec 2023, and [tiktok-to-ytdlp has a dedicated Android listing](https://addons.mozilla.org/en-US/android/addon/tiktok-to-ytdlp/) (v1.4.1, updated Jan 2026). Log into tiktok.com (request desktop site), open the Favorites page, let it auto-scroll and export a `.txt` of URLs. Caveat: TikTok's logged-in web favorites view is desktop-oriented — mobile browsers usually need desktop-mode, which makes this fragile.
- **iOS phone-only: weak.** Orion Browser can install Firefox/Chrome extensions but support is explicitly experimental — the add-on may not work. No Safari extension exists for this. iOS Shortcuts are one-video-at-a-time only (no bulk favorites access). On iOS, use the collections workaround.
- **"Download Your Data" export** (Settings → Account → Download your data → JSON): the zero-scraping fallback. Favorites land at `["Likes and Favorites"]["Favorite Videos"]["FavoriteVideoList"]` as date+link pairs — but it takes minutes to days to arrive and the link expires 4 days after it's ready. Use only if the collections route is unappealing.
- **yt-dlp native favorites support is coming but not merged**: [PR #16303](https://github.com/yt-dlp/yt-dlp/pull/16303) adds `TikTokSavedIE` (`tiktok.com/saved` with cookies); still open as of mid-2026. If it merges, favorites become a one-liner with browser cookies.
- **Not recommended:** TikTokApi (no authenticated routes — can't see private favorites), Dewey (desktop-Chrome-only sync), 4K Tokkit and similar apps that want your TikTok login (credential/ToS exposure), Apify/tikwm (unnecessary at this scale). Kiwi Browser is discontinued.

### 1.4 Terms-of-service & risk

TikTok's ToS prohibits automated scraping, and all unofficial tools technically violate it. Realistically, for 50–300 of your own bookmarks: enforcement reports concern high-volume scraping; the practical failure modes are captchas, temporary blocks, and tool breakage — not account bans (no documented bans for low-volume personal downloading were found, though that's absence-of-evidence). Mitigations: the collections route needs no login at all for the fetch (public collection, anonymous yt-dlp), throttle downloads, run from a residential IP, don't hand session cookies to third-party services.

---

## 2. Downloading the videos + metadata

**Tool: `yt-dlp`** (install with `pip install "yt-dlp[default,curl-cffi]"` — the `curl_cffi` TLS impersonation extra is effectively required for reliable TikTok; keep yt-dlp updated since TikTok broke extraction twice in late 2025 before [PR #15672](https://github.com/yt-dlp/yt-dlp/pull/15672) fixed it in Jan 2026).

```bash
yt-dlp "https://www.tiktok.com/@you/collection/Japan-7111..." \
  --write-info-json --write-subs \
  --download-archive done.txt \
  --sleep-requests 1 --min-sleep-interval 1 --max-sleep-interval 3 \
  --restrict-filenames --trim-filenames 160 \
  -o "videos/%(uploader)s_%(id)s.%(ext)s"
```

- Pass each public collection URL directly (the `tiktok:collection` extractor paginates the whole collection, no cookies needed). If you instead have a flat URL list (extension or data-export route), use `-a favorites.txt` — short share links work, yt-dlp follows redirects.
- `--write-info-json` gives per-video: **full caption incl. hashtags** (`description`), uploader, timestamps, view/like counts, and **music metadata** — including whether the track is `original sound - <creator>` vs a matched commercial song (the key signal for "is there narration worth transcribing").
- `--write-subs` grabs TikTok's **auto-generated speech captions** when present (`creator_caption` / auto captions) — free transcription for some videos.
- `--download-archive` makes the run resumable; a handful of 404s (deleted videos) is expected.

**Known gap:** yt-dlp does **not** extract on-screen text-sticker metadata (`stickersOnItem[].stickerText`). For videos where the creator used TikTok's native text tool, that field exists in TikTok's raw web JSON (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) and can be grabbed with a small supplementary fetch (e.g. via [pyktok](https://github.com/dfreelon/pyktok)) — but most polished travel TikToks burn text in via CapCut, where no metadata exists and frame analysis is required anyway. Treat sticker metadata as a free fast path, not a dependency.

---

## 3. Extracting location context

Three signal sources, in descending order of value for Japan travel TikToks:

### 3.1 On-screen overlay text (OCR-first — the main event)

Travel TikToks ("7 hidden gems in Kyoto") typically name the individual places **only in burned-in overlay text and/or voiceover** — the caption usually names just the city. So frame analysis carries most of the weight.

**Approach: local OCR on sampled frames — free.**

- **Frame sampling:** scene-change detection beats fixed-rate for cut-heavy TikToks: `ffmpeg -i v.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr frames/%03d.jpg`, fall back to 1 fps. 8–20 frames per video is plenty.
- **OCR engine: PaddleOCR** with the Japanese + English models — clearly the best open-source choice for stylized CJK scene text (~92% word accuracy vs ~76% for Tesseract, which is tuned for clean document scans, not video overlays). Runs on CPU, no API cost. Per frame it returns text lines + confidence; dedupe repeated lines across a video's frames (overlay text persists across many frames, which actually helps — take the highest-confidence read of each line).
- **What OCR-only gives up vs a vision LLM:** (a) no landmark recognition for videos with *zero* text (montage-only clips) — mitigation: flag "no text found" videos for a quick manual skim, or optionally run a vision pass on just that small subset; (b) heavily stylized/animated fonts will sometimes garble — the geocoding step's fuzzy matching (Places Text Search interprets queries, it doesn't string-match) absorbs a lot of this, and the confidence field flags the rest. For a personal trip-planning run these are acceptable trade-offs for ~$15 saved.

### 3.2 Caption, hashtags, and platform metadata (cheap priors)

Always feed the model: `description` (caption + hashtags), uploader handle, music title, `locationCreated`/POI tag when present in the raw web JSON, and sticker text when available. These usually pin down the *city*, which is exactly the context needed to disambiguate the place names found in frames/audio.

### 3.3 Audio (selective transcription)

- **Prioritize by sound type:** the info.json music metadata distinguishes `original sound - <user>` (likely narration → transcribe) from matched commercial tracks (likely trending-sound-only → skip or deprioritize).
- **VAD gate:** run Silero VAD first and skip files with <2 s of detected speech. This matters: Whisper hallucinates text on music-only audio in ~40% of cases (a known failure mode — fabricated "ご視聴ありがとうございました" on Japanese content; [study](https://arxiv.org/abs/2501.11378)). VAD pre-filtering is the single best mitigation.
- **Transcription:** cloud is trivially cheap — OpenAI `gpt-4o-transcribe` at $0.006/min ≈ **$1.80 for 300 videos (~5 h audio)**, robust on noisy/musical audio with mixed EN/JA. Free local alternative: `faster-whisper large-v3-turbo` with `vad_filter=True, language=None, no_speech_threshold≈0.4` (~20–30 min on a consumer GPU, hours on CPU).
- Don't forget `--write-subs`: TikTok's own auto-captions cover some videos for free.

### 3.4 Fusing signals into structured place entities

With OCR doing the visual heavy lifting, the fusion step is **text-only and nearly free**: one small-model call per video (e.g. Haiku via the Batches API — ~1–2K input tokens each, ≈ **$0.30–0.60 total for 300 videos**) takes OCR lines + caption + hashtags + sticker metadata + transcript and emits structured place entities (`output_config.format` json_schema, or `client.messages.parse()` with a Pydantic model). A pure-regex/heuristic version is possible but not worth it — the LLM pass is what turns "📍渋谷 nonbei yokocho" + a garbled OCR line into a clean queryable entity, and at under a dollar it's the cheapest component in the pipeline:

```json
{
  "video_summary": "string",
  "places": [{
    "name": "string",
    "name_japanese": "string|null",
    "city": "string",
    "area_hint": "string|null",
    "category": "restaurant|cafe|bar|shrine|temple|museum|viewpoint|shop|activity|hotel|other",
    "evidence": "overlay_text|caption|speech|visual_landmark",
    "evidence_quote": "string",
    "confidence": "high|medium|low",
    "notes": "string"
  }]
}
```

Structured outputs guarantee schema-valid JSON, so the geocoding stage can consume it directly.

---

## 4. Geocoding and validation

**Primary: Google Places API — Text Search (New).**

- Post-March-2025 pricing: per-SKU free monthly caps — **Text Search Pro (includes coordinates) has 5,000 free calls/month**, far above our needs. Use a tight FieldMask (`places.id,places.displayName,places.formattedAddress,places.location`) to stay in the Pro SKU. Effective cost at our scale: **$0**.
- It is the only geocoder that reliably resolves *both* romanized and Japanese-script POI names, including small restaurants (Google's Japan restaurant coverage is exceptional; OSM/Nominatim is fine for shrines and landmarks but unreliable for restaurants, and its public API is capped at 1 req/s anyway).
- **Query construction:** `"<extracted name> <area/city hint>"` + `locationBias` circle on the target city + `languageCode=en` (returns romanized names for the map).
- **Chain disambiguation** (Ichiran has dozens of branches): explicit area in the query overrides bias; post-validate by comparing the returned address's ward/city against the video's context; for genuinely ambiguous chains, emit the top 2–3 candidates and flag for human pick. Flag any result far from the bias center.

---

## 5. Outputs

1. **KML via `simplekml`** — one file, folders by city/day, pin description = category + notes + evidence quote + **bare TikTok URL** (My Maps strips HTML but auto-links bare URLs).
   - **Google My Maps** import: KML ≤5 MB, max 10 layers/map, 2,000 features/layer — no constraint at our scale. Caveat: My Maps is desktop-web for editing; on-phone it's view-only inside the Google Maps app.
   - **Organic Maps** (or CoMaps): import the *same* KML on-device for fully **offline** maps in Japan. Strongly recommended as the on-trip companion.
   - There is **no API for native Google Maps saved lists** (confirmed open feature request) — if those are wanted, the pipeline can emit a checklist of `https://www.google.com/maps/place/?q=place_id:<id>` links for one-tap manual saving.
2. **Itinerary draft (Markdown)** — split pins by city, then ward/neighborhood grouping (the ward is right in Google's `formattedAddress`) or k-means with k = days in that city, then one LLM pass to order each day sensibly (food near sights, timed-ticket venues like teamLab flagged, opening-hours notes). LLM-based grouping is the pragmatic choice for a one-off — it handles soft constraints geometry can't.
3. **Planning doc (Markdown)** — one section per city/area: each place with category, why it was bookmarked (evidence quote), source TikTok link, and map link. This doubles as the human-review surface for low-confidence extractions.

---

## 6. Recommended architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ 0. ACQUIRE   TikTok app: bulk-move favorites → public collections   │
│              → collection URLs (fallbacks: Firefox-Android extension,│
│              "Download Your Data" export)                            │
├─────────────────────────────────────────────────────────────────────┤
│ 1. DOWNLOAD  yt-dlp <collection-url> --write-info-json --write-subs │
│              → videos/*.mp4 + *.info.json (+ auto-captions)         │
│              (optional: pyktok pass for stickerText / locationCreated)│
├─────────────────────────────────────────────────────────────────────┤
│ 2. AUDIO     music-metadata triage → Silero VAD gate →              │
│              gpt-4o-transcribe (or faster-whisper) → transcript     │
├─────────────────────────────────────────────────────────────────────┤
│ 3. FRAMES    ffmpeg scene-change sampling → 8–20 jpgs/video         │
│              → PaddleOCR (ja+en, local, free) → deduped text lines  │
├─────────────────────────────────────────────────────────────────────┤
│ 4. EXTRACT   1 small text-only LLM call/video (Batches API,         │
│              structured outputs): OCR lines + caption + hashtags    │
│              + transcript → places[]                                │
├─────────────────────────────────────────────────────────────────────┤
│ 5. GEOCODE   Google Places Text Search (New) + validation/flagging  │
├─────────────────────────────────────────────────────────────────────┤
│ 6. OUTPUT    places.json → KML (simplekml) → My Maps + Organic Maps │
│              → LLM day-clustering → itinerary.md + trip-plan.md     │
└─────────────────────────────────────────────────────────────────────┘
```

Each stage writes to disk and is independently re-runnable (re-run extraction without re-downloading; re-geocode without re-extracting). A `places.json` ledger with per-place confidence + evidence is the single source of truth feeding all three outputs.

### Cost & effort for ~300 videos

| Item | Estimate |
|---|---|
| Bookmark list + yt-dlp download | $0 |
| Frame extraction + PaddleOCR (local) | **$0** (CPU-only is fine; ~1–3 s/frame, a batch run finishes in an hour or two) |
| Transcription (~5 h audio after VAD skips) | **~$1–2** cloud (`gpt-4o-transcribe`), or **$0** local (faster-whisper) |
| Entity-fusion LLM calls (300 × ~1–2K text tokens, Haiku batched) | **~$0.30–0.60** |
| Geocoding (≈300–600 Text Search calls) | **$0** (within 5K/month free Pro tier) |
| KML/itinerary generation | ~$0.10–0.50 of LLM calls |
| **Total** | **≈ $1–3** (or ~$0.50 fully-local transcription) |

*(Dropped alternative for reference: a vision-LLM pass instead of OCR — frames as images to Haiku/Sonnet — would run ~$2–11 batched and add landmark recognition for text-free videos. Worth keeping in the back pocket as a targeted second pass over only the videos where OCR finds nothing.)*

Engineering effort: a few hundred lines of Python (`yt-dlp` + `ffmpeg` + `paddleocr` + `anthropic` + `requests` + `simplekml`), realistically 1–2 focused sessions to a working end-to-end run, plus a human-review pass over flagged/low-confidence places.

---

## 7. Prior art

Consumer apps already solve a shallow version of this — worth knowing as a sanity check or fallback: **Triply** (iOS; extracts places from TikTok audio/captions/on-screen text into maps), **TripTok**, **TokSpot**, **GoPlaces**, plus a Chrome extension for mapping saved TikToks. None offer the full control we want (custom KML, offline maps, itinerary clustering, evidence-linked planning doc), and **no maintained open-source project does this end-to-end** — the building blocks (yt-dlp, pyktok, Whisper, Places API) all exist separately. If the DIY pipeline feels heavy, trying Triply on a handful of bookmarks first is a reasonable benchmark.

---

## 8. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Favorites briefly public during collections workaround | Make collections public only for the minutes the fetch runs, then flip back to private |
| yt-dlp TikTok breakage (recurring) | Pin a known-good nightly; `--download-archive` makes retries cheap; tikwm as per-URL fallback |
| Deleted/private videos | Expect a few 404s; log and report them in the planning doc |
| Whisper hallucination on music | Silero VAD gate + `no_speech_threshold` + music-metadata triage |
| Wrong chain branch geocoded | Area-qualified queries, locationBias, ward validation, human-review flags |
| LLM hallucinating place names | Require `evidence_quote` per place; Places-API match as ground truth; confidence field + review pass over `low` |
| ToS exposure | Use official export for enumeration; anonymous throttled downloads; no third-party cookie sharing |

---

## 9. Proposed build plan (next session)

1. **You (in the TikTok app, ~30 min):** bulk-move your Japan bookmarks into 1–3 collections via "Manage videos", make them shareable, and copy the collection links.
2. **Repo scaffold:** Python project with stages as CLI subcommands (`ingest`, `download`, `transcribe`, `frames`, `extract`, `geocode`, `render`), a `places.json` ledger, and config for API keys (Anthropic, OpenAI optional, Google Maps Platform).
3. **First slice:** run the full pipeline end-to-end on 5–10 sample TikTok URLs (no export needed — any Japan travel TikToks work) to validate extraction quality before the batch run.
4. **Batch run** once the export arrives → review flagged places → generate KML + itinerary + trip doc.

---

*Research compiled 2026-06-10 from five parallel web-research passes (official TikTok APIs, unofficial tooling, visual analysis, audio transcription, geocoding/output) with a verification pass over load-bearing claims. Source links inline.*
