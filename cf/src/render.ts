import { MAP_STYLES, MAP_BODY, MAP_CLIENT_JS } from "./mapClient";

type PlaceRow = {
  name: string; name_japanese: string | null; city: string | null;
  category: string | null; evidence_quote: string | null; confidence: string | null;
  role: string | null; is_chain: number | null;
  resolved_name: string | null; address: string | null;
  lat: number | null; lng: number | null; place_id: string | null;
  geocode_status: string | null; video_url: string; video_title: string | null;
};

async function loadPlaces(db: D1Database): Promise<PlaceRow[]> {
  const { results } = await db.prepare(
    `SELECT p.*, v.url as video_url, v.title as video_title
     FROM places p JOIN videos v ON v.id = p.video_id
     ORDER BY p.city, p.category, p.name`,
  ).all<PlaceRow>();
  return results;
}

function esc(s: string | null): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Model categories are free text; bucket them for coloring/filtering.
export const BUCKETS: Record<string, { label: string; color: string }> = {
  food: { label: "Food", color: "#e74c3c" },
  cafe: { label: "Cafés & sweets", color: "#e67e22" },
  shopping: { label: "Shopping", color: "#3498db" },
  sights: { label: "Sights", color: "#27ae60" },
  area: { label: "Areas", color: "#8e44ad" },
  other: { label: "Other", color: "#7f8c8d" },
};

export function bucketOf(category: string | null): string {
  const c = (category ?? "").toLowerCase();
  if (/cafe|coffee|ice cream|dessert|pancake|bakery|sweet|tea/.test(c)) return "cafe";
  if (/restaurant|izakaya|sushi|ramen|yakitori|food|market|bbq|bar\b/.test(c)) return "food";
  if (/store|shop|supermarket|convenience|drugstore|department|electronics|optician|mall|fashion|brand|book/.test(c)) return "shopping";
  if (/temple|shrine|park|garden|observat|landmark|bridge|beach|forest|museum|castle|histor|tower|deck|building|aquarium|zoo/.test(c)) return "sights";
  if (/neighborhood|district|city|prefecture|quarter|area|town|island/.test(c)) return "area";
  return "other";
}

export async function renderKml(db: D1Database): Promise<string> {
  const places = (await loadPlaces(db)).filter((p) => p.lat != null);
  const byCity = new Map<string, PlaceRow[]>();
  for (const p of places) {
    const city = p.city ?? "Unsorted";
    byCity.set(city, [...(byCity.get(city) ?? []), p]);
  }

  // KML colors are aabbggrr.
  const kmlColor = (hex: string) =>
    "ff" + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
  const styles = Object.entries(BUCKETS).map(([id, b]) => `
  <Style id="${id}"><IconStyle><color>${kmlColor(b.color)}</color>
    <Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon>
  </IconStyle></Style>`).join("");

  const folders = [...byCity].map(([city, rows]) => {
    const pins = rows.map((p) => `
    <Placemark>
      <name>${esc(p.resolved_name ?? p.name)}</name>
      <styleUrl>#${bucketOf(p.category)}</styleUrl>
      <description>${esc(
        `${p.category ?? ""} [${p.confidence ?? ""}]\n` +
        `${p.evidence_quote ? `“${p.evidence_quote}”\n` : ""}` +
        `${p.address ?? ""}\n${p.video_url}`,
      )}</description>
      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>
    </Placemark>`).join("");
    return `  <Folder><name>${esc(city)}</name>${pins}\n  </Folder>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>Japan trip — from TikTok bookmarks</name>${styles}
${folders}
</Document></kml>`;
}

// Self-contained interactive map (Leaflet + OSM tiles, no API key) for
// phones/browsers; My Maps has no import API, so this is the shareable link.
export async function renderMapHtml(db: D1Database): Promise<string> {
  const places = (await loadPlaces(db)).filter((p) => p.lat != null);
  const markers = places.map((p) => ({
    lat: p.lat, lng: p.lng,
    name: p.resolved_name ?? p.name,
    alias: p.name,
    city: p.city, category: p.category, confidence: p.confidence,
    bucket: bucketOf(p.category),
    chain: !!p.is_chain,
    quote: p.evidence_quote, address: p.address,
    gmaps: p.place_id
      ? "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent(p.resolved_name ?? p.name) +
        `&query_place_id=${p.place_id}`
      : null,
    video: p.video_url,
    flagged: p.geocode_status === "ambiguous",
  }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Japan trip — ${places.length} places from TikTok bookmarks</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>${MAP_STYLES}</style>
</head>
<body>${MAP_BODY}
<script>
  window.__BUCKETS__ = ${JSON.stringify(BUCKETS)};
  window.__PLACES__ = ${JSON.stringify(markers)};
</script>
<script>${MAP_CLIENT_JS}</script>
</body>
</html>`;
}

export async function renderTripDoc(db: D1Database): Promise<string> {
  const all = await loadPlaces(db);
  const places = all.filter((p) => p.role !== "incidental");
  const incidental = all.filter((p) => p.role === "incidental");
  const lines = ["# Japan trip — places from TikTok bookmarks\n"];
  let city = "";
  for (const p of places) {
    const c = p.city ?? "Unsorted";
    if (c !== city) {
      city = c;
      lines.push(`\n## ${city}\n`);
    }
    const name = p.resolved_name ?? p.name;
    const ja = p.name_japanese ? ` (${p.name_japanese})` : "";
    const maps = p.place_id
      ? ` · [map](https://www.google.com/maps/search/?api=1&query=${
          encodeURIComponent(name)}&query_place_id=${p.place_id})`
      : "";
    const flag = p.geocode_status === "ambiguous" ? " ⚠️ *verify branch*"
      : p.geocode_status === "not_found" ? " ⚠️ *not geocoded*" : "";
    lines.push(`- **${name}**${ja} — ${p.category} [${p.confidence}]${flag}`);
    if (p.evidence_quote) lines.push(`  - “${p.evidence_quote}”`);
    lines.push(`  - [source tiktok](${p.video_url})${maps}`);
  }
  if (incidental.length) {
    lines.push("\n## Mentioned in passing (transit/navigation — not pinned)\n");
    for (const p of incidental) {
      lines.push(`- ${p.name}${p.city ? ` (${p.city})` : ""} — [source](${p.video_url})`);
    }
  }
  return lines.join("\n");
}
