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
// `https://globe.adsb.lol/data/traces/<bucket>/trace_full_<icao>.json`,
// where bucket is the last two hex characters of the icao24. Coverage
// for GA is significantly better than OpenSky's `/tracks/all` because
// volunteer feeders pick up low-altitude and uncontrolled-airspace
// traffic that the commercial network often misses.
//
// The trace is the readsb/tar1090 format: an array of point arrays,
// each `[seconds_since_base_ts, lat, lon, alt_ft|"ground", gs_kt,
// track_deg, flags, vert_rate, ext_obj_or_null, source_or_null]`.
// We pull the `full` variant (whole-day, ~100-200 KB) and prune to
// the *current leg only* — see isolateCurrentLeg below. This gives
// the user the entire flight from departure even if they tuned in
// mid-route, while excluding earlier legs the same airframe flew
// today (a short-haul jet may do 4 legs in a day; we want the one
// it's on now).

const ADSBLOL_TRACE_BASE = "https://globe.adsb.lol/data/traces";
const ADSBLOL_TRACE_TTL_MS = 1000 * 60 * 2;
const ADSBLOL_TRACE_NULL_TTL_MS = 1000 * 60 * 5;
const ADSBLOL_TRACE_CACHE_MAX_ENTRIES = 500;
const ADSBLOL_RATE_LIMIT_COOLDOWN_MS = 1000 * 30;
// Why: 15 min on the ground (or below 100 ft + < 35 kt) between active
// segments marks a leg break. A normal landing rollout / brief taxi
// is well under 15 min; a between-leg parking stop is well over.
const ADSBLOL_LEG_BREAK_THRESHOLD_SEC = 15 * 60;
// Why: helicopters and other rotorcraft commonly operate from elevated
// pads (rooftops, hilltop heliports) where the parked altitude is
// reported as 1000-1500 ft AGL — well above our 200 ft "near ground"
// floor. So a multi-hour ADS-B silence followed by re-emergence at
// hover-speed altitudes won't trigger the gap-with-ground-touch rule
// above, and the previous leg's path bleeds into the new one. A gap
// this long is a leg break regardless of altitude — even the longest
// transoceanic cruise gap (SIA7402's ~459 min Pacific dropout) is
// over 33k ft, so altitude-aware rules still distinguish that case
// at shorter thresholds. One hour is a comfortable margin: way longer
// than any plausible domestic ADS-B coverage hole, way shorter than
// any meaningful parking turnaround.
const ADSBLOL_LONG_GAP_LEG_BREAK_THRESHOLD_SEC = 60 * 60;

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

function isStationaryTracePoint(point: AdsbLolTracePoint) {
  const [, , , altitude, groundspeed] = point;
  const onGroundOrLow =
    altitude === "ground" ||
    (typeof altitude === "number" && Number.isFinite(altitude) && altitude < 100);
  const slow =
    typeof groundspeed !== "number" ||
    !Number.isFinite(groundspeed) ||
    groundspeed < 35;
  return onGroundOrLow && slow;
}

// Why: a point reported as "ground" or below ~200 ft is, for our purposes,
// "the aircraft has landed / is on the surface." Used by the gap-based leg
// break detector to distinguish parking gaps (engine off, ADS-B silent on
// the ramp) from cruise gaps (over-ocean feeder coverage holes).
function isOnOrNearGround(point: AdsbLolTracePoint) {
  const altitude = point[3];
  return (
    altitude === "ground" ||
    (typeof altitude === "number" && Number.isFinite(altitude) && altitude < 200)
  );
}

// Why: trace_full covers the entire UTC day. For an airframe that's flown
// multiple legs today, we only want the *current* leg's path.
//
// Two leg-break signals, both required for robust helicopter + airline
// coverage:
//
//   (A) **Sustained stationary** — a run of consecutive points marked
//       on-ground / low-alt and slow, lasting >= 15 min. This catches
//       aircraft that keep transmitting while parked (most airliners on
//       the ramp).
//
//   (B) **Coverage gap with a ground touch** — a >= 15 min wall-clock gap
//       between consecutive trace points, where AT LEAST ONE side of the
//       gap is on or near the ground. This catches aircraft that shut down
//       between flights and stop transmitting entirely (most helicopters,
//       light GA, some regional jets). The ground-touch requirement
//       prevents long over-ocean cruise gaps from being mistaken for leg
//       breaks — SIA7402 had a 459-min Pacific gap at 33k -> 37k feet that
//       was a single continuous flight, not a leg break.
//
// Important: a "leg break" arms the slicer, but the actual *new leg start*
// is the next transition back to airborne. If the aircraft resumes
// transmitting still on the ground (e.g., cold-start at the gate, then
// taxi for several minutes before takeoff), we wait for the takeoff to
// mark the leg start. Otherwise the slice would include the post-gap
// ground portion and — more importantly — would draw a connecting line
// from the post-gap ground point back through the previous leg's path,
// because consecutive trace points get joined in the rendered LineString.
function isolateCurrentLeg(trace: AdsbLolTracePoint[]): AdsbLolTracePoint[] {
  if (trace.length === 0) return trace;

  let lastLegStartIdx = 0;
  let stationaryStartIdx: number | null = null;
  // Set when we've seen a leg-break signal (gap or sustained stationary)
  // but the trace hasn't yet returned to airborne. The next non-stationary
  // point will be marked as the new leg start.
  let pendingLegBreak = false;

  for (let i = 0; i < trace.length; i += 1) {
    const point = trace[i]!;
    const prev = i > 0 ? trace[i - 1]! : null;

    // (B) Coverage gap with a ground touch — or any gap so long it can
    // only be a leg break (helicopter at elevated heliport, cold airframe
    // restart, etc.).
    if (prev) {
      const gapSec = point[0] - prev[0];
      const isLongGap = gapSec >= ADSBLOL_LONG_GAP_LEG_BREAK_THRESHOLD_SEC;
      const isShortGapWithGroundTouch =
        gapSec >= ADSBLOL_LEG_BREAK_THRESHOLD_SEC &&
        (isOnOrNearGround(prev) || isOnOrNearGround(point));
      if (isLongGap || isShortGapWithGroundTouch) {
        if (isStationaryTracePoint(point)) {
          // Gap ended while still on the ground (cold-start, pre-takeoff
          // taxi, etc.). Defer the leg-start marker until takeoff.
          pendingLegBreak = true;
          stationaryStartIdx = null;
        } else {
          // Gap ended airborne (post-gap takeoff, or coverage hole that
          // resolved mid-air). New leg starts here.
          lastLegStartIdx = i;
          stationaryStartIdx = null;
          pendingLegBreak = false;
        }
        continue;
      }
    }

    // (A) Sustained stationary run.
    if (isStationaryTracePoint(point)) {
      // While a pending leg break is held, don't restart stationary
      // tracking — we already know the next airborne point starts a leg.
      if (stationaryStartIdx === null && !pendingLegBreak) {
        stationaryStartIdx = i;
      }
      continue;
    }

    // Non-stationary (airborne or active rollout / climb).
    if (pendingLegBreak) {
      lastLegStartIdx = i;
      pendingLegBreak = false;
      stationaryStartIdx = null;
      continue;
    }

    if (stationaryStartIdx !== null) {
      const stationaryDurationSec = point[0] - trace[stationaryStartIdx]![0];
      if (stationaryDurationSec >= ADSBLOL_LEG_BREAK_THRESHOLD_SEC) {
        lastLegStartIdx = i;
      }
      stationaryStartIdx = null;
    }
  }

  return lastLegStartIdx === 0 ? trace : trace.slice(lastLegStartIdx);
}

// Why: each adsb.lol trace response carries its own `timestamp` base and
// per-point offsets are relative to it. To merge full + recent we re-base
// the recent points onto full's timestamp by shifting their offsets by
// `recent.timestamp - full.timestamp` (positive when recent is newer,
// which is the normal case).
// Why: discriminated union so callers can distinguish "aircraft not in the
// network" (404, cache empty) from "we got rate-limited" (don't cache,
// retry after cooldown) from "we have data."
type AdsbLolTraceVariantResult =
  | { kind: "ok"; response: AdsbLolTraceResponse }
  | { kind: "missing" }
  | { kind: "rate-limited" };

async function fetchAdsbLolTraceVariant(url: string): Promise<AdsbLolTraceVariantResult> {
  const response = await fetch(url, {
    cache: "no-store",
    // Why: adsb.lol's CDN serves these files gzipped; node-fetch handles
    // decompression automatically with this header. Be a polite client.
    headers: { "User-Agent": "flight-tracker/0.1 (+ambient airspace)" }
  });

  if (response.status === 404) {
    return { kind: "missing" };
  }
  if (response.status === 429) {
    return { kind: "rate-limited" };
  }
  if (!response.ok) {
    throw new Error(`adsb.lol trace request to ${url} failed with status ${response.status}`);
  }

  return { kind: "ok", response: (await response.json()) as AdsbLolTraceResponse };
}

function rebaseTracePoint(
  point: AdsbLolTracePoint,
  offsetDeltaSec: number
): AdsbLolTracePoint {
  return [
    point[0] + offsetDeltaSec,
    point[1],
    point[2],
    point[3],
    point[4],
    point[5],
    point[6],
    point[7],
    point[8],
    point[9]
  ];
}

// Why: trace_full covers the full UTC day but its tail can lag the live
// position by 20+ minutes — adsb.lol regenerates the file periodically,
// not real-time. trace_recent is short (~last hour) and updated near
// real-time (~30s lag). Merging gives us deep history AND a fresh tail.
// Strategy: take all of full, then append recent points whose absolute
// time is strictly later than full's last point. The trim-by-time merge
// is order-preserving and avoids duplicates from the overlap window.
function mergeTraceResponses(
  full: AdsbLolTraceResponse | null,
  recent: AdsbLolTraceResponse | null
): AdsbLolTraceResponse | null {
  if (!full && !recent) return null;
  if (!full) return recent;
  if (!recent || recent.trace.length === 0) return full;

  if (full.trace.length === 0) {
    return {
      ...full,
      trace: recent.trace.map((p) => rebaseTracePoint(p, recent.timestamp - full.timestamp))
    };
  }

  const fullLast = full.trace[full.trace.length - 1]!;
  const lastFullAbsoluteSec = full.timestamp + fullLast[0];
  const offsetDeltaSec = recent.timestamp - full.timestamp;

  const appended: AdsbLolTracePoint[] = [];
  for (const point of recent.trace) {
    const absoluteSec = recent.timestamp + point[0];
    if (absoluteSec <= lastFullAbsoluteSec) continue;
    appended.push(rebaseTracePoint(point, offsetDeltaSec));
  }

  if (appended.length === 0) return full;
  return { ...full, trace: [...full.trace, ...appended] };
}

function convertTrace(response: AdsbLolTraceResponse): SelectedFlightTrackPoint[] {
  const baseSec = response.timestamp;
  if (!Number.isFinite(baseSec)) return [];

  const currentLeg = isolateCurrentLeg(response.trace);

  return currentLeg
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
    const bucket = getBucket(normalized);
    const fullUrl = `${ADSBLOL_TRACE_BASE}/${bucket}/trace_full_${normalized}.json`;
    const recentUrl = `${ADSBLOL_TRACE_BASE}/${bucket}/trace_recent_${normalized}.json`;

    // Why: trace_full's tail can lag the live position by tens of minutes
    // because adsb.lol regenerates the daily file periodically, not in real
    // time. trace_recent is small (~3 KB) and updated continuously. Fetch
    // both in parallel — they're cheap and the merge gives us deep history
    // PLUS a tail within ~1 min of live. Each is independently fault-tolerant:
    // 404 => null, network error => null, rate-limit short-circuits both.
    const [fullResult, recentResult] = await Promise.all([
      fetchAdsbLolTraceVariant(fullUrl).catch((error) => {
        console.error("adsb.lol trace_full fetch failed", error);
        return { kind: "missing" } as const;
      }),
      fetchAdsbLolTraceVariant(recentUrl).catch((error) => {
        console.error("adsb.lol trace_recent fetch failed", error);
        return { kind: "missing" } as const;
      })
    ]);

    if (fullResult.kind === "rate-limited" || recentResult.kind === "rate-limited") {
      cooldownUntil = Date.now() + ADSBLOL_RATE_LIMIT_COOLDOWN_MS;
      console.warn("adsb.lol rate-limited; backing off");
      // Don't cache — we want to retry after cooldown rather than return
      // empty for the full ADSBLOL_TRACE_NULL_TTL_MS window.
      return [];
    }

    const full = fullResult.kind === "ok" ? fullResult.response : null;
    const recent = recentResult.kind === "ok" ? recentResult.response : null;

    if (!full && !recent) {
      // Aircraft not seen by adsb.lol's network at all. Cache the negative
      // briefly and move on.
      setCachedTrace(normalized, [], ADSBLOL_TRACE_NULL_TTL_MS);
      return [];
    }

    const merged = mergeTraceResponses(full, recent);
    if (!merged || merged.trace.length === 0) {
      setCachedTrace(normalized, [], ADSBLOL_TRACE_NULL_TTL_MS);
      return [];
    }

    const track = convertTrace(merged);
    setCachedTrace(
      normalized,
      track,
      track.length > 0 ? ADSBLOL_TRACE_TTL_MS : ADSBLOL_TRACE_NULL_TTL_MS
    );
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
