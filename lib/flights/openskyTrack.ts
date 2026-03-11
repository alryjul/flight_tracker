import { getOpenSkyAuthorizationHeader } from "@/lib/flights/openskyAuth";
import type { SelectedFlightTrackPoint } from "@/lib/flights/aeroapi";

type OpenSkyTrackResponse = {
  path?: Array<[number, number | null, number, number, number | null, number | null, boolean]>;
};

const OPEN_SKY_TRACK_TTL_MS = 1000 * 60 * 2;

type CacheEntry = {
  expiresAt: number;
  value: SelectedFlightTrackPoint[];
};

const trackCache = new Map<string, CacheEntry>();
const trackRequests = new Map<string, Promise<SelectedFlightTrackPoint[]>>();

function getCachedTrack(icao24: string) {
  const cached = trackCache.get(icao24);

  if (!cached) {
    return undefined;
  }

  if (Date.now() > cached.expiresAt) {
    trackCache.delete(icao24);
    return undefined;
  }

  return cached.value;
}

function setCachedTrack(icao24: string, value: SelectedFlightTrackPoint[]) {
  trackCache.set(icao24, {
    expiresAt: Date.now() + OPEN_SKY_TRACK_TTL_MS,
    value
  });
}

export async function fetchOpenSkySelectedFlightTrack(icao24: string) {
  const normalizedIcao24 = icao24.trim().toLowerCase();

  if (!normalizedIcao24) {
    return [];
  }

  const cached = getCachedTrack(normalizedIcao24);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = trackRequests.get(normalizedIcao24);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const authorizationHeader = await getOpenSkyAuthorizationHeader();
    const searchParams = new URLSearchParams({
      icao24: normalizedIcao24,
      time: "0"
    });

    const response = await fetch(
      `https://opensky-network.org/api/tracks/all?${searchParams.toString()}`,
      {
        headers: authorizationHeader ? { Authorization: authorizationHeader } : undefined,
        cache: "no-store"
      }
    );

    if (response.status === 404) {
      setCachedTrack(normalizedIcao24, []);
      return [];
    }

    if (!response.ok) {
      throw new Error(`OpenSky track request failed with status ${response.status}`);
    }

    const data = (await response.json()) as OpenSkyTrackResponse;
    const track = (data.path ?? []).map((point) => ({
      timestamp: new Date(point[0] * 1000).toISOString(),
      altitudeFeet: point[1] == null ? null : Math.round(point[1] * 3.28084),
      latitude: point[2],
      longitude: point[3],
      heading: point[4],
      groundspeedKnots: point[5] == null ? null : Math.round(point[5] * 1.94384)
    }));

    setCachedTrack(normalizedIcao24, track);
    return track;
  })();

  trackRequests.set(normalizedIcao24, request);

  try {
    return await request;
  } finally {
    trackRequests.delete(normalizedIcao24);
  }
}
