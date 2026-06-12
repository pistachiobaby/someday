import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { getContainer } from "@cloudflare/containers";
import { Env, shardFor } from "./index";
import { geocodePlace } from "./geocode";

type Params = { videoId: string; url: string };

type ProcessResult = {
  meta: { caption: string; uploader: string; track: string; duration: number };
  auto_captions: string | null;
  ocr_lines: { text: string; confidence: number }[];
  has_audio: boolean;
};

export type Place = {
  name: string;
  name_japanese: string | null;
  city: string | null;
  category: string;
  evidence: string;
  evidence_quote: string;
  confidence: "high" | "medium" | "low";
};

const PLACES_SCHEMA = {
  type: "object",
  properties: {
    places: {
      type: "array",
      items: {
        type: "object",
        properties: {
          // Workers AI JSON mode rejects union types (AiError 5024), so
          // "unknown" is the empty string here, normalized to null after.
          name: { type: "string" },
          name_japanese: { type: "string" },
          city: { type: "string" },
          category: { type: "string" },
          evidence: { type: "string" },
          evidence_quote: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["name", "category", "evidence", "evidence_quote", "confidence"],
      },
    },
  },
  required: ["places"],
};

export class VideoPipeline extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { videoId, url } = event.payload;
    const shard = shardFor(videoId);

    await this.env.DB.prepare(
      "UPDATE videos SET status='processing', updated_at=datetime('now') WHERE id=?",
    ).bind(videoId).run();

    try {
      // 1. Download + frames + OCR inside the container. The container keeps
      //    the demuxed audio on its disk for step 2 (same shard → same instance).
      //    Generous timeout: OCR takes minutes per video and the container
      //    serializes it, so queued requests wait behind shard-mates.
      const processed = await step.do(
        "download+ocr",
        { retries: { limit: 6, delay: "1 minute", backoff: "exponential" }, timeout: "30 minutes" },
        async (): Promise<ProcessResult> => {
          const res = await getContainer(this.env.PROCESSOR, shard).fetch(
            "http://container/process",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: videoId, url, proxy: this.env.PROXY_URL }),
            },
          );
          if (res.status === 404 || res.status === 410) {
            throw new NonRetryableError(`video gone: ${await res.text()}`);
          }
          if (!res.ok) throw new Error(`process failed (${res.status}): ${await res.text()}`);
          return res.json();
        },
      );

      // 2. Transcribe — only when TikTok's own auto-captions are missing and
      //    the track suggests narration. Whisper runs on Workers AI; the audio
      //    bytes never leave this step (no 1 MiB step-state concerns).
      const transcript = await step.do("transcribe", async (): Promise<string | null> => {
        if (processed.auto_captions || !processed.has_audio) return processed.auto_captions;
        const audio = await getContainer(this.env.PROCESSOR, shard).fetch(
          `http://container/audio/${videoId}`,
        );
        if (!audio.ok) return null;
        const bytes = new Uint8Array(await audio.arrayBuffer());
        let b64 = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const out = await this.env.AI.run("@cf/openai/whisper-large-v3-turbo", {
          audio: btoa(b64),
        });
        return out.text ?? null;
      });

      // 3. Fuse signals → structured place entities (text-only LLM).
      const places = await step.do("fuse", async (): Promise<Place[]> => {
        const signals = {
          caption: processed.meta.caption,
          transcript,
          ocr_lines: processed.ocr_lines.map((l) => l.text),
        };
        const messages = [
          {
            role: "system",
            content:
              "Extract every specific, visitable place in Japan referenced by signals " +
              "from one TikTok travel video. OCR lines and transcripts are noisy — " +
              "reconstruct garbled names when context allows. Record the most specific " +
              "area mentioned as city (e.g. 'Nakano, Tokyo', not just 'Tokyo'). Spoken " +
              "shop names are often phonetically mangled by transcription: when a name " +
              "appears only in the transcript and no OCR/caption text corroborates it, " +
              "set confidence to 'medium' at most. Ignore generic mentions (e.g. " +
              "'convenience stores', 'a ramen shop'). Return an empty list when there " +
              "is no specific place.",
          },
          { role: "user", content: JSON.stringify(signals) },
        ];
        let raw: unknown;
        try {
          // max_tokens: the default (~256) truncates place-heavy videos,
          // which surfaces as AiError 5024 / unparseable JSON.
          const out = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages,
            max_tokens: 2048,
            response_format: { type: "json_schema", json_schema: PLACES_SCHEMA },
          }) as string | { response?: unknown };
          raw = typeof out === "string" ? out : out.response;
        } catch {
          // Strict JSON mode fails on some inputs (AiError 5024); fall back
          // to a plain prompt and pull the JSON object out of the text.
          const out = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            max_tokens: 2048,
            messages: [
              ...messages,
              {
                role: "system",
                content:
                  'Respond ONLY with a JSON object: {"places": [{"name", ' +
                  '"name_japanese", "city", "category", "evidence", ' +
                  '"evidence_quote", "confidence" ("high"|"medium"|"low")}]}',
              },
            ],
          }) as string | { response?: unknown };
          const text = typeof out === "string" ? out : String(out.response ?? "");
          raw = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
        }
        // If the model failed to produce JSON twice, finish the video with
        // no places rather than erroring it — signals stay in D1 for review.
        let parsed: { places?: Place[] };
        try {
          parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as { places?: Place[] };
        } catch {
          return [];
        }
        return (parsed.places ?? []).map((p) => ({
          ...p,
          name_japanese: p.name_japanese || null,
          city: p.city || null,
        }));
      });

      // 4. Geocode each place via Google Places Text Search (New).
      const geocoded = await step.do(
        "geocode",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const out = [];
          for (const place of places) {
            out.push({ place, geo: await geocodePlace(place, this.env.GOOGLE_MAPS_API_KEY) });
          }
          return out;
        },
      );

      // 5. Persist.
      await step.do("save", async () => {
        const signals = JSON.stringify({
          caption: processed.meta.caption,
          auto_captions: processed.auto_captions,
          transcript,
          ocr_lines: processed.ocr_lines,
        });
        const statements = [
          this.env.DB.prepare(
            "UPDATE videos SET status='done', signals=?, updated_at=datetime('now') WHERE id=?",
          ).bind(signals, videoId),
          this.env.DB.prepare("DELETE FROM places WHERE video_id=?").bind(videoId),
          ...geocoded.map(({ place, geo }) =>
            this.env.DB.prepare(
              `INSERT INTO places (video_id, name, name_japanese, city, category, evidence,
                 evidence_quote, confidence, place_id, resolved_name, address, lat, lng, geocode_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              videoId, place.name, place.name_japanese, place.city, place.category,
              place.evidence, place.evidence_quote, place.confidence,
              geo.place_id, geo.resolved_name, geo.address, geo.lat, geo.lng, geo.status,
            ),
          ),
        ];
        await this.env.DB.batch(statements);
      });
    } catch (e) {
      await this.env.DB.prepare(
        "UPDATE videos SET status='error', error=?, updated_at=datetime('now') WHERE id=?",
      ).bind(String(e), videoId).run();
      throw e;
    }
  }
}
