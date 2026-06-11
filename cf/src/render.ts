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
