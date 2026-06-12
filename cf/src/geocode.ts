import type { Place } from "./workflow";

export type GeocodeResult = {
  status: "ok" | "ambiguous" | "not_found" | "skipped";
  place_id: string | null;
  resolved_name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

const EMPTY: GeocodeResult = {
  status: "not_found", place_id: null, resolved_name: null,
  address: null, lat: null, lng: null,
};

const SKIPPED: GeocodeResult = { ...EMPTY, status: "skipped" };

// Tight FieldMask keeps us in the Text Search Pro SKU (5k free calls/month).
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location";

const TOKYO_STATION = { latitude: 35.6812, longitude: 139.7671 };
const CHAIN_RADIUS_M = 15000;
const CHAIN_MAX_BRANCHES = 3;

async function searchText(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<any[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-fieldmask": FIELD_MASK,
    },
    body: JSON.stringify({ languageCode: "en", regionCode: "JP", ...body }),
  });
  if (!res.ok) throw new Error(`places api ${res.status}: ${await res.text()}`);
  const { places = [] } = await res.json<{ places?: any[] }>();
  return places;
}

function toResult(p: any, status: GeocodeResult["status"]): GeocodeResult {
  return {
    status,
    place_id: p.id,
    resolved_name: p.displayName?.text ?? null,
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  };
}

// regionCode is only a bias — garbled names can match anywhere on earth.
function inJapan(p: any): boolean {
  const lat = p.location?.latitude, lng = p.location?.longitude;
  return lat != null && lat >= 24 && lat <= 46 && lng >= 122 && lng <= 154;
}

// One Place can resolve to several rows: chains return up to
// CHAIN_MAX_BRANCHES branches near the stated area instead of one
// arbitrary nationwide hit.
export async function geocodePlace(
  place: Place,
  apiKey: string,
): Promise<GeocodeResult[]> {
  // Transit/navigation mentions stay in the doc but never get pinned.
  if (place.role === "incidental") return [SKIPPED];
  if (place.confidence === "low" && !place.city) return [SKIPPED];

  if (place.is_chain) {
    // Anchor the branch search to the mentioned area (fallback: Tokyo Stn).
    let center = TOKYO_STATION;
    if (place.city) {
      const area = await searchText(apiKey, {
        textQuery: `${place.city} Japan`, pageSize: 1,
      });
      if (area[0]?.location) center = area[0].location;
    }
    const branches = (await searchText(apiKey, {
      textQuery: `${place.name} ${place.city ?? ""}`.trim(),
      pageSize: CHAIN_MAX_BRANCHES,
      locationBias: { circle: { center, radius: CHAIN_RADIUS_M } },
    })).filter(inJapan);
    if (branches.length === 0) return [EMPTY];
    return branches.map((b) => toResult(b, "ok"));
  }

  const query = [place.name, place.city ?? "", "Japan"].filter(Boolean).join(" ");
  const places = (await searchText(apiKey, { textQuery: query, pageSize: 3 })).filter(inJapan);
  if (places.length === 0) return [EMPTY];
  // >1 plausible result for a chain-like name → flag for human review
  const status = places.length > 1 && isChainLike(place.name) ? "ambiguous" : "ok";
  return [toResult(places[0], status)];
}

function isChainLike(name: string): boolean {
  return /ichiran|sushiro|coco|ippudo|matsuya|yoshinoya|saizeriya|don quijote|donki/i.test(name);
}
