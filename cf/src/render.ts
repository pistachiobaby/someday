type PlaceRow = {
  name: string; name_japanese: string | null; city: string | null;
  category: string | null; evidence_quote: string | null; confidence: string | null;
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

export async function renderKml(db: D1Database): Promise<string> {
  const places = (await loadPlaces(db)).filter((p) => p.lat != null);
  const byCity = new Map<string, PlaceRow[]>();
  for (const p of places) {
    const city = p.city ?? "Unsorted";
    byCity.set(city, [...(byCity.get(city) ?? []), p]);
  }

  const folders = [...byCity].map(([city, rows]) => {
    const pins = rows.map((p) => `
    <Placemark>
      <name>${esc(p.resolved_name ?? p.name)}</name>
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
<Document><name>Japan trip — from TikTok bookmarks</name>
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
    city: p.city, category: p.category, confidence: p.confidence,
    quote: p.evidence_quote, address: p.address,
    gmaps: p.place_id
      ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}`
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
<style>
  html, body, #map { height: 100%; margin: 0; }
  .popup h3 { margin: 0 0 4px; font-size: 14px; }
  .popup { font: 13px/1.4 system-ui, sans-serif; max-width: 240px; }
  .popup .quote { color: #555; font-style: italic; }
  .popup .flag { color: #b45309; font-weight: 600; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  const places = ${JSON.stringify(markers)};
  const map = L.map("map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const esc = (s) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const group = L.featureGroup(places.map((p) => L.marker([p.lat, p.lng]).bindPopup(
    '<div class="popup"><h3>' + esc(p.name) + "</h3>" +
    (p.flagged ? '<div class="flag">⚠️ verify branch</div>' : "") +
    esc([p.category, p.city].filter(Boolean).join(" · ")) +
    (p.quote ? '<div class="quote">“' + esc(p.quote) + "”</div>" : "") +
    (p.address ? "<div>" + esc(p.address) + "</div>" : "") +
    (p.gmaps ? '<a href="' + p.gmaps + '" target="_blank">open in Google Maps</a> · ' : "") +
    '<a href="' + p.video + '" target="_blank">source tiktok</a></div>',
  ))).addTo(map);
  map.fitBounds(group.getBounds().pad(0.1));
</script>
</body>
</html>`;
}

export async function renderTripDoc(db: D1Database): Promise<string> {
  const places = await loadPlaces(db);
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
      ? ` · [map](https://www.google.com/maps/place/?q=place_id:${p.place_id})`
      : "";
    const flag = p.geocode_status === "ambiguous" ? " ⚠️ *verify branch*"
      : p.geocode_status === "not_found" ? " ⚠️ *not geocoded*" : "";
    lines.push(`- **${name}**${ja} — ${p.category} [${p.confidence}]${flag}`);
    if (p.evidence_quote) lines.push(`  - “${p.evidence_quote}”`);
    lines.push(`  - [source tiktok](${p.video_url})${maps}`);
  }
  return lines.join("\n");
}
