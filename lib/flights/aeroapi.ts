import {
  parseLatLonPseudoCode,
  reverseGeocodeLocationLabel
} from "@/lib/flights/reverseGeocode";
import { getDiscoveryScore } from "@/lib/flights/scoring";
import { isUnlikelyToHaveAeroApiData } from "@/lib/flights/squawk";
import type { Flight } from "@/lib/flights/types";

const AEROAPI_BASE_URL = "https://aeroapi.flightaware.com/aeroapi";
const DETAIL_TTL_MS = 1000 * 60 * 2;
const DETAIL_NULL_TTL_MS = 1000 * 20;
// Why: AeroAPI's flight database fundamentally doesn't index private GA
// (N-reg etc.) Re-asking every 20s is pure waste and contributes to 429s.
// Cache the null answer for much longer.
const GA_DETAIL_NULL_TTL_MS = 1000 * 60 * 30;
// Why: route metadata (origin/destination/airline/flight number) is
// effectively immutable for the lifetime of a single flight. 10min meant
// we re-warmed any flight that drifted off the visible strip and back —
// pure waste. Bump to 2h so a flight stays cached through its whole
// time in the area; LRU caps still bound total memory.
const FEED_METADATA_TTL_MS = 1000 * 60 * 60 * 2;
// Why: misses (AeroAPI returned no current match) are *transient* — the
// flight may not yet be indexed, or our scoring may have rejected
// candidates. Caching the null answer for 2h would suppress route
// enrichment for the rest of the aircraft's time in view. Use a short
// TTL so we re-attempt soon — AeroAPI gates per-minute (not per-day), and
// the burst-control levers (WARM_TARGET=6, MAX_IMMEDIATE=2,
// SPACING=5s) handle rate, so the cost of re-asking is bounded by those
// caps rather than by the TTL.
const FEED_METADATA_NULL_TTL_MS = 1000 * 60 * 5;
const OPERATOR_TTL_MS = 1000 * 60 * 60 * 24 * 7;
// Why: 6 = batch ceiling on the immediate fetch path. MAX_IMMEDIATE is
// the actual immediate-batch size, currently 2.
const MAX_FEED_METADATA_LOOKUPS = 6;
// Why: AeroAPI's rate-limiting is per-minute and tighter than we initially
// estimated. At 4 s polling, MAX_IMMEDIATE × 15 = burst calls/min from
// the immediate path alone (excluding queue drain and selected-flight
// detail). Pulled back to 1 — top-1 strip card still gets a sync fetch
// on appearance, queue drain handles the rest. Total worst-case burst
// from feed warming: 15/min immediate + 12/min drain ≈ 27/min.
const MAX_IMMEDIATE_FEED_METADATA_LOOKUPS = 1;
// Why: 10 → 6. AeroAPI's rate-limiting is per-minute, not daily, so
// burst-control matters more than long-run total. A smaller warm target
// keeps the queue shorter and reduces per-minute pressure during fresh-
// viewport warmup. Top-6 still covers the visible top of the strip
// stack — the cards a user is likely to look at first.
const FEED_METADATA_WARM_TARGET = 6;
// Why: 3000 → 5000. Drain pacing is back to a comfortable rate
// (12 calls/min from the queue worst case vs 20). Combined with 30 min
// null caching for misses, the steady-state cost should keep us safely
// under the daily quota even with both commercial and GA in the warm pool.
const FEED_METADATA_REQUEST_SPACING_MS = 1000 * 5;
const FEED_METADATA_RATE_LIMIT_COOLDOWN_MS = 1000 * 45;
const DETAIL_RATE_LIMIT_COOLDOWN_MS = 1000 * 30;
const RATE_LIMIT_NULL_TTL_MS = 1000 * 30;
const CURRENT_RECORD_LOOKBACK_MS = 1000 * 60 * 60 * 6;
const RECENT_ARRIVAL_GRACE_MS = 1000 * 60 * 20;
const UPCOMING_DEPARTURE_WINDOW_MS = 1000 * 60 * 60 * 6;
// Why: long-running processes (and dev servers reloaded for hours) accumulate
// every flight they've ever seen if these maps are uncapped.
const DETAIL_CACHE_MAX_ENTRIES = 500;
const FEED_METADATA_CACHE_MAX_ENTRIES = 1000;
const OPERATOR_CACHE_MAX_ENTRIES = 200;
const FEED_METADATA_WARM_MAX_ENTRIES = 50;

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type AeroApiFlightResponse = {
  flights?: AeroApiFlightRecord[];
};

type AeroApiFlightRecord = {
  ident: string | null;
  ident_icao: string | null;
  ident_iata: string | null;
  fa_flight_id: string | null;
  operator: string | null;
  operator_iata: string | null;
  flight_number: string | null;
  registration: string | null;
  aircraft_type: string | null;
  blocked: boolean;
  cancelled: boolean;
  status: string | null;
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;
  actual_in: string | null;
  origin: {
    code: string | null;
    code_iata: string | null;
    code_icao: string | null;
  } | null;
  destination: {
    code: string | null;
    code_iata: string | null;
    code_icao: string | null;
  } | null;
};

type AeroApiOperatorResponse = {
  shortname: string | null;
  name: string | null;
};

type AeroApiTrackResponse = {
  positions?: Array<{
    altitude: number | null;
    groundspeed: number | null;
    heading: number | null;
    latitude: number;
    longitude: number;
    timestamp: string;
  }>;
};

export type SelectedFlightTrackPoint = {
  altitudeFeet: number | null;
  groundspeedKnots: number | null;
  heading: number | null;
  latitude: number;
  longitude: number;
  timestamp: string;
};

export type SelectedFlightDetails = {
  aircraftType: string | null;
  airline: string | null;
  destination: string | null;
  faFlightId: string | null;
  flightNumber: string | null;
  origin: string | null;
  registration: string | null;
  registeredOwner: string | null;
  status: string | null;
  track: SelectedFlightTrackPoint[];
};

export type AeroApiFeedMetadata = {
  aircraftType: string | null;
  airline: string | null;
  destination: string | null;
  flightNumber: string | null;
  origin: string | null;
  registration: string | null;
};

const detailCache = new Map<string, CacheEntry<SelectedFlightDetails | null>>();
const feedMetadataCache = new Map<string, CacheEntry<AeroApiFeedMetadata | null>>();
const operatorCache = new Map<string, CacheEntry<string | null>>();
const detailRequests = new Map<string, Promise<SelectedFlightDetails | null>>();
const feedMetadataRequests = new Map<string, Promise<AeroApiFeedMetadata | null>>();
const operatorRequests = new Map<string, Promise<string | null>>();
const feedMetadataWarmFlights = new Map<string, Flight>();
const feedMetadataWarmQueue: string[] = [];
let feedMetadataCooldownUntil = 0;
let detailCooldownUntil = 0;
let feedMetadataWarmTimer: ReturnType<typeof setTimeout> | null = null;
let lastFeedMetadataRequestAt = 0;

class AeroApiRequestError extends Error {
  path: string;
  status: number;

  constructor(path: string, status: number) {
    super(`AeroAPI request failed with status ${status} for ${path}`);
    this.name = "AeroApiRequestError";
    this.path = path;
    this.status = status;
  }
}

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const cached = cache.get(key);

  if (!cached) {
    return undefined;
  }

  if (Date.now() > cached.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  // Why: Map iteration order = insertion order. Re-inserting on read promotes
  // the entry to "most recently used," so eviction below removes cold entries.
  cache.delete(key);
  cache.set(key, cached);
  return cached.value;
}

function setCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries?: number
) {
  if (maxEntries != null && !cache.has(key) && cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value
  });
}

function getAeroApiHeaders() {
  const apiKey = process.env.AEROAPI_KEY;

  if (!apiKey) {
    return null;
  }

  return {
    "x-apikey": apiKey
  };
}

function normalizeAirportCode(input: {
  code: string | null;
  code_iata: string | null;
  code_icao: string | null;
} | null) {
  if (!input) {
    return null;
  }
  // IATA/ICAO always preferred when present.
  if (input.code_iata) return input.code_iata;
  if (input.code_icao) return input.code_icao;
  // Bare `code` is fine UNLESS it's the lat/lon pseudo-code AeroAPI emits
  // for non-airport origins (heliports, ad-hoc spots). Those get resolved
  // separately via resolveAirportOrLocationLabel — return null here so
  // the resolver kicks in.
  if (input.code && parseLatLonPseudoCode(input.code) == null) {
    return input.code;
  }
  return null;
}

// Why: AeroAPI emits "L <lat> <lon>" pseudo-codes for non-airport origins
// (heliports, helipads, fields). Reverse-geocode those into a human label
// like "Hollywood Hills" or "Cedars-Sinai" so the UI shows useful info
// instead of dropping the data. IATA/ICAO airports take priority and skip
// the geocode call.
async function resolveAirportOrLocationLabel(
  input: {
    code: string | null;
    code_iata: string | null;
    code_icao: string | null;
  } | null
): Promise<string | null> {
  if (!input) return null;
  if (input.code_iata) return input.code_iata;
  if (input.code_icao) return input.code_icao;
  if (input.code) {
    const coords = parseLatLonPseudoCode(input.code);
    if (coords) {
      return await reverseGeocodeLocationLabel(coords.latitude, coords.longitude);
    }
    return input.code;
  }
  return null;
}

function normalizedUpper(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? null;
}

function looksLikeManufacturerName(value: string | null) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toUpperCase();
  const manufacturerPrefixes = [
    "AIRBUS",
    "AGUSTA",
    "BEECH",
    "BEECHCRAFT",
    "BELL",
    "BOEING",
    "BOMBARDIER",
    "CESSNA",
    "DIAMOND",
    "EMBRAER",
    "EUROCOPTER",
    "GULFSTREAM",
    "LEONARDO",
    "MCDONNELL DOUGLAS",
    "PILATUS",
    "PIPER",
    "ROBINSON",
    "SIKORSKY",
    "TEXTRON"
  ];

  return manufacturerPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function normalizeOperatorDisplayName(value: string | null) {
  if (!value || looksLikeManufacturerName(value)) {
    return null;
  }

  return value;
}

function isLikelyGeneralAviationFlight(flight: Flight) {
  if (flight.flightNumber) {
    return false;
  }

  if (flight.airline && !looksLikeManufacturerName(flight.airline)) {
    return false;
  }

  const registration = normalizedUpper(flight.registration);
  const callsign = normalizedUpper(flight.callsign);

  if (registration?.startsWith("N")) {
    return true;
  }

  return callsign != null && /^N\d+[A-Z]{0,2}$/.test(callsign);
}

function getLookupIdentifiersForFlight(flight: Flight) {
  const identifiers = isLikelyGeneralAviationFlight(flight)
    ? [flight.registration, flight.callsign, flight.flightNumber]
    : [flight.flightNumber, flight.callsign, flight.registration];

  return Array.from(
    new Set(
      identifiers
        .filter((value): value is string => value != null && value.trim().length > 0)
        .map((value) => value.trim().toUpperCase())
    )
  );
}

function getRecordTimestampMs(value: string | null) {
  if (!value) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function isAirborneRecord(record: AeroApiFlightRecord) {
  const normalizedStatus = record.status?.toLowerCase() ?? "";

  if (normalizedStatus.includes("en route") || normalizedStatus.includes("airborne")) {
    return true;
  }

  return record.actual_out != null && record.actual_in == null;
}

function looksAirborne(flight: Flight) {
  if (flight.altitudeFeet != null && flight.altitudeFeet > 1000) {
    return true;
  }

  if (flight.groundspeedKnots != null && flight.groundspeedKnots > 80) {
    return true;
  }

  return false;
}

function hasKnownRegistrationMatch(record: AeroApiFlightRecord, flight: Flight) {
  const flightRegistration = normalizedUpper(flight.registration);

  if (!flightRegistration) {
    return true;
  }

  const recordRegistration = normalizedUpper(record.registration);
  return recordRegistration != null && recordRegistration === flightRegistration;
}

function isLikelyCurrentFlightRecord(record: AeroApiFlightRecord) {
  const now = Date.now();
  const scheduledOutMs = getRecordTimestampMs(record.estimated_out ?? record.scheduled_out);
  const actualOutMs = getRecordTimestampMs(record.actual_out);
  const actualInMs = getRecordTimestampMs(record.actual_in);
  const normalizedStatus = record.status?.toLowerCase() ?? "";

  if (record.cancelled || record.blocked) {
    return false;
  }

  if (normalizedStatus.includes("en route") || normalizedStatus.includes("airborne")) {
    return true;
  }

  if (actualOutMs != null && actualInMs == null) {
    return now - actualOutMs <= CURRENT_RECORD_LOOKBACK_MS;
  }

  if (actualInMs != null) {
    return now - actualInMs <= RECENT_ARRIVAL_GRACE_MS;
  }

  if (scheduledOutMs != null) {
    return Math.abs(scheduledOutMs - now) <= UPCOMING_DEPARTURE_WINDOW_MS;
  }

  return false;
}

function scoreFlightRecord(record: AeroApiFlightRecord, flight: Flight) {
  let score = 0;
  const flightRegistration = normalizedUpper(flight.registration);
  const recordRegistration = normalizedUpper(record.registration);

  if (
    recordRegistration != null &&
    recordRegistration === flightRegistration
  ) {
    score += 120;
  }

  if (
    flightRegistration != null &&
    recordRegistration != null &&
    recordRegistration !== flightRegistration
  ) {
    score -= isLikelyGeneralAviationFlight(flight) ? 240 : 80;
  }

  if (normalizedUpper(record.ident_icao) === normalizedUpper(flight.callsign)) {
    score += 50;
  }

  if (
    normalizedUpper(record.ident_iata) === normalizedUpper(flight.flightNumber) ||
    normalizedUpper(record.ident) === normalizedUpper(flight.flightNumber)
  ) {
    score += 40;
  }

  if (record.actual_out && !record.actual_in) {
    score += 80;
  }

  if (record.status?.toLowerCase().includes("en route")) {
    score += 45;
  }

  const scheduledOutMs = getRecordTimestampMs(record.estimated_out ?? record.scheduled_out);

  if (scheduledOutMs != null) {
    const deltaFromNowMs = Math.abs(scheduledOutMs - Date.now());

    if (deltaFromNowMs <= UPCOMING_DEPARTURE_WINDOW_MS) {
      score += 35;
    }
  }

  if (
    normalizedUpper(record.aircraft_type) != null &&
    normalizedUpper(record.aircraft_type) === normalizedUpper(flight.aircraftType)
  ) {
    score += 20;
  }

  if (normalizeAirportCode(record.origin) === flight.origin) {
    score += 10;
  }

  if (normalizeAirportCode(record.destination) === flight.destination) {
    score += 10;
  }

  if (record.origin != null) {
    score += 12;
  }

  if (record.destination != null) {
    score += 12;
  }

  if (record.status?.toLowerCase().includes("scheduled") && !record.actual_out) {
    score -= 35;
  }

  if (record.actual_in) {
    score -= 25;
  }

  if (record.cancelled) {
    score -= 100;
  }

  return score;
}

function getPreferredFlightNumber(record: AeroApiFlightRecord) {
  if (record.operator_iata && record.flight_number) {
    return `${record.operator_iata}${record.flight_number}`;
  }

  if (record.ident_iata) {
    return record.ident_iata;
  }

  if (record.operator_iata && record.ident_icao) {
    const suffix = record.ident_icao.replace(/^[A-Z]+/, "");

    if (/^\d+$/.test(suffix)) {
      return `${record.operator_iata}${suffix}`;
    }
  }

  return record.ident_icao ?? record.ident ?? null;
}

// Why: every selected-flight detail and feed-metadata warm enrichment funnels
// through `/flights/{ident}` here. Without dedup, two callers asking about
// the same DAL1061 within seconds fire two HTTP requests and burn double the
// AeroAPI quota. A short response cache (90s) covers the typical "user
// selects a flight that's also being warmed" race; in-flight coalescing
// covers the "fired in the same tick" case.
const HTTP_RESPONSE_CACHE_TTL_MS = 1000 * 90;
const HTTP_RESPONSE_CACHE_MAX_ENTRIES = 200;
const httpResponseCache = new Map<string, CacheEntry<unknown>>();
const httpInFlightRequests = new Map<string, Promise<unknown>>();

async function fetchJson<T>(
  path: string,
  options?: { bypassCache?: boolean }
): Promise<T | null> {
  const headers = getAeroApiHeaders();

  if (!headers) {
    throw new Error("Missing AeroAPI credentials");
  }

  const bypassCache = options?.bypassCache ?? false;

  if (!bypassCache) {
    const cached = getCachedValue(httpResponseCache, path);
    if (cached !== undefined) {
      return cached as T | null;
    }
  } else {
    // Why: explicit bypass — eg. user clicked "refresh." Drop any cached
    // entry so the layered detail/feed null-cache caller doesn't get a
    // stale 404/200 from this layer.
    httpResponseCache.delete(path);
  }

  const inFlight = httpInFlightRequests.get(path);
  if (inFlight) {
    return inFlight as Promise<T | null>;
  }

  const request = (async (): Promise<T | null> => {
    const response = await fetch(`${AEROAPI_BASE_URL}${path}`, {
      headers,
      cache: "no-store"
    });

    if (response.status === 404) {
      setCachedValue(httpResponseCache, path, null, HTTP_RESPONSE_CACHE_TTL_MS, HTTP_RESPONSE_CACHE_MAX_ENTRIES);
      return null;
    }

    if (!response.ok) {
      // Don't cache rate-limit or transient errors — let the caller see them
      // and apply its own cooldown.
      throw new AeroApiRequestError(path, response.status);
    }

    const data = (await response.json()) as T;
    setCachedValue(httpResponseCache, path, data, HTTP_RESPONSE_CACHE_TTL_MS, HTTP_RESPONSE_CACHE_MAX_ENTRIES);
    return data;
  })();

  httpInFlightRequests.set(path, request);

  try {
    return await request;
  } finally {
    httpInFlightRequests.delete(path);
  }
}

async function resolveOperatorName(operatorCode: string | null) {
  const normalizedCode = normalizedUpper(operatorCode);

  if (!normalizedCode) {
    return null;
  }

  const cached = getCachedValue(operatorCache, normalizedCode);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = operatorRequests.get(normalizedCode);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const data = await fetchJson<AeroApiOperatorResponse>(`/operators/${normalizedCode}`);
    const name = data?.shortname || data?.name || null;
    setCachedValue(operatorCache, normalizedCode, name, OPERATOR_TTL_MS, OPERATOR_CACHE_MAX_ENTRIES);
    return name;
  })();

  operatorRequests.set(normalizedCode, request);

  try {
    return await request;
  } finally {
    operatorRequests.delete(normalizedCode);
  }
}

async function resolveBestFlightRecord(
  flight: Flight,
  options?: { exhaustive?: boolean; requireCurrent?: boolean; bypassCache?: boolean }
) {
  const candidates: AeroApiFlightRecord[] = [];
  const exhaustive = options?.exhaustive ?? false;
  const requireCurrent = options?.requireCurrent ?? false;
  const bypassCache = options?.bypassCache ?? false;

  for (const identifier of getLookupIdentifiersForFlight(flight)) {
    const data = await fetchJson<AeroApiFlightResponse>(
      `/flights/${encodeURIComponent(identifier)}`,
      { bypassCache }
    );

    for (const candidate of data?.flights ?? []) {
      candidates.push(candidate);
    }

    if (!exhaustive && candidates.length > 0) {
      break;
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const eligibleCandidates = requireCurrent
    ? candidates.filter(isLikelyCurrentFlightRecord)
    : candidates;

  if (eligibleCandidates.length === 0) {
    return null;
  }

  const registrationMatchedCandidates =
    isLikelyGeneralAviationFlight(flight) && normalizedUpper(flight.registration) != null
      ? eligibleCandidates.filter((candidate) => hasKnownRegistrationMatch(candidate, flight))
      : eligibleCandidates;

  if (
    isLikelyGeneralAviationFlight(flight) &&
    normalizedUpper(flight.registration) != null &&
    registrationMatchedCandidates.length === 0
  ) {
    return null;
  }

  const candidatesToScore =
    looksAirborne(flight) && registrationMatchedCandidates.some(isAirborneRecord)
      ? registrationMatchedCandidates.filter(isAirborneRecord)
      : registrationMatchedCandidates;

  return [...candidatesToScore].sort(
    (left, right) => scoreFlightRecord(right, flight) - scoreFlightRecord(left, flight)
  )[0] ?? null;
}

async function fetchTrack(faFlightId: string | null) {
  if (!faFlightId) {
    return [];
  }

  const data = await fetchJson<AeroApiTrackResponse>(
    `/flights/${encodeURIComponent(faFlightId)}/track`
  );

  return (data?.positions ?? []).map((position) => ({
    altitudeFeet: position.altitude == null ? null : Math.round(position.altitude * 100),
    groundspeedKnots: position.groundspeed ?? null,
    heading: position.heading ?? null,
    latitude: position.latitude,
    longitude: position.longitude,
    timestamp: position.timestamp
  }));
}

function getDetailCacheKey(flight: Flight) {
  // Why: icao24 (flight.id) included so two distinct aircraft with the
  // same null/null/null tuple — common for TIS-B anonymous N-reg blanks
  // — don't collide in the cache. Identity-changes (callsign reassign)
  // also generate a fresh key, so old entries naturally LRU-evict.
  return [
    flight.id.toLowerCase(),
    normalizedUpper(flight.callsign) ?? "unknown",
    normalizedUpper(flight.flightNumber) ?? "unknown",
    normalizedUpper(flight.registration) ?? "unknown"
  ].join("|");
}

function getFeedMetadataCacheKey(flight: Flight) {
  return getDetailCacheKey(flight);
}

export function hasAeroApiCredentials() {
  return process.env.AEROAPI_KEY != null;
}

function isCommercialFlight(flight: Flight) {
  const callsign = normalizedUpper(flight.callsign);

  if (flight.flightNumber) {
    return true;
  }

  return callsign != null && /^[A-Z]{3}\d/.test(callsign) && !/^N\d/.test(callsign);
}

// Why: exported so discovery providers can filter out parked/long-stopped
// aircraft at the source. Threshold: on the ground + below 35 kt + below
// 250 ft = aircraft that has either just parked or is barely moving. Active
// taxi/takeoff/landing rollouts blow past 35 kt; a hovering helicopter
// reports onGround=false so it stays in the feed.
export function isStationaryOnGroundFlight(flight: Flight) {
  if (!flight.onGround) {
    return false;
  }

  const groundspeedKnots = flight.groundspeedKnots ?? 0;
  const altitudeFeet = flight.altitudeFeet ?? 0;

  return groundspeedKnots < 35 && altitudeFeet < 250;
}

function getFeedWarmPriorityRank(flight: Flight) {
  // Lower rank = warmed first.
  // Tier by phase first, then commercial-vs-GA within phase. Commercial
  // gets priority because (a) AeroAPI hit-rate is much higher for it and
  // (b) more interesting on the strip "writ large" per ranking calls.
  // GA still gets warmed — just behind commercial when both are present.
  const commercialOffset = isCommercialFlight(flight) ? 0 : 1;

  if (flight.onGround !== true) {
    return 0 + commercialOffset; // airborne: 0 (commercial) or 1 (GA)
  }
  if (isStationaryOnGroundFlight(flight)) {
    return 4 + commercialOffset; // parked: 4 (commercial) or 5 (GA)
  }
  return 2 + commercialOffset; // taxiing: 2 (commercial) or 3 (GA)
}

function needsRouteMetadata(flight: Flight) {
  return (
    flight.flightNumber == null ||
    flight.airline == null ||
    flight.origin == null ||
    flight.destination == null
  );
}

function mergeFeedMetadataIntoFlight(flight: Flight, metadata: AeroApiFeedMetadata | null | undefined) {
  if (!metadata) {
    return flight;
  }

  return {
    ...flight,
    airline: metadata.airline ?? flight.airline,
    destination: metadata.destination ?? flight.destination,
    flightNumber: metadata.flightNumber ?? flight.flightNumber,
    origin: metadata.origin ?? flight.origin,
    aircraftType: metadata.aircraftType ?? flight.aircraftType,
    registration: metadata.registration ?? flight.registration
  };
}

async function fetchAeroApiFeedMetadata(flight: Flight): Promise<AeroApiFeedMetadata | null> {
  const cacheKey = getFeedMetadataCacheKey(flight);
  const cached = getCachedValue(feedMetadataCache, cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = feedMetadataRequests.get(cacheKey);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const bestMatch = await resolveBestFlightRecord(flight, { requireCurrent: true });

    if (!bestMatch) {
      setCachedValue(feedMetadataCache, cacheKey, null, FEED_METADATA_NULL_TTL_MS, FEED_METADATA_CACHE_MAX_ENTRIES);
      return null;
    }

    // Why: parallel resolution. Both origin and destination may need a
    // reverse-geocode if they're lat/lon pseudo-codes; running them in
    // parallel keeps the worst-case enrichment latency one Nominatim
    // call instead of two.
    const [origin, destination] = await Promise.all([
      resolveAirportOrLocationLabel(bestMatch.origin),
      resolveAirportOrLocationLabel(bestMatch.destination)
    ]);

    const metadata: AeroApiFeedMetadata = {
      aircraftType: null,
      airline: normalizeOperatorDisplayName(bestMatch.operator) ?? flight.airline,
      destination,
      flightNumber: getPreferredFlightNumber(bestMatch),
      origin,
      registration: null
    };

    setCachedValue(feedMetadataCache, cacheKey, metadata, FEED_METADATA_TTL_MS, FEED_METADATA_CACHE_MAX_ENTRIES);
    return metadata;
  })();

  feedMetadataRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    feedMetadataRequests.delete(cacheKey);
  }
}

function scheduleFeedMetadataWarmPump() {
  if (feedMetadataWarmTimer != null || feedMetadataWarmQueue.length === 0) {
    return;
  }

  const delayMs =
    Date.now() < feedMetadataCooldownUntil
      ? feedMetadataCooldownUntil - Date.now()
      : Math.max(0, FEED_METADATA_REQUEST_SPACING_MS - (Date.now() - lastFeedMetadataRequestAt));

  feedMetadataWarmTimer = setTimeout(() => {
    feedMetadataWarmTimer = null;
    void drainFeedMetadataWarmQueue();
  }, delayMs);
}

async function drainFeedMetadataWarmQueue() {
  if (Date.now() < feedMetadataCooldownUntil) {
    scheduleFeedMetadataWarmPump();
    return;
  }

  while (feedMetadataWarmQueue.length > 0) {
    const cacheKey = feedMetadataWarmQueue.shift();

    if (!cacheKey) {
      continue;
    }

    const flight = feedMetadataWarmFlights.get(cacheKey);
    feedMetadataWarmFlights.delete(cacheKey);

    if (!flight || getCachedValue(feedMetadataCache, cacheKey) !== undefined) {
      continue;
    }

    try {
      lastFeedMetadataRequestAt = Date.now();
      await fetchAeroApiFeedMetadata(flight);
    } catch (error) {
      if (error instanceof AeroApiRequestError && error.status === 429) {
        feedMetadataCooldownUntil = Date.now() + FEED_METADATA_RATE_LIMIT_COOLDOWN_MS;
        setCachedValue(feedMetadataCache, cacheKey, null, RATE_LIMIT_NULL_TTL_MS, FEED_METADATA_CACHE_MAX_ENTRIES);
        console.warn("AeroAPI feed enrichment rate limited; cooling down strip enrichment", {
          flightId: flight.id,
          callsign: flight.callsign
        });
      } else {
        console.error("Failed to warm AeroAPI feed metadata", {
          flightId: flight.id,
          callsign: flight.callsign,
          error
        });
      }

      break;
    }

    break;
  }

  if (feedMetadataWarmQueue.length > 0) {
    scheduleFeedMetadataWarmPump();
  }
}

function queueFeedMetadataWarm(flights: Flight[]) {
  const prioritizedCacheKeys: string[] = [];

  for (const flight of flights) {
    const cacheKey = getFeedMetadataCacheKey(flight);

    if (getCachedValue(feedMetadataCache, cacheKey) !== undefined) {
      continue;
    }

    prioritizedCacheKeys.push(cacheKey);
    feedMetadataWarmFlights.set(cacheKey, flight);
  }

  // Why: cap the warm-flights map. If the queue grows faster than it drains
  // (e.g., long cooldown, low-traffic backend), drop the oldest pending entries.
  if (feedMetadataWarmFlights.size > FEED_METADATA_WARM_MAX_ENTRIES) {
    const overflow = feedMetadataWarmFlights.size - FEED_METADATA_WARM_MAX_ENTRIES;
    const droppedKeys: string[] = [];
    const iterator = feedMetadataWarmFlights.keys();
    for (let i = 0; i < overflow; i += 1) {
      const next = iterator.next();
      if (next.done || next.value == null) break;
      droppedKeys.push(next.value);
    }
    for (const key of droppedKeys) {
      feedMetadataWarmFlights.delete(key);
    }
    if (droppedKeys.length > 0) {
      const droppedSet = new Set(droppedKeys);
      for (let i = feedMetadataWarmQueue.length - 1; i >= 0; i -= 1) {
        if (droppedSet.has(feedMetadataWarmQueue[i]!)) {
          feedMetadataWarmQueue.splice(i, 1);
        }
      }
    }
  }

  if (prioritizedCacheKeys.length > 0) {
    const prioritizedSet = new Set(prioritizedCacheKeys);
    const nextQueue = [
      ...prioritizedCacheKeys,
      ...feedMetadataWarmQueue.filter((cacheKey) => !prioritizedSet.has(cacheKey))
    ];

    feedMetadataWarmQueue.length = 0;
    feedMetadataWarmQueue.push(...nextQueue);
  }

  scheduleFeedMetadataWarmPump();
}

export async function fetchAeroApiFeedMetadataBatch(flights: Flight[]) {
  const results: Record<string, AeroApiFeedMetadata> = {};

  if (Date.now() < feedMetadataCooldownUntil) {
    return results;
  }

  const limitedFlights = flights.slice(0, MAX_FEED_METADATA_LOOKUPS);

  for (const flight of limitedFlights) {
    try {
      const metadata = await fetchAeroApiFeedMetadata(flight);

      if (metadata) {
        results[flight.id] = metadata;
      }
    } catch (error) {
      if (error instanceof AeroApiRequestError && error.status === 429) {
        feedMetadataCooldownUntil = Date.now() + FEED_METADATA_RATE_LIMIT_COOLDOWN_MS;
        console.warn("AeroAPI feed enrichment rate limited; cooling down strip enrichment", {
          flightId: flight.id,
          callsign: flight.callsign
        });
        break;
      }

      console.error("Failed to fetch AeroAPI feed metadata", {
        flightId: flight.id,
        callsign: flight.callsign,
        error
      });
    }
  }

  return results;
}

export function primeAeroApiFeedMetadata(
  flight: Flight,
  metadata: Pick<AeroApiFeedMetadata, "airline" | "destination" | "flightNumber" | "origin">
) {
  const value: AeroApiFeedMetadata = {
    aircraftType: null,
    airline: metadata.airline ?? null,
    destination: metadata.destination ?? null,
    flightNumber: metadata.flightNumber ?? null,
    origin: metadata.origin ?? null,
    registration: null
  };

  if (
    value.airline == null &&
    value.destination == null &&
    value.flightNumber == null &&
    value.origin == null
  ) {
    return;
  }

  setCachedValue(feedMetadataCache, getFeedMetadataCacheKey(flight), value, FEED_METADATA_TTL_MS, FEED_METADATA_CACHE_MAX_ENTRIES);
}

export async function enrichFlightsWithAeroApiMetadata(
  flights: Flight[],
  options?: {
    warm?: boolean;
    center?: { latitude: number; longitude: number };
  }
) {
  if (!hasAeroApiCredentials() || flights.length === 0) {
    return flights;
  }

  const warm = options?.warm ?? true;
  const center = options?.center;

  const mergedFlights = flights.map((flight) =>
    mergeFeedMetadataIntoFlight(flight, getCachedValue(feedMetadataCache, getFeedMetadataCacheKey(flight)))
  );

  if (!warm) {
    return mergedFlights;
  }

  if (Date.now() < feedMetadataCooldownUntil) {
    return mergedFlights;
  }

  // Why: route the AeroAPI warm budget by likelihood of finding data.
  //   • Squawk 1200 / SoCal VFR range → known no plan, skip.
  //   • Null squawk + GA-pattern callsign → almost certainly a quiet
  //     VFR Cessna or small helo. Investigation showed AeroAPI only
  //     returns the same origin we'd already infer from the track,
  //     plus minor takeoff time/runway info — not worth a quota slot.
  //   • Anything else (commercial callsign, OR null squawk + commercial
  //     identity, OR any flight with a non-VFR squawk) → worth a try.
  //     Catches IFR-GA (biz jets, charter, LAPD on discrete IFR codes).
  const unresolvedFlights = mergedFlights.filter(
    (flight) =>
      !isUnlikelyToHaveAeroApiData(flight) &&
      needsRouteMetadata(flight) &&
      !isStationaryOnGroundFlight(flight)
  );

  if (unresolvedFlights.length === 0) {
    return mergedFlights;
  }

  // Why: priority for warming = same tiered scoring used elsewhere
  // (lib/flights/scoring.ts). Magic zone (≤ 8 mi) wins regardless of
  // commercial vs GA, so the closest aircraft to home base get warmed
  // first — that's what the user actually wants. Beyond the magic
  // zone, commercial naturally beats GA via the −12 mi commercial
  // bonus. Falls back to phase-rank if center isn't supplied (defensive
  // — every caller currently supplies it).
  const targetFlights = [...unresolvedFlights]
    .sort((left, right) =>
      center
        ? getDiscoveryScore(left, center) - getDiscoveryScore(right, center)
        : getFeedWarmPriorityRank(left) - getFeedWarmPriorityRank(right)
    )
    .slice(0, FEED_METADATA_WARM_TARGET);

  const immediateFlights = targetFlights
    .filter((flight) => getCachedValue(feedMetadataCache, getFeedMetadataCacheKey(flight)) === undefined)
    .slice(0, MAX_IMMEDIATE_FEED_METADATA_LOOKUPS);

  let nextFlights = mergedFlights;

  if (immediateFlights.length > 0) {
    const metadataById = await fetchAeroApiFeedMetadataBatch(immediateFlights);

    if (Object.keys(metadataById).length > 0) {
      nextFlights = mergedFlights.map((flight) =>
        mergeFeedMetadataIntoFlight(flight, metadataById[flight.id])
      );
    }
  }

  const flightsToWarm = targetFlights
    .filter((flight) => getCachedValue(feedMetadataCache, getFeedMetadataCacheKey(flight)) === undefined)
    .slice(MAX_IMMEDIATE_FEED_METADATA_LOOKUPS);

  if (flightsToWarm.length > 0) {
    queueFeedMetadataWarm(flightsToWarm);
  }

  return nextFlights;
}

export async function fetchAeroApiSelectedFlightDetails(
  flight: Flight,
  options?: { bypassCache?: boolean; skipTrack?: boolean }
): Promise<SelectedFlightDetails | null> {
  const cacheKey = getDetailCacheKey(flight);
  const bypassCache = options?.bypassCache ?? false;
  const skipTrack = options?.skipTrack ?? false;
  const cached = bypassCache ? undefined : getCachedValue(detailCache, cacheKey);

  // Why: serve cached data even during a rate-limit cooldown — we already paid
  // for it, and returning null here would needlessly blank the selected card.
  if (cached !== undefined) {
    return cached;
  }

  // Why: previously we short-circuited GA entirely on the assumption that
  // AeroAPI never has data for N-reg flights. That's mostly true for VFR
  // pattern work, but it also blocks the cases that DO file plans and
  // therefore DO show up in AeroAPI: LAPD/sheriff helicopters, IFR GA
  // cross-countries, charter under N-callsigns, SMO commuter ops. The
  // long null-TTL below (GA_DETAIL_NULL_TTL_MS) means an unfiled Cessna
  // that misses still doesn't re-hit AeroAPI for 30 min, so we get the
  // benefit of trying without the cost of spamming.
  if (Date.now() < detailCooldownUntil) {
    return null;
  }

  const inFlightRequest = detailRequests.get(cacheKey);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    try {
      const currentBestMatch = await resolveBestFlightRecord(flight, {
        exhaustive: true,
        requireCurrent: true,
        bypassCache
      });

      if (!currentBestMatch) {
        // GA gets the long null TTL — most N-reg pattern Cessnas have no
        // filed plan and won't ever get one this session, so caching the
        // miss for 30 min prevents AeroAPI spam on repeated selections.
        // Commercial misses keep the short TTL because their state (filed
        // vs unfiled, FA-flight-id assignment) can change quickly.
        const nullTtlMs = isLikelyGeneralAviationFlight(flight)
          ? GA_DETAIL_NULL_TTL_MS
          : DETAIL_NULL_TTL_MS;
        setCachedValue(detailCache, cacheKey, null, nullTtlMs, DETAIL_CACHE_MAX_ENTRIES);
        return null;
      }

      // Why: when skipTrack is set, callers (the selected-flight route)
      // are getting their track from a richer source like adsb.lol
      // (community ADS-B, full current-leg pruned) and don't need to
      // burn an AeroAPI track-fetch quota call here. Saves
      // /flights/{faFlightId}/track per selection — meaningful given
      // AeroAPI's tight rate limit on personal tiers.
      const [operatorName, track, origin, destination] = await Promise.all([
        resolveOperatorName(currentBestMatch.operator_iata || currentBestMatch.operator).catch(
          (error) => {
            console.warn("AeroAPI operator enrichment failed for selected flight", {
              flightId: flight.id,
              callsign: flight.callsign,
              error
            });
            return null;
          }
        ),
        skipTrack
          ? Promise.resolve<SelectedFlightTrackPoint[]>([])
          : fetchTrack(currentBestMatch.fa_flight_id).catch((error) => {
              console.warn("AeroAPI track enrichment failed for selected flight", {
                flightId: flight.id,
                callsign: flight.callsign,
                error
              });
              return [];
            }),
        resolveAirportOrLocationLabel(currentBestMatch.origin),
        resolveAirportOrLocationLabel(currentBestMatch.destination)
      ]);
      const normalizedOperatorName =
        normalizeOperatorDisplayName(operatorName) ??
        normalizeOperatorDisplayName(currentBestMatch.operator);

      const details: SelectedFlightDetails = {
        aircraftType: currentBestMatch.aircraft_type ?? null,
        airline: normalizedOperatorName ?? flight.airline,
        destination,
        faFlightId: currentBestMatch.fa_flight_id ?? null,
        flightNumber: getPreferredFlightNumber(currentBestMatch),
        origin,
        registration: currentBestMatch.registration ?? null,
        registeredOwner: flight.registeredOwner,
        status: currentBestMatch.status ?? null,
        track
      };

      setCachedValue(detailCache, cacheKey, details, DETAIL_TTL_MS, DETAIL_CACHE_MAX_ENTRIES);

      return details;
    } catch (error) {
      if (error instanceof AeroApiRequestError && error.status === 429) {
        detailCooldownUntil = Date.now() + DETAIL_RATE_LIMIT_COOLDOWN_MS;
        setCachedValue(detailCache, cacheKey, null, RATE_LIMIT_NULL_TTL_MS, DETAIL_CACHE_MAX_ENTRIES);
        console.warn("AeroAPI selected-flight enrichment rate limited; cooling down", {
          flightId: flight.id,
          callsign: flight.callsign
        });
        return null;
      }

      throw error;
    }
  })();

  detailRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    detailRequests.delete(cacheKey);
  }
}
