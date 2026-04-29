import type { SelectedFlightTrackPoint } from "@/lib/flights/aeroapi";
import {
  enrichFlightsWithAeroApiMetadata,
  isStationaryOnGroundFlight
} from "@/lib/flights/aeroapi";
import { enrichFlightsWithAdsbdbFallback } from "@/lib/flights/adsbdb";
import type { FlightArea } from "@/lib/flights/opensky";
import type { Flight } from "@/lib/flights/types";
import { distanceBetweenPointsMiles } from "@/lib/geo";

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

// ---------------------------------------------------------------------
// Bounding-box discovery
// ---------------------------------------------------------------------

const ADSBLOL_AREA_BASE = "https://api.adsb.lol/v2/lat";
const ADSBLOL_DISCOVERY_TIMEOUT_MS = 6000;
const ADSBLOL_DISCOVERY_FRESH_MAX_SEC = 60;
// Why: adsb.lol's API expresses radius in nautical miles. Our app config
// (and OpenSky parity) uses statute miles, so convert at the boundary.
const STATUTE_MILES_PER_NAUTICAL_MILE = 1.15077945;
const DISCOVERY_FLIGHT_CANDIDATE_LIMIT = 80;

type AdsbLolAreaAircraft = {
  hex: string;
  flight?: string | null;
  r?: string | null;
  t?: string | null;
  desc?: string | null;
  ownOp?: string | null;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground" | null;
  alt_geom?: number | null;
  gs?: number | null;
  track?: number | null;
  true_heading?: number | null;
  squawk?: string | null;
  seen?: number | null;
  seen_pos?: number | null;
};

type AdsbLolAreaResponse = {
  ac?: AdsbLolAreaAircraft[];
  now?: number;
  total?: number;
};

function normalizeCallsign(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Unknown";
}

function adsbLolAircraftToFlight(
  aircraft: AdsbLolAreaAircraft,
  responseNowMs: number
): Flight | null {
  if (
    !aircraft.hex ||
    typeof aircraft.lat !== "number" ||
    typeof aircraft.lon !== "number" ||
    !Number.isFinite(aircraft.lat) ||
    !Number.isFinite(aircraft.lon)
  ) {
    return null;
  }

  const onGround = aircraft.alt_baro === "ground";
  const altitudeFeet =
    typeof aircraft.alt_baro === "number" && Number.isFinite(aircraft.alt_baro)
      ? aircraft.alt_baro
      : typeof aircraft.alt_geom === "number" && Number.isFinite(aircraft.alt_geom)
        ? aircraft.alt_geom
        : null;

  const positionTimestampSec =
    typeof aircraft.seen_pos === "number" && Number.isFinite(aircraft.seen_pos)
      ? Math.round((responseNowMs - aircraft.seen_pos * 1000) / 1000)
      : null;
  const lastContactTimestampSec =
    typeof aircraft.seen === "number" && Number.isFinite(aircraft.seen)
      ? Math.round((responseNowMs - aircraft.seen * 1000) / 1000)
      : positionTimestampSec;

  return {
    id: aircraft.hex.trim().toLowerCase(),
    latitude: aircraft.lat,
    longitude: aircraft.lon,
    callsign: normalizeCallsign(aircraft.flight),
    onGround: onGround ? true : altitudeFeet == null ? null : false,
    flightNumber: null,
    airline: null,
    aircraftType: aircraft.t?.trim() || null,
    origin: null,
    destination: null,
    altitudeFeet,
    groundspeedKnots:
      typeof aircraft.gs === "number" && Number.isFinite(aircraft.gs)
        ? Math.round(aircraft.gs)
        : null,
    headingDegrees:
      typeof aircraft.track === "number" && Number.isFinite(aircraft.track)
        ? aircraft.track
        : typeof aircraft.true_heading === "number" && Number.isFinite(aircraft.true_heading)
          ? aircraft.true_heading
          : null,
    positionTimestampSec,
    lastContactTimestampSec,
    registration: aircraft.r?.trim() || null,
    // Why: `ownOp` from adsb.lol is the registered operator (e.g.,
    // "LAPD AIR SUPPORT DIVISION") — equivalent to ADSBdb's
    // registered_owner. Use it directly to skip an ADSBdb hit.
    registeredOwner: aircraft.ownOp?.trim() || null
  };
}

function isCommercialIdentity(flight: Flight) {
  const callsign = flight.callsign.trim().toUpperCase();
  return /^[A-Z]{3}\d/.test(callsign) && !/^N\d/.test(callsign);
}

function getDiscoveryScore(flight: Flight, area: FlightArea) {
  let score = distanceBetweenPointsMiles({
    fromLatitude: area.center.latitude,
    fromLongitude: area.center.longitude,
    toLatitude: flight.latitude,
    toLongitude: flight.longitude
  });

  if (flight.onGround) {
    score += isCommercialIdentity(flight) ? 6 : 16;
  }

  if (flight.altitudeFeet != null && flight.altitudeFeet < 1500 && !flight.onGround) {
    score -= 1.5;
  }

  if (flight.groundspeedKnots != null && flight.groundspeedKnots > 180) {
    score -= 0.5;
  }

  if (isCommercialIdentity(flight)) {
    score -= 0.75;
  }

  return score;
}

export async function fetchAdsbLolFlights(
  area: FlightArea,
  options?: { warmAeroApiFeed?: boolean }
): Promise<Flight[]> {
  const radiusNm = Math.max(1, Math.round(area.radiusMiles / STATUTE_MILES_PER_NAUTICAL_MILE));
  const url = `${ADSBLOL_AREA_BASE}/${area.center.latitude}/lon/${area.center.longitude}/dist/${radiusNm}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), ADSBLOL_DISCOVERY_TIMEOUT_MS);

  let data: AdsbLolAreaResponse;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "flight-tracker/0.1 (+ambient airspace)" },
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new Error(`adsb.lol discovery failed with status ${response.status}`);
    }

    data = (await response.json()) as AdsbLolAreaResponse;
  } finally {
    clearTimeout(timeoutId);
  }

  const responseNowMs =
    typeof data.now === "number" && Number.isFinite(data.now) ? data.now : Date.now();

  const flights = (data.ac ?? [])
    .filter((aircraft) => {
      // Why: adsb.lol's response can include aircraft that haven't
      // reported a position recently. Treat anything older than a
      // minute as stale to keep the live feed clean.
      if (typeof aircraft.seen_pos === "number" && aircraft.seen_pos > ADSBLOL_DISCOVERY_FRESH_MAX_SEC) {
        return false;
      }
      return true;
    })
    .map((aircraft) => adsbLolAircraftToFlight(aircraft, responseNowMs))
    .filter((flight): flight is Flight => flight != null)
    // Why: drop parked / barely-moving aircraft at the source. With
    // adsb.lol's much denser feed (esp. at major airports like LAX),
    // dozens of stationary aircraft would otherwise crowd the strip
    // and the map. Aircraft taxiing > 35 kt or rolling out from a
    // landing remain in the feed.
    .filter((flight) => !isStationaryOnGroundFlight(flight))
    .sort((left, right) => getDiscoveryScore(left, area) - getDiscoveryScore(right, area))
    .slice(0, DISCOVERY_FLIGHT_CANDIDATE_LIMIT);

  return enrichFlightsWithAeroApiMetadata(enrichFlightsWithAdsbdbFallback(flights), {
    warm: options?.warmAeroApiFeed ?? true
  });
}
