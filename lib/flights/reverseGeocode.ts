// Why: AeroAPI emits "L <lat> <lon>" pseudo-codes for origin/destination
// when an aircraft takes off from or lands at a non-airport location
// (heliports, helipads, fields, ad-hoc spots). Showing the raw lat/lon
// is unhelpful — but turning it into "Hollywood Hills" or "Cedars-Sinai"
// via reverse geocoding is genuinely informative for an LA ambient
// tracker.
//
// Uses OpenStreetMap Nominatim — free, no API key, no daily quota, but
// the public instance asks for a descriptive User-Agent and a soft
// 1 req/sec policy. We cache aggressively (7-day TTL on hits, 1-min on
// misses, key rounded to 4 decimal places ≈ 10m bucket) so the same
// heliport doesn't get re-resolved across selections or polls.

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const REVERSE_GEOCODE_HIT_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const REVERSE_GEOCODE_MISS_TTL_MS = 1000 * 60;
const REVERSE_GEOCODE_REQUEST_TIMEOUT_MS = 4000;
const REVERSE_GEOCODE_CACHE_MAX_ENTRIES = 500;
const REVERSE_GEOCODE_REQUEST_SPACING_MS = 1100;

type CacheEntry = {
  value: string | null;
  expiresAt: number;
};

const reverseGeocodeCache = new Map<string, CacheEntry>();
const reverseGeocodeRequests = new Map<string, Promise<string | null>>();
let lastReverseGeocodeAt = 0;

function getCacheKey(lat: number, lon: number) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function getCached(key: string) {
  const cached = reverseGeocodeCache.get(key);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAt) {
    reverseGeocodeCache.delete(key);
    return undefined;
  }
  // LRU touch — re-set to move to end.
  reverseGeocodeCache.delete(key);
  reverseGeocodeCache.set(key, cached);
  return cached.value;
}

function setCached(key: string, value: string | null) {
  if (
    !reverseGeocodeCache.has(key) &&
    reverseGeocodeCache.size >= REVERSE_GEOCODE_CACHE_MAX_ENTRIES
  ) {
    const oldest = reverseGeocodeCache.keys().next().value;
    if (oldest !== undefined) {
      reverseGeocodeCache.delete(oldest);
    }
  }
  reverseGeocodeCache.set(key, {
    value,
    expiresAt: Date.now() + (value ? REVERSE_GEOCODE_HIT_TTL_MS : REVERSE_GEOCODE_MISS_TTL_MS)
  });
}

// Why: pick the most user-meaningful field from Nominatim's structured
// `address` object. Order favors specific named landmarks (heliports,
// hospitals) over generic geography (city, county). Avoids returning
// raw street numbers — those imply false precision.
function pickLabel(address: Record<string, unknown> | undefined | null): string | null {
  if (!address) return null;
  const candidates = [
    address.aeroway,
    address.amenity,
    address.tourism,
    address.building,
    address.neighbourhood,
    address.suburb,
    address.quarter,
    address.hamlet,
    address.village,
    address.town,
    address.city
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export async function reverseGeocodeLocationLabel(
  latitude: number,
  longitude: number
): Promise<string | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  const key = getCacheKey(latitude, longitude);
  const cached = getCached(key);
  if (cached !== undefined) {
    return cached;
  }
  const inFlight = reverseGeocodeRequests.get(key);
  if (inFlight) {
    return inFlight;
  }

  const request = (async (): Promise<string | null> => {
    // Soft per-process spacing — Nominatim's public instance asks for
    // ≤ 1 req/sec. Wait if we'd exceed.
    const sinceLast = Date.now() - lastReverseGeocodeAt;
    if (sinceLast < REVERSE_GEOCODE_REQUEST_SPACING_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, REVERSE_GEOCODE_REQUEST_SPACING_MS - sinceLast)
      );
    }
    lastReverseGeocodeAt = Date.now();

    const url =
      `${NOMINATIM_BASE}/reverse?` +
      new URLSearchParams({
        lat: String(latitude),
        lon: String(longitude),
        format: "json",
        zoom: "14",
        addressdetails: "1"
      }).toString();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      REVERSE_GEOCODE_REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "User-Agent": "flight-tracker/0.1 (+ambient airspace)",
          Accept: "application/json"
        }
      });
      if (!response.ok) {
        setCached(key, null);
        return null;
      }
      const data = (await response.json()) as {
        address?: Record<string, unknown> | null;
      };
      const label = pickLabel(data.address ?? null);
      setCached(key, label);
      return label;
    } catch (error) {
      console.warn("reverseGeocodeLocationLabel failed", { latitude, longitude, error });
      setCached(key, null);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  reverseGeocodeRequests.set(key, request);
  try {
    return await request;
  } finally {
    reverseGeocodeRequests.delete(key);
  }
}

// Why: AeroAPI emits "L <lat> <lon>" (e.g., "L 34.15752 -118.20980") in the
// `code` field for non-airport origins/destinations. Parse it back into a
// {lat, lon} pair if the format matches. Returns null if not a pseudo-code.
export function parseLatLonPseudoCode(
  code: string | null | undefined
): { latitude: number; longitude: number } | null {
  if (!code) return null;
  const match = /^L\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(code.trim());
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}
