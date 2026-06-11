"""Container-side processor: yt-dlp download, ffmpeg frames/audio, PaddleOCR.

Endpoints (called by the Worker/Workflow over the container binding):
  GET  /healthz
  POST /list     {collection_url, proxy?}        -> [{id, url, title}]
  POST /process  {id, url, proxy?}               -> {meta, auto_captions, ocr_lines, has_audio}
  GET  /audio/<id>                               -> audio/mpeg (32kbps mono mp3)

Ported from spike/extract.py (see spike/sample-report.md for validation).
"""

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request, send_file

WORK = Path("/work")
WORK.mkdir(exist_ok=True)
FRAME_SCENE_THRESHOLD = 0.3
MIN_FRAMES = 4
MAX_FRAMES = 16
OCR_MIN_CONFIDENCE = 0.65

app = Flask(__name__)

# enable_mkldnn=False: paddle's oneDNN path crashes on some CPUs
# ("ConvertPirAttribute2RuntimeAttribute not support").
_engines = None


def engines():
    global _engines
    if _engines is None:
        from paddleocr import PaddleOCR
        kw = dict(use_textline_orientation=True, enable_mkldnn=False)
        _engines = [PaddleOCR(lang="japan", **kw), PaddleOCR(lang="en", **kw)]
    return _engines


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
         "-f", "best[height<=720]/best", "-o", str(job / "video.%(ext)s"), url],
        proxy=body.get("proxy"),
    )
    if res.returncode != 0:
        err = res.stderr[-2000:]
        gone = "404" in err or "private" in err.lower() or "unavailable" in err.lower()
        return err, 410 if gone else 502

    video = next(job.glob("video.mp4"), None) or next(job.glob("video.*"), None)
    info = json.loads((job / "video.info.json").read_text(encoding="utf-8"))
    meta = {
        "caption": info.get("description", ""),
        "uploader": info.get("uploader"),
        "track": info.get("track"),
        "duration": info.get("duration"),
    }

    vtt = next(job.glob("*.vtt"), None)
    auto_captions = parse_vtt(vtt) if vtt else None

    frames = extract_frames(video, job / "frames")
    ocr_lines = ocr_frames(frames)

    has_audio = extract_audio(video, job / "audio.mp3")

    # Keep only what later steps need; frames/video are large.
    shutil.rmtree(job / "frames", ignore_errors=True)
    video.unlink(missing_ok=True)

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


def extract_frames(video: Path, frames_dir: Path) -> list[Path]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
         "-vf", f"select='gt(scene,{FRAME_SCENE_THRESHOLD})',scale=-2:1080",
         "-vsync", "vfr", "-frames:v", str(MAX_FRAMES), str(frames_dir / "scene_%03d.jpg")],
        check=True,
    )
    frames = sorted(frames_dir.glob("scene_*.jpg"))
    if len(frames) < MIN_FRAMES:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
             "-vf", "fps=1,scale=-2:1080", "-frames:v", str(MAX_FRAMES),
             str(frames_dir / "fps_%03d.jpg")],
            check=True,
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
    best = {}
    for frame in frames:
        for engine in engines():
            for result in engine.predict(str(frame)) or []:
                for text, score in zip(result.get("rec_texts", []),
                                       result.get("rec_scores", [])):
                    text = text.strip()
                    if len(text) < 2 or score < OCR_MIN_CONFIDENCE:
                        continue
                    key = re.sub(r"\W+", "", text.lower())
                    if key and (key not in best or score > best[key]["confidence"]):
                        best[key] = {"text": text, "confidence": round(float(score), 3)}
    return sorted(best.values(), key=lambda r: -r["confidence"])


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
    serve(app, host="0.0.0.0", port=8080, threads=2, channel_timeout=600)
