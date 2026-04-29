import type { SelectedFlightTrackPoint } from "@/lib/flights/aeroapi";

// Why: adsb.lol exposes a community-fed ADS-B trace at
// `https://globe.adsb.lol/data/traces/<bucket>/trace_recent_<icao>.json`,
// where bucket is the last two hex characters of the icao24. Coverage
// for GA is significantly better than OpenSky's `/tracks/all` because
// volunteer feeders pick up low-altitude and uncontrolled-airspace
// traffic that the commercial network often misses.
//
// The trace is the readsb/tar1090 format: an array of point arrays,
// each `[seconds_since_base_ts, lat, lon, alt_ft|"ground", gs_kt,
// track_deg, flags, vert_rate, ext_obj_or_null, source_or_null]`.
// We pull the `recent` variant (a few minutes of history, ~3-10KB)
// rather than the `full` variant (whole-day, often >100KB) since the
// in-app trail only needs near-time history.

const ADSBLOL_TRACE_BASE = "https://globe.adsb.lol/data/traces";
const ADSBLOL_TRACE_TTL_MS = 1000 * 60 * 2;
const ADSBLOL_TRACE_NULL_TTL_MS = 1000 * 60 * 5;
const ADSBLOL_TRACE_CACHE_MAX_ENTRIES = 500;
const ADSBLOL_RATE_LIMIT_COOLDOWN_MS = 1000 * 30;

type CacheEntry = {
  expiresAt: number;
  value: SelectedFlightTrackPoint[];
};

type AdsbLolTracePoint = [
  number, // seconds since trace.timestamp
  number, // latitude
  number, // longitude
  number | "ground" | null, // altitude (feet)
  number | null, // groundspeed (knots)
  number | null, // track / heading (degrees)
  number | null, // flags
  number | null, // vertical rate (ft/min)
  Record<string, unknown> | null, // extended data
  string | null // source
];

type AdsbLolTraceResponse = {
  icao: string;
  timestamp: number;
  trace: AdsbLolTracePoint[];
};

const traceCache = new Map<string, CacheEntry>();
const traceRequests = new Map<string, Promise<SelectedFlightTrackPoint[]>>();
let cooldownUntil = 0;

function getCachedTrace(icao24: string) {
  const cached = traceCache.get(icao24);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAt) {
    traceCache.delete(icao24);
    return undefined;
  }
  // LRU touch.
  traceCache.delete(icao24);
  traceCache.set(icao24, cached);
  return cached.value;
}

function setCachedTrace(icao24: string, value: SelectedFlightTrackPoint[], ttlMs: number) {
  if (!traceCache.has(icao24) && traceCache.size >= ADSBLOL_TRACE_CACHE_MAX_ENTRIES) {
    const oldestKey = traceCache.keys().next().value;
    if (oldestKey !== undefined) {
      traceCache.delete(oldestKey);
    }
  }
  traceCache.set(icao24, { expiresAt: Date.now() + ttlMs, value });
}

function getBucket(icao24: string) {
  return icao24.slice(-2);
}

function convertTrace(response: AdsbLolTraceResponse): SelectedFlightTrackPoint[] {
  const baseSec = response.timestamp;
  if (!Number.isFinite(baseSec)) return [];

  return response.trace
    .map((point) => {
      const [offsetSec, latitude, longitude, altitude, groundspeed, heading] = point;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      const absoluteSec = baseSec + offsetSec;
      const altitudeFeet =
        typeof altitude === "number" && Number.isFinite(altitude) ? Math.round(altitude) : null;

      return {
        altitudeFeet,
        groundspeedKnots:
          typeof groundspeed === "number" && Number.isFinite(groundspeed)
            ? Math.round(groundspeed)
            : null,
        heading:
          typeof heading === "number" && Number.isFinite(heading) ? heading : null,
        latitude,
        longitude,
        timestamp: new Date(absoluteSec * 1000).toISOString()
      } satisfies SelectedFlightTrackPoint;
    })
    .filter((point): point is SelectedFlightTrackPoint => point != null);
}

export async function fetchAdsbLolSelectedFlightTrack(icao24: string): Promise<SelectedFlightTrackPoint[]> {
  const normalized = icao24.trim().toLowerCase();
  if (!normalized || normalized.length < 6) return [];

  const cached = getCachedTrace(normalized);
  if (cached !== undefined) {
    return cached;
  }

  if (Date.now() < cooldownUntil) {
    return [];
  }

  const inFlight = traceRequests.get(normalized);
  if (inFlight) {
    return inFlight;
  }

  const request = (async (): Promise<SelectedFlightTrackPoint[]> => {
    const url = `${ADSBLOL_TRACE_BASE}/${getBucket(normalized)}/trace_recent_${normalized}.json`;
    const response = await fetch(url, {
      cache: "no-store",
      // Why: adsb.lol's CDN serves these files gzipped; node-fetch handles
      // decompression automatically with this header. Be a polite client.
      headers: { "User-Agent": "flight-tracker/0.1 (+ambient airspace)" }
    });

    if (response.status === 404) {
      // Aircraft not yet seen by their network — cache the negative
      // answer briefly and move on.
      setCachedTrace(normalized, [], ADSBLOL_TRACE_NULL_TTL_MS);
      return [];
    }

    if (response.status === 429) {
      cooldownUntil = Date.now() + ADSBLOL_RATE_LIMIT_COOLDOWN_MS;
      console.warn("adsb.lol rate-limited; backing off");
      return [];
    }

    if (!response.ok) {
      throw new Error(`adsb.lol trace request failed with status ${response.status}`);
    }

    const data = (await response.json()) as AdsbLolTraceResponse;
    const track = convertTrace(data);

    setCachedTrace(normalized, track, track.length > 0 ? ADSBLOL_TRACE_TTL_MS : ADSBLOL_TRACE_NULL_TTL_MS);

    return track;
  })();

  traceRequests.set(normalized, request);

  try {
    return await request;
  } finally {
    traceRequests.delete(normalized);
  }
}
