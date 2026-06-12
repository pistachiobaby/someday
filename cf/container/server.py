"""Container-side processor: yt-dlp download, ffmpeg frames/audio, PaddleOCR.

Endpoints (called by the Worker/Workflow over the container binding):
  GET  /healthz
  POST /list     {collection_url, proxy?}        -> [{id, url, title}]
  POST /process  {id, url, proxy?}               -> {meta, auto_captions, ocr_lines, has_audio}
  GET  /audio/<id>                               -> audio/mpeg (32kbps mono mp3)

Ported from spike/extract.py (see spike/sample-report.md for validation).
"""

import json
import multiprocessing
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_file

WORK = Path("/work")
WORK.mkdir(exist_ok=True)
FRAME_SCENE_THRESHOLD = 0.3
MIN_FRAMES = 4
MAX_FRAMES = 16
OCR_MIN_CONFIDENCE = 0.65

app = Flask(__name__)


class OcrBusy(Exception):
    pass


@app.errorhandler(OcrBusy)
def ocr_busy(_e):
    return "ocr engine busy/stuck; retry later", 503

# One video's OCR at a time per instance (memory + CPU bound).
_ocr_lock = threading.Lock()
OCR_LOCK_WAIT = 600  # s a request waits for its OCR turn before 503ing
OCR_BUDGET = 900  # s of OCR per video before we kill it and degrade


def ytdlp(args, proxy=None):
    cmd = ["yt-dlp", "--impersonate", "chrome", "--no-check-certificates"]
    if proxy:
        cmd += ["--proxy", proxy]
    return subprocess.run(cmd + args, capture_output=True, text=True, timeout=300)


@app.get("/healthz")
def healthz():
    return "ok"


@app.post("/list")
def list_collection():
    body = request.get_json()
    res = ytdlp(
        ["--flat-playlist", "--print", "%(id)s\t%(webpage_url)s\t%(title)s",
         body["collection_url"]],
        proxy=body.get("proxy"),
    )
    if res.returncode != 0:
        return res.stderr[-2000:], 502
    videos = []
    for line in res.stdout.splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3:
            videos.append({"id": parts[0], "url": parts[1], "title": parts[2]})
    return jsonify(videos)


@app.post("/process")
def process():
    body = request.get_json()
    vid, url = body["id"], body["url"]
    job = WORK / vid
    shutil.rmtree(job, ignore_errors=True)
    job.mkdir(parents=True)

    res = ytdlp(
        ["--write-info-json", "--write-subs", "--sub-langs", "all",
         "--write-thumbnail",
         "-f", "best[height<=720]/best", "-o", str(job / "video.%(ext)s"), url],
        proxy=body.get("proxy"),
    )
    if res.returncode != 0:
        err = res.stderr[-2000:]
        gone = "404" in err or "private" in err.lower() or "unavailable" in err.lower()
        return err, 410 if gone else 502

    media = next(
        (p for p in job.glob("video.*")
         if p.suffix.lower() in {".mp4", ".webm", ".mov", ".mkv", ".mp3", ".m4a"}),
        None,
    )
    info = json.loads((job / "video.info.json").read_text(encoding="utf-8"))
    meta = {
        "caption": info.get("description", ""),
        "uploader": info.get("uploader"),
        "track": info.get("track"),
        "duration": info.get("duration"),
    }

    vtt = next(job.glob("*.vtt"), None)
    auto_captions = parse_vtt(vtt) if vtt else None

    if media is not None and has_video_stream(media):
        frames = extract_frames(media, job / "frames")
    else:
        # Photo posts: yt-dlp only exposes the audio track, so OCR what we
        # have — the cover thumbnail. (Slide images aren't downloadable.)
        frames = thumbnail_frames(job)
    ocr_lines = ocr_frames(frames)

    has_audio = media is not None and extract_audio(media, job / "audio.mp3")

    # Keep only what later steps need; frames/video are large.
    shutil.rmtree(job / "frames", ignore_errors=True)
    if media is not None:
        media.unlink(missing_ok=True)

    return jsonify({
        "meta": meta,
        "auto_captions": auto_captions,
        "ocr_lines": ocr_lines,
        "has_audio": has_audio,
    })


@app.get("/audio/<vid>")
def audio(vid):
    path = WORK / vid / "audio.mp3"
    if not path.exists():
        return "no audio", 404
    return send_file(path, mimetype="audio/mpeg")


def has_video_stream(path: Path) -> bool:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v",
         "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return "video" in res.stdout


def thumbnail_frames(job: Path) -> list[Path]:
    frames = []
    for p in job.glob("video.*"):
        suffix = p.suffix.lower()
        if suffix in {".jpg", ".jpeg", ".png"}:
            frames.append(p)
        elif suffix in {".webp", ".image"}:
            jpg = p.with_suffix(".thumb.jpg")
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-i", str(p), str(jpg)],
                capture_output=True,
            )
            if jpg.exists():
                frames.append(jpg)
    return frames


def extract_frames(video: Path, frames_dir: Path) -> list[Path]:
    # No check=True: ffmpeg 7 exits non-zero when a pass selects nothing
    # (e.g. a static video has no scene changes); fall through to the fps
    # pass, and degrade to zero frames rather than failing the video.
    frames_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
         "-vf", f"select='gt(scene,{FRAME_SCENE_THRESHOLD})',scale=-2:1080",
         "-vsync", "vfr", "-frames:v", str(MAX_FRAMES), str(frames_dir / "scene_%03d.jpg")],
        capture_output=True,
    )
    frames = sorted(frames_dir.glob("scene_*.jpg"))
    if len(frames) < MIN_FRAMES:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
             "-vf", "fps=1,scale=-2:1080", "-frames:v", str(MAX_FRAMES),
             str(frames_dir / "fps_%03d.jpg")],
            capture_output=True,
        )
        frames = sorted(frames_dir.glob("*.jpg"))
    return frames[:MAX_FRAMES]


def extract_audio(video: Path, out: Path) -> bool:
    # 16 kHz mono 32 kbps mp3 — small enough to ship to Workers AI whisper.
    res = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
         "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(out)],
        capture_output=True,
    )
    return res.returncode == 0 and out.exists() and out.stat().st_size > 1024


def ocr_frames(frames: list[Path]) -> list[dict]:
    # Paddle occasionally hangs forever in native code on some machines
    # (we wedged a whole shard on this). Run each video's OCR in a fresh
    # spawned subprocess with a hard budget: a hang gets killed and the
    # video completes with no OCR lines (caption/transcript still flow)
    # instead of timing out the workflow step forever.
    if not _ocr_lock.acquire(timeout=OCR_LOCK_WAIT):
        raise OcrBusy()
    try:
        ctx = multiprocessing.get_context("spawn")
        parent, child = ctx.Pipe(duplex=False)
        proc = ctx.Process(target=_ocr_worker, args=([str(f) for f in frames], child))
        proc.start()
        child.close()
        out = None
        deadline = time.time() + OCR_BUDGET
        while time.time() < deadline:
            if parent.poll(5):
                out = parent.recv()
                break
            if not proc.is_alive():  # crashed without sending a result
                break
        if proc.is_alive():
            proc.kill()
        proc.join()
        if out is None:
            app.logger.error("OCR subprocess hung or crashed; no OCR lines")
            return []
        return out
    finally:
        _ocr_lock.release()


def _ocr_worker(frame_paths: list[str], conn) -> None:
    from paddleocr import PaddleOCR
    # enable_mkldnn=False: paddle's oneDNN path crashes on some CPUs
    # ("ConvertPirAttribute2RuntimeAttribute not support").
    kw = dict(use_textline_orientation=True, enable_mkldnn=False)
    engines = [PaddleOCR(lang="japan", **kw), PaddleOCR(lang="en", **kw)]
    best = {}
    for fp in frame_paths:
        for engine in engines:
            for result in engine.predict(fp) or []:
                for text, score in zip(result.get("rec_texts", []),
                                       result.get("rec_scores", [])):
                    text = text.strip()
                    if len(text) < 2 or score < OCR_MIN_CONFIDENCE:
                        continue
                    key = re.sub(r"\W+", "", text.lower())
                    if key and (key not in best or score > best[key]["confidence"]):
                        best[key] = {"text": text, "confidence": round(float(score), 3)}
    conn.send(sorted(best.values(), key=lambda r: -r["confidence"]))
    conn.close()


def parse_vtt(vtt: Path) -> str:
    lines, seen = [], set()
    for line in vtt.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line == "WEBVTT" or "-->" in line or line.isdigit():
            continue
        if line not in seen:
            seen.add(line)
            lines.append(line)
    return " ".join(lines)


if __name__ == "__main__":
    from waitress import serve
    # Enough threads that /list and /healthz aren't starved by long-running
    # /process requests; OCR itself is serialized by _ocr_lock.
    serve(app, host="0.0.0.0", port=8080, threads=4, channel_timeout=600)
