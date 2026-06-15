// Shared client-side map: styles, body markup, and the browser script.
// The script reads its data from window.__PLACES__ / window.__BUCKETS__ so the
// exact same code runs both in the Worker-rendered page (data injected from
// D1) and in the Vite/Playwright test harness (data injected as fixtures).
// Keep this framework-free; it only assumes a global `L` (Leaflet).

export const MAP_STYLES = `
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
  #tools { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tool {
    border: 1px solid #ccc; background: #fff; border-radius: 7px;
    padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  .tool.on { background: #2d6cdf; color: #fff; border-color: #2d6cdf; }
  #radius-wrap { display: none; align-items: center; gap: 6px; flex: 1; min-width: 150px; }
  #radius-wrap.show { display: flex; }
  #radius { flex: 1; }
  #radius-val { color: #333; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .home-pin {
    width: 26px; height: 26px; font-size: 22px; line-height: 26px; text-align: center;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); cursor: grab;
  }
`;

export const MAP_BODY = `
<div id="map"></div>
<div id="panel">
  <input id="q" type="search" placeholder="Search places, categories, videos…">
  <div id="chips"></div>
  <div id="tools">
    <button id="set-home" class="tool">📍 Set home</button>
    <button id="clear-home" class="tool" style="display:none">Clear</button>
    <div id="radius-wrap">
      <input id="radius" type="range" min="0.5" max="20" step="0.5" value="2">
      <span id="radius-val">2.0 km</span>
    </div>
  </div>
</div>`;

// Plain browser JS (not a module). Reads window.__PLACES__ and
// window.__BUCKETS__. Exposes window.__map for tests once initialised.
export const MAP_CLIENT_JS = `
(function () {
  const BUCKETS = window.__BUCKETS__;
  const places = window.__PLACES__;
  const map = L.map("map", { zoomControl: false });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  // CARTO Voyager: OSM data with English/latin labels (default OSM tiles
  // label Japan in Japanese).
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  const esc = (s) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

  // Great-circle distance in km.
  function distKm(a, b, c, d) {
    const R = 6371, r = Math.PI / 180;
    const u = Math.sin((c - a) * r / 2) ** 2 +
      Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(u));
  }

  // Home location + radius, persisted client-side (no backend).
  let home = null, radiusKm = 2, homeMarker = null, homeCircle = null, placing = false;
  try {
    const saved = JSON.parse(localStorage.getItem("someday-home") || "null");
    if (saved) { home = saved.home; radiusKm = saved.radiusKm || 2; }
  } catch (e) {}

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
  // Only track buckets that actually have places (and thus a chip); otherwise
  // an empty bucket sits in the set and breaks the lone-active "restore all".
  const present = new Set(places.map((p) => p.bucket));
  const active = new Set(present);
  const q = document.getElementById("q");

  function refresh(fit) {
    layer.clearLayers();
    const needle = q.value.trim().toLowerCase();
    let shown = 0;
    for (const p of places) {
      if (!active.has(p.bucket)) continue;
      if (needle && !p.haystack.includes(needle)) continue;
      if (home && distKm(home.lat, home.lng, p.lat, p.lng) > radiusKm) continue;
      layer.addLayer(p.marker);
      shown++;
    }
    const total = home ? "within " + radiusKm.toFixed(1) + " km" : places.length;
    document.getElementById("count").textContent = shown + (home ? " " + total : "/" + total);
    if (fit && shown) {
      const b = layer.getBounds();
      if (homeCircle) b.extend(homeCircle.getBounds());
      map.fitBounds(b.pad(0.1));
    }
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
        for (const k of present) active.add(k);
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

  // --- Home location + radius ---
  const setHomeBtn = document.getElementById("set-home");
  const clearHomeBtn = document.getElementById("clear-home");
  const radiusWrap = document.getElementById("radius-wrap");
  const radius = document.getElementById("radius");
  const radiusVal = document.getElementById("radius-val");
  const homeIcon = L.divIcon({
    className: "", html: '<div class="home-pin">🏠</div>',
    iconSize: [26, 26], iconAnchor: [13, 24],
  });

  function persist() {
    localStorage.setItem("someday-home", JSON.stringify({ home, radiusKm }));
  }

  function drawHome(fit) {
    if (homeMarker) homeMarker.remove();
    if (homeCircle) homeCircle.remove();
    radiusWrap.classList.toggle("show", !!home);
    clearHomeBtn.style.display = home ? "" : "none";
    setHomeBtn.textContent = home ? "📍 Move home" : "📍 Set home";
    if (!home) { homeMarker = homeCircle = null; refresh(false); return; }
    homeCircle = L.circle([home.lat, home.lng], {
      radius: radiusKm * 1000, color: "#2d6cdf", weight: 1,
      fillColor: "#2d6cdf", fillOpacity: 0.08,
    }).addTo(map);
    homeMarker = L.marker([home.lat, home.lng], { icon: homeIcon, draggable: true })
      .addTo(map).bindPopup("Home — drag to move");
    homeMarker.on("drag", (e) => {
      const ll = e.target.getLatLng();
      homeCircle.setLatLng(ll);
    });
    homeMarker.on("dragend", (e) => {
      const ll = e.target.getLatLng();
      home = { lat: ll.lat, lng: ll.lng };
      persist(); refresh(false);
    });
    refresh(fit);
  }

  setHomeBtn.onclick = () => {
    placing = !placing;
    setHomeBtn.classList.toggle("on", placing);
    map.getContainer().style.cursor = placing ? "crosshair" : "";
  };
  map.on("click", (e) => {
    if (!placing) return;
    home = { lat: e.latlng.lat, lng: e.latlng.lng };
    placing = false;
    setHomeBtn.classList.remove("on");
    map.getContainer().style.cursor = "";
    persist(); drawHome(false);
  });
  clearHomeBtn.onclick = () => { home = null; persist(); drawHome(false); };
  radius.value = String(radiusKm);
  radiusVal.textContent = radiusKm.toFixed(1) + " km";
  radius.addEventListener("input", () => {
    radiusKm = parseFloat(radius.value);
    radiusVal.textContent = radiusKm.toFixed(1) + " km";
    if (homeCircle) homeCircle.setRadius(radiusKm * 1000);
    persist(); refresh(false);
  });

  q.addEventListener("input", () => refresh(false));
  refresh(true);
  if (home) drawHome(true);

  // Test/debug hooks.
  window.__map = map;
  window.__refresh = refresh;
})();
`;
