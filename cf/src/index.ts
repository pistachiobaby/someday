import { Container, getContainer } from "@cloudflare/containers";
export { VideoPipeline } from "./workflow";
import { renderKml, renderMapHtml, renderTripDoc } from "./render";

export class Processor extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";
}

export interface Env {
  PROCESSOR: DurableObjectNamespace<Processor>;
  VIDEO_PIPELINE: Workflow;
  DB: D1Database;
  AI: Ai;
  API_TOKEN: string; // wrangler secret put API_TOKEN
  GOOGLE_MAPS_API_KEY: string; // wrangler secret put GOOGLE_MAPS_API_KEY
  PROXY_URL?: string; // optional residential proxy for yt-dlp
}

const SHARDS = 5; // must match max_instances in wrangler.jsonc

export function shardFor(videoId: string): string {
  let h = 0;
  for (const c of videoId) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `shard-${Math.abs(h) % SHARDS}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ?token= lets the map/doc outputs work as plain links on a phone.
    if (
      request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}` &&
      url.searchParams.get("token") !== env.API_TOKEN
    ) {
      return new Response("unauthorized", { status: 401 });
    }

    // POST /ingest {collection_url} — enumerate a public collection and
    // spawn one workflow per video.
    if (request.method === "POST" && url.pathname === "/ingest") {
      const { collection_url } = await request.json<{ collection_url: string }>();
      const container = getContainer(env.PROCESSOR, "shard-0");
      const listed = await container.fetch("http://container/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collection_url, proxy: env.PROXY_URL }),
      });
      if (!listed.ok) {
        return new Response(`list failed: ${await listed.text()}`, { status: 502 });
      }
      const videos = await listed.json<{ id: string; url: string; title: string }[]>();

      const stmt = env.DB.prepare(
        "INSERT OR IGNORE INTO videos (id, url, title) VALUES (?, ?, ?)",
      );
      await env.DB.batch(videos.map((v) => stmt.bind(v.id, v.url, v.title)));

      // Workflows cap createBatch sizes; chunk to stay well inside limits.
      for (let i = 0; i < videos.length; i += 20) {
        await env.VIDEO_PIPELINE.createBatch(
          videos.slice(i, i + 20).map((v) => ({
            id: `video-${v.id}`,
            params: { videoId: v.id, url: v.url },
          })),
        );
      }
      return Response.json({ queued: videos.length });
    }

    // POST /retry — respawn workflows for errored videos.
    if (request.method === "POST" && url.pathname === "/retry") {
      const { results } = await env.DB.prepare(
        "SELECT id, url FROM videos WHERE status = 'error'",
      ).all<{ id: string; url: string }>();
      for (const v of results) {
        await env.VIDEO_PIPELINE.create({
          id: `video-${v.id}-retry-${Date.now()}`,
          params: { videoId: v.id, url: v.url },
        });
      }
      return Response.json({ retried: results.length });
    }

    if (url.pathname === "/status") {
      const { results } = await env.DB.prepare(
        "SELECT status, COUNT(*) n FROM videos GROUP BY status",
      ).all();
      const places = await env.DB.prepare("SELECT COUNT(*) n FROM places").first<{ n: number }>();
      return Response.json({ videos: results, places: places?.n ?? 0 });
    }

    if (url.pathname === "/outputs/places.json") {
      const { results } = await env.DB.prepare(
        `SELECT p.*, v.url as video_url, v.title as video_title
         FROM places p JOIN videos v ON v.id = p.video_id ORDER BY p.city, p.name`,
      ).all();
      return Response.json(results);
    }

    if (url.pathname === "/outputs/map.html") {
      return new Response(await renderMapHtml(env.DB), {
        // no-store: browsers heuristically cache responses without
        // validators and then serve stale UI on refresh.
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/outputs/map.kml") {
      return new Response(await renderKml(env.DB), {
        headers: { "content-type": "application/vnd.google-earth.kml+xml" },
      });
    }

    if (url.pathname === "/outputs/trip.md") {
      return new Response(await renderTripDoc(env.DB), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
