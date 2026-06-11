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

// Tight FieldMask keeps us in the Text Search Pro SKU (5k free calls/month).
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location";

export async function geocodePlace(
  place: Place,
  apiKey: string,
): Promise<GeocodeResult> {
  if (place.confidence === "low" && !place.city) return { ...EMPTY, status: "skipped" };

  const query = [place.name, place.city ?? "", "Japan"].filter(Boolean).join(" ");
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-fieldmask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: "en",
      regionCode: "JP",
      pageSize: 3,
    }),
  });
  if (!res.ok) throw new Error(`places api ${res.status}: ${await res.text()}`);

  const { places = [] } = await res.json<{ places?: any[] }>();
  if (places.length === 0) return EMPTY;

  const top = places[0];
  return {
    // >1 plausible result for a chain-like name → flag for human review
    status: places.length > 1 && isChainLike(place.name) ? "ambiguous" : "ok",
    place_id: top.id,
    resolved_name: top.displayName?.text ?? null,
    address: top.formattedAddress ?? null,
    lat: top.location?.latitude ?? null,
    lng: top.location?.longitude ?? null,
  };
}

function isChainLike(name: string): boolean {
  return /ichiran|sushiro|coco|ippudo|matsuya|yoshinoya|saizeriya|don quijote|donki/i.test(name);
}
