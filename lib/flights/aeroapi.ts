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
// TTL so we re-attempt soon.
const FEED_METADATA_NULL_TTL_MS = 1000 * 60 * 5;
const OPERATOR_TTL_MS = 1000 * 60 * 60 * 24 * 7;
// Why: tuned to stay well under typical AeroAPI rate limits (~10 req/min on
// personal tiers). 6 warm targets * (60s / 8s spacing) = ~6 calls/min from
// the warm queue, leaving headroom for selected-flight detail + retries
// without triggering 429 cooldowns.
const MAX_FEED_METADATA_LOOKUPS = 6;
const MAX_IMMEDIATE_FEED_METADATA_LOOKUPS = 1;
const FEED_METADATA_WARM_TARGET = 6;
const FEED_METADATA_REQUEST_SPACING_MS = 1000 * 8;
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

  return input.code_iata || input.code_icao || input.code || null;
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

async function fetchJson<T>(path: string): Promise<T | null> {
  const headers = getAeroApiHeaders();

  if (!headers) {
    throw new Error("Missing AeroAPI credentials");
  }

  const cached = getCachedValue(httpResponseCache, path);
  if (cached !== undefined) {
    return cached as T | null;
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
  options?: { exhaustive?: boolean; requireCurrent?: boolean }
) {
  const candidates: AeroApiFlightRecord[] = [];
  const exhaustive = options?.exhaustive ?? false;
  const requireCurrent = options?.requireCurrent ?? false;

  for (const identifier of getLookupIdentifiersForFlight(flight)) {
    const data = await fetchJson<AeroApiFlightResponse>(`/flights/${encodeURIComponent(identifier)}`);

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
  return [
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
  if (flight.onGround !== true) {
    return 0;
  }

  return isStationaryOnGroundFlight(flight) ? 2 : 1;
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

    const metadata: AeroApiFeedMetadata = {
      aircraftType: null,
      airline: normalizeOperatorDisplayName(bestMatch.operator) ?? flight.airline,
      destination: normalizeAirportCode(bestMatch.destination),
      flightNumber: getPreferredFlightNumber(bestMatch),
      origin: normalizeAirportCode(bestMatch.origin),
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
  options?: { warm?: boolean }
) {
  if (!hasAeroApiCredentials() || flights.length === 0) {
    return flights;
  }

  const warm = options?.warm ?? true;

  const mergedFlights = flights.map((flight) =>
    mergeFeedMetadataIntoFlight(flight, getCachedValue(feedMetadataCache, getFeedMetadataCacheKey(flight)))
  );

  if (!warm) {
    return mergedFlights;
  }

  if (Date.now() < feedMetadataCooldownUntil) {
    return mergedFlights;
  }

  const unresolvedCommercialFlights = mergedFlights.filter(
    (flight) =>
      isCommercialFlight(flight) &&
      needsRouteMetadata(flight) &&
      !isStationaryOnGroundFlight(flight)
  );

  if (unresolvedCommercialFlights.length === 0) {
    return mergedFlights;
  }

  const targetFlights = [...unresolvedCommercialFlights]
    .sort(
      (left, right) =>
        getFeedWarmPriorityRank(left) - getFeedWarmPriorityRank(right)
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
  options?: { bypassCache?: boolean }
): Promise<SelectedFlightDetails | null> {
  const cacheKey = getDetailCacheKey(flight);
  const bypassCache = options?.bypassCache ?? false;
  const cached = bypassCache ? undefined : getCachedValue(detailCache, cacheKey);

  // Why: serve cached data even during a rate-limit cooldown — we already paid
  // for it, and returning null here would needlessly blank the selected card.
  if (cached !== undefined) {
    return cached;
  }

  // Why: AeroAPI doesn't index private GA. Skip the upstream call entirely
  // and short-circuit with a long-lived null cache so we don't ask again
  // every time the user clicks the same N-reg helicopter.
  if (isLikelyGeneralAviationFlight(flight)) {
    setCachedValue(detailCache, cacheKey, null, GA_DETAIL_NULL_TTL_MS, DETAIL_CACHE_MAX_ENTRIES);
    return null;
  }

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
        requireCurrent: true
      });

      if (!currentBestMatch) {
        setCachedValue(detailCache, cacheKey, null, DETAIL_NULL_TTL_MS, DETAIL_CACHE_MAX_ENTRIES);
        return null;
      }

      const [operatorName, track] = await Promise.all([
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
        fetchTrack(currentBestMatch.fa_flight_id).catch((error) => {
          console.warn("AeroAPI track enrichment failed for selected flight", {
            flightId: flight.id,
            callsign: flight.callsign,
            error
          });
          return [];
        })
      ]);
      const normalizedOperatorName =
        normalizeOperatorDisplayName(operatorName) ??
        normalizeOperatorDisplayName(currentBestMatch.operator);

      const details: SelectedFlightDetails = {
        aircraftType: currentBestMatch.aircraft_type ?? null,
        airline: normalizedOperatorName ?? flight.airline,
        destination: normalizeAirportCode(currentBestMatch.destination),
        faFlightId: currentBestMatch.fa_flight_id ?? null,
        flightNumber: getPreferredFlightNumber(currentBestMatch),
        origin: normalizeAirportCode(currentBestMatch.origin),
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
