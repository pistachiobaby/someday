#!/usr/bin/env python3
"""Spike: extract location signals from downloaded TikTok videos.

Per video, gathers four signals and writes them to output/<id>.json plus a
human-reviewable report.md:
  1. caption + hashtags + music (from yt-dlp's .info.json)
  2. TikTok auto-captions (.vtt subtitles, when present)
  3. on-screen overlay text via ffmpeg scene-change frames + PaddleOCR (ja+en)
  4. (optional) structured place entities, if ANTHROPIC_API_KEY is set

Usage: python3 extract.py [--videos-dir videos] [--out-dir output] [--max-frames 16]
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

FRAME_SCENE_THRESHOLD = 0.3
MIN_FRAMES = 4  # below this, fall back to 1fps sampling
OCR_MIN_CONFIDENCE = 0.65


def extract_frames(video: Path, frames_dir: Path, max_frames: int) -> list[Path]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    scene = frames_dir / "scene_%03d.jpg"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
         "-vf", f"select='gt(scene,{FRAME_SCENE_THRESHOLD})',scale=-2:1080",
         "-vsync", "vfr", "-frames:v", str(max_frames), str(scene)],
        check=True,
    )
    frames = sorted(frames_dir.glob("scene_*.jpg"))
    if len(frames) < MIN_FRAMES:
        # montage-free video (few hard cuts) — sample at 1fps instead
        fps = frames_dir / "fps_%03d.jpg"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
             "-vf", "fps=1,scale=-2:1080", "-frames:v", str(max_frames), str(fps)],
            check=True,
        )
        frames = sorted(frames_dir.glob("*.jpg"))
    return frames[:max_frames]


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


def normalize(text: str) -> str:
    return re.sub(r"\W+", "", text.lower())


class Ocr:
    """Runs the Japanese and English PaddleOCR models over each frame and
    merges results: the japan model covers kana/kanji, the en model is more
    reliable on stylized Latin text."""

    def __init__(self):
        from paddleocr import PaddleOCR
        # enable_mkldnn=False: paddlepaddle's oneDNN path crashes with
        # "ConvertPirAttribute2RuntimeAttribute not support" on this CPU
        kw = dict(use_textline_orientation=True, enable_mkldnn=False)
        self.engines = {
            "japan": PaddleOCR(lang="japan", **kw),
            "en": PaddleOCR(lang="en", **kw),
        }

    def read_frame(self, frame: Path) -> list[tuple[str, float]]:
        out = []
        for engine in self.engines.values():
            for result in engine.predict(str(frame)) or []:
                texts = result.get("rec_texts", [])
                scores = result.get("rec_scores", [])
                out.extend(zip(texts, scores))
        return out


def ocr_video(ocr: Ocr, frames: list[Path]) -> list[dict]:
    """OCR every frame; dedupe lines across frames keeping the best-confidence
    read (overlay text persists across frames, so duplicates are the norm)."""
    best: dict[str, dict] = {}
    for frame in frames:
        for text, score in ocr.read_frame(frame):
            text = text.strip()
            if len(text) < 2 or score < OCR_MIN_CONFIDENCE:
                continue
            key = normalize(text)
            if not key:
                continue
            if key not in best or score > best[key]["confidence"]:
                best[key] = {"text": text, "confidence": round(float(score), 3),
                             "frame": frame.name}
    return sorted(best.values(), key=lambda r: -r["confidence"])


def load_metadata(info_json: Path) -> dict:
    info = json.loads(info_json.read_text(encoding="utf-8"))
    return {
        "url": info.get("webpage_url"),
        "uploader": info.get("uploader"),
        "caption": info.get("description", ""),
        "track": info.get("track"),
        "artists": info.get("artists"),
        "duration": info.get("duration"),
    }


def fuse_places(signals: dict) -> list[dict] | None:
    """Optional LLM fusion — only runs when ANTHROPIC_API_KEY is set."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    import anthropic

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=2048,
        output_config={"format": {"type": "json_schema", "schema": {
            "type": "object",
            "properties": {"places": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "name_japanese": {"type": ["string", "null"]},
                    "city": {"type": ["string", "null"]},
                    "category": {"type": "string"},
                    "evidence": {"type": "string"},
                    "evidence_quote": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["name", "name_japanese", "city", "category",
                             "evidence", "evidence_quote", "confidence"],
                "additionalProperties": False,
            }}},
            "required": ["places"],
            "additionalProperties": False,
        }}},
        messages=[{"role": "user", "content": (
            "Extract every specific, visitable place in Japan referenced by these "
            "signals from one TikTok travel video. OCR lines are noisy — reconstruct "
            "garbled names when context allows. Ignore generic mentions (e.g. "
            "'convenience stores'). Signals:\n" + json.dumps(signals, ensure_ascii=False)
        )}],
    )
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)["places"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--videos-dir", default="videos", type=Path)
    parser.add_argument("--out-dir", default="output", type=Path)
    parser.add_argument("--max-frames", default=16, type=int)
    args = parser.parse_args()

    videos = sorted(args.videos_dir.glob("*.mp4"))
    if not videos:
        print(f"no .mp4 files in {args.videos_dir}", file=sys.stderr)
        return 1
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print("loading OCR models…", flush=True)
    ocr = Ocr()

    report = ["# Spike: extraction signals per video\n"]
    for video in videos:
        vid = video.stem
        print(f"processing {vid}…", flush=True)
        result = {"id": vid}

        info_json = video.with_suffix(".info.json")
        if info_json.exists():
            result.update(load_metadata(info_json))

        vtts = list(args.videos_dir.glob(f"{vid}*.vtt"))
        result["auto_captions"] = parse_vtt(vtts[0]) if vtts else None

        frames = extract_frames(video, args.out_dir / "frames" / vid, args.max_frames)
        result["frames_sampled"] = len(frames)
        result["ocr_lines"] = ocr_video(ocr, frames)

        result["places"] = fuse_places({k: result[k] for k in
                                        ("caption", "auto_captions", "ocr_lines")})

        (args.out_dir / f"{vid}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        report.append(f"\n## {vid} — @{result.get('uploader')}\n")
        report.append(f"**URL:** {result.get('url')}\n")
        report.append(f"**Caption:** {result.get('caption', '')[:300]}\n")
        report.append(f"**Track:** {result.get('track')}\n")
        if result["auto_captions"]:
            report.append(f"**Auto-captions:** {result['auto_captions'][:400]}\n")
        report.append(f"**Frames:** {result['frames_sampled']} · "
                      f"**OCR lines:** {len(result['ocr_lines'])}\n")
        for line in result["ocr_lines"][:25]:
            report.append(f"- `{line['confidence']:.2f}` {line['text']}")
        if result["places"] is not None:
            report.append("\n**Extracted places:**")
            for p in result["places"]:
                report.append(f"- **{p['name']}** ({p['category']}, {p.get('city')}) "
                              f"[{p['confidence']}] — “{p['evidence_quote']}”")
        report.append("")

    (args.out_dir / "report.md").write_text("\n".join(report), encoding="utf-8")
    print(f"done → {args.out_dir}/report.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
