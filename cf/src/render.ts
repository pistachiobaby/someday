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
<style>
  html, body, #map { height: 100%; margin: 0; }
  .popup h3 { margin: 0 0 4px; font-size: 14px; }
  .popup { font: 13px/1.4 system-ui, sans-serif; max-width: 240px; }
  .popup .quote { color: #555; font-style: italic; }
  .popup .flag { color: #b45309; font-weight: 600; }
  #panel {
    position: absolute; top: 10px; left: 10px; right: 10px; z-index: 1000;
    max-width: 430px; background: rgba(255,255,255,.96); border-radius: 10px;
    box-shadow: 0 1px 6px rgba(0,0,0,.3); padding: 8px;
    font: 13px system-ui, sans-serif;
  }
  #q {
    width: 100%; box-sizing: border-box; padding: 7px 10px; font-size: 15px;
    border: 1px solid #ccc; border-radius: 7px; outline: none;
  }
  #chips { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    border: none; border-radius: 12px; padding: 4px 10px; font-size: 12px;
    color: #fff; cursor: pointer; opacity: 1;
  }
  .chip.off { opacity: .35; }
  #count { color: #666; margin-left: 4px; align-self: center; }
  .dot {
    border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
    border: 2px solid rgba(0,0,0,.35); box-sizing: border-box;
  }
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
  <input id="q" type="search" placeholder="Search places, categories, videos…">
  <div id="chips"></div>
</div>
<script>
  const BUCKETS = ${JSON.stringify(BUCKETS)};
  const places = ${JSON.stringify(markers)};
  const map = L.map("map", { zoomControl: false });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  // CARTO Voyager: OSM data with English/latin labels (default OSM tiles
  // label Japan in Japanese).
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  const esc = (s) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const pinIcon = (color) => L.divIcon({
    className: "",
    html: '<div class="dot" style="width:22px;height:22px;background:' + color + '"></div>',
    iconSize: [22, 22], iconAnchor: [4, 20], popupAnchor: [7, -18],
  });

  for (const p of places) {
    p.haystack = [p.name, p.alias, p.city, p.category, p.quote, p.address]
      .join(" ").toLowerCase();
    p.marker = L.marker([p.lat, p.lng], { icon: pinIcon(BUCKETS[p.bucket].color) })
      .bindPopup(
        '<div class="popup"><h3>' + esc(p.name) + "</h3>" +
        (p.flagged ? '<div class="flag">⚠️ verify branch</div>' : "") +
        (p.chain ? '<div class="flag">chain — nearby branch</div>' : "") +
        esc([p.category, p.city].filter(Boolean).join(" · ")) +
        (p.quote ? '<div class="quote">“' + esc(p.quote) + "”</div>" : "") +
        (p.address ? "<div>" + esc(p.address) + "</div>" : "") +
        (p.gmaps ? '<a href="' + p.gmaps + '" target="_blank">open in Google Maps</a> · ' : "") +
        '<a href="' + p.video + '" target="_blank">source tiktok</a></div>');
  }

  const layer = L.featureGroup().addTo(map);
  const active = new Set(Object.keys(BUCKETS));
  const q = document.getElementById("q");

  function refresh(fit) {
    layer.clearLayers();
    const needle = q.value.trim().toLowerCase();
    let shown = 0;
    for (const p of places) {
      if (!active.has(p.bucket)) continue;
      if (needle && !p.haystack.includes(needle)) continue;
      layer.addLayer(p.marker);
      shown++;
    }
    document.getElementById("count").textContent = shown + "/" + places.length;
    if (fit && shown) map.fitBounds(layer.getBounds().pad(0.1));
  }

  const chips = document.getElementById("chips");
  for (const [id, b] of Object.entries(BUCKETS)) {
    const n = places.filter((p) => p.bucket === id).length;
    if (!n) continue;
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.style.background = b.color;
    btn.textContent = b.label + " " + n;
    btn.onclick = () => {
      // tap a lone-active chip to bring everything back
      if (active.has(id) && active.size === 1) {
        for (const k of Object.keys(BUCKETS)) active.add(k);
      } else if (active.has(id)) {
        active.delete(id);
      } else {
        active.add(id);
      }
      for (const el of chips.children) {
        if (el.dataset.bucket) el.classList.toggle("off", !active.has(el.dataset.bucket));
      }
      refresh(false);
    };
    btn.dataset.bucket = id;
    chips.appendChild(btn);
  }
  const count = document.createElement("span");
  count.id = "count";
  chips.appendChild(count);

  q.addEventListener("input", () => refresh(false));
  refresh(true);
</script>
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
