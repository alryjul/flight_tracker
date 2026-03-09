import type { Flight } from "@/lib/flights/types";

const AEROAPI_BASE_URL = "https://aeroapi.flightaware.com/aeroapi";
const DETAIL_TTL_MS = 1000 * 60 * 2;
const OPERATOR_TTL_MS = 1000 * 60 * 60 * 24 * 7;

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
  status: string | null;
  track: SelectedFlightTrackPoint[];
};

const detailCache = new Map<string, CacheEntry<SelectedFlightDetails | null>>();
const operatorCache = new Map<string, CacheEntry<string | null>>();
const detailRequests = new Map<string, Promise<SelectedFlightDetails | null>>();
const operatorRequests = new Map<string, Promise<string | null>>();

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const cached = cache.get(key);

  if (!cached) {
    return undefined;
  }

  if (Date.now() > cached.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number
) {
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

function identifiersForFlight(flight: Flight) {
  return Array.from(
    new Set(
      [flight.callsign, flight.flightNumber, flight.registration]
        .filter((value): value is string => value != null && value.trim().length > 0)
        .map((value) => value.trim().toUpperCase())
    )
  );
}

function scoreFlightRecord(record: AeroApiFlightRecord, flight: Flight) {
  let score = 0;

  if (
    normalizedUpper(record.registration) != null &&
    normalizedUpper(record.registration) === normalizedUpper(flight.registration)
  ) {
    score += 120;
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

async function fetchJson<T>(path: string) {
  const headers = getAeroApiHeaders();

  if (!headers) {
    throw new Error("Missing AeroAPI credentials");
  }

  const response = await fetch(`${AEROAPI_BASE_URL}${path}`, {
    headers,
    cache: "no-store"
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`AeroAPI request failed with status ${response.status} for ${path}`);
  }

  return (await response.json()) as T;
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
    setCachedValue(operatorCache, normalizedCode, name, OPERATOR_TTL_MS);
    return name;
  })();

  operatorRequests.set(normalizedCode, request);

  try {
    return await request;
  } finally {
    operatorRequests.delete(normalizedCode);
  }
}

async function resolveBestFlightRecord(flight: Flight) {
  const candidates: AeroApiFlightRecord[] = [];

  for (const identifier of identifiersForFlight(flight)) {
    const data = await fetchJson<AeroApiFlightResponse>(`/flights/${encodeURIComponent(identifier)}`);

    for (const candidate of data?.flights ?? []) {
      candidates.push(candidate);
    }

    if (candidates.length > 0) {
      break;
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(
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

export function hasAeroApiCredentials() {
  return process.env.AEROAPI_KEY != null;
}

export async function fetchAeroApiSelectedFlightDetails(
  flight: Flight
): Promise<SelectedFlightDetails | null> {
  const cacheKey = getDetailCacheKey(flight);
  const cached = getCachedValue(detailCache, cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = detailRequests.get(cacheKey);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const bestMatch = await resolveBestFlightRecord(flight);

    if (!bestMatch) {
      setCachedValue(detailCache, cacheKey, null, DETAIL_TTL_MS);
      return null;
    }

    const [operatorName, track] = await Promise.all([
      resolveOperatorName(bestMatch.operator_iata || bestMatch.operator),
      fetchTrack(bestMatch.fa_flight_id)
    ]);

    const details: SelectedFlightDetails = {
      aircraftType: bestMatch.aircraft_type ?? null,
      airline: operatorName ?? flight.airline,
      destination: normalizeAirportCode(bestMatch.destination),
      faFlightId: bestMatch.fa_flight_id ?? null,
      flightNumber: bestMatch.ident_iata ?? bestMatch.ident_icao ?? bestMatch.ident ?? null,
      origin: normalizeAirportCode(bestMatch.origin),
      registration: bestMatch.registration ?? null,
      status: bestMatch.status ?? null,
      track
    };

    setCachedValue(detailCache, cacheKey, details, DETAIL_TTL_MS);

    return details;
  })();

  detailRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    detailRequests.delete(cacheKey);
  }
}
