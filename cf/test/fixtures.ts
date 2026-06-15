// Deterministic place fixtures for the map tests — no DB, no network.
// Distances are chosen relative to Tokyo Station (35.6812, 139.7671):
//   Ramen Ichi  ~0.1 km   (in 2 km)
//   Coffee Two  ~1.4 km   (in 2 km)
//   Tower Three ~4.4 km   (out of 2 km, in 8 km)
//   Ward Five   ~5.0 km   (out of 2 km, in 8 km)
//   Mall Four   ~400 km   (Osaka — always out when home is Tokyo)

export const FIXTURE_BUCKETS: Record<string, { label: string; color: string }> = {
  food: { label: "Food", color: "#e74c3c" },
  cafe: { label: "Cafés & sweets", color: "#e67e22" },
  shopping: { label: "Shopping", color: "#3498db" },
  sights: { label: "Sights", color: "#27ae60" },
  area: { label: "Areas", color: "#8e44ad" },
  other: { label: "Other", color: "#7f8c8d" },
};

type Marker = {
  lat: number; lng: number; name: string; alias: string;
  city: string | null; category: string | null; confidence: string | null;
  bucket: string; chain: boolean; quote: string | null; address: string | null;
  gmaps: string | null; video: string; flagged: boolean;
};

const base = {
  alias: "", confidence: "high", chain: false, quote: null, address: null,
  gmaps: null, video: "https://tiktok.com/x", flagged: false,
} as const;

export const FIXTURE: Marker[] = [
  { ...base, lat: 35.6815, lng: 139.768, name: "Ramen Ichi", alias: "Ramen Ichi",
    city: "Chiyoda, Tokyo", category: "ramen", bucket: "food", quote: "best tonkotsu" },
  { ...base, lat: 35.694, lng: 139.7671, name: "Coffee Two", alias: "Coffee Two",
    city: "Shinjuku, Tokyo", category: "coffee shop", bucket: "cafe" },
  { ...base, lat: 35.70, lng: 139.81, name: "Tower Three", alias: "Tower Three",
    city: "Sumida, Tokyo", category: "observation deck", bucket: "sights" },
  { ...base, lat: 34.7025, lng: 135.4959, name: "Mall Four", alias: "Mall Four",
    city: "Osaka", category: "department store", bucket: "shopping", chain: true,
    flagged: true },
  { ...base, lat: 35.726, lng: 139.7671, name: "Ward Five", alias: "Ward Five",
    city: "Nakano, Tokyo", category: "neighborhood", bucket: "area" },
];

export const TOKYO_STATION = { lat: 35.6812, lng: 139.7671 };
