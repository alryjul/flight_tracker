import type { Flight } from "@/lib/flights/types";

const ADSBDB_BASE_URL = "https://api.adsbdb.com/v0";
const AIRCRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ROUTE_TTL_MS = 1000 * 60 * 60 * 6;
const COMBINED_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_AIRCRAFT_LOOKUPS_PER_REQUEST = 12;
const MAX_COMBINED_LOOKUPS_PER_REQUEST = 16;
const MAX_ROUTE_LOOKUPS_PER_REQUEST = 16;

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type AircraftResponse = {
  response?: {
    aircraft?: {
      icao_type: string;
      registration: string;
      registered_owner: string;
      type: string;
    };
  };
};

type CallsignResponse = {
  response?: {
    flightroute?: {
      callsign_iata: string | null;
      callsign_icao: string | null;
      airline: {
        name: string;
      } | null;
      destination: {
        iata_code: string | null;
        icao_code: string | null;
        municipality: string;
        name: string;
      } | null;
      origin: {
        iata_code: string | null;
        icao_code: string | null;
        municipality: string;
        name: string;
      } | null;
    };
  };
};

type CombinedResponse = {
  response?: {
    aircraft?: {
      icao_type: string;
      registration: string;
      registered_owner: string;
      type: string;
    };
    flightroute?: {
      callsign_iata: string | null;
      callsign_icao: string | null;
      airline: {
        name: string;
      } | null;
      destination: {
        iata_code: string | null;
        icao_code: string | null;
        municipality: string;
        name: string;
      } | null;
      origin: {
        iata_code: string | null;
        icao_code: string | null;
        municipality: string;
        name: string;
      } | null;
    };
  };
};

type AircraftMetadata = {
  aircraftType: string | null;
  registration: string | null;
  registeredOwner: string | null;
};

type RouteMetadata = {
  airline: string | null;
  destination: string | null;
  flightNumber: string | null;
  origin: string | null;
};

export type AdsbdbSelectedMetadata = AircraftMetadata &
  RouteMetadata;

const aircraftCache = new Map<string, CacheEntry<AircraftMetadata | null>>();
const routeCache = new Map<string, CacheEntry<RouteMetadata | null>>();
const combinedCache = new Map<
  string,
  CacheEntry<{
    aircraftMetadata: AircraftMetadata | null;
    routeMetadata: RouteMetadata | null;
  } | null>
>();
const aircraftRequests = new Map<string, Promise<AircraftMetadata | null>>();
const routeRequests = new Map<string, Promise<RouteMetadata | null>>();
const combinedRequests = new Map<
  string,
  Promise<{
    aircraftMetadata: AircraftMetadata | null;
    routeMetadata: RouteMetadata | null;
  } | null>
>();

function normalizeLookupCallsign(callsign: string) {
  const normalized = callsign.trim().toUpperCase().replace(/\s+/g, "");
  return normalized.length === 0 || normalized === "UNKNOWN" ? null : normalized;
}

const AIRCRAFT_CACHE_MAX_ENTRIES = 1000;
const ROUTE_CACHE_MAX_ENTRIES = 1000;
const COMBINED_CACHE_MAX_ENTRIES = 500;

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const cached = cache.get(key);

  if (!cached) {
    return undefined;
  }

  if (Date.now() > cached.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  // LRU touch.
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

function normalizeRouteEndpointValue(input: {
  iata_code: string | null;
  icao_code: string | null;
  municipality: string;
  name: string;
} | null) {
  if (!input) {
    return null;
  }

  return input.iata_code || input.icao_code || input.municipality || input.name || null;
}

async function fetchAircraftMetadata(icao24: string) {
  const cached = getCachedValue(aircraftCache, icao24);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = aircraftRequests.get(icao24);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const response = await fetch(`${ADSBDB_BASE_URL}/aircraft/${encodeURIComponent(icao24)}`, {
      cache: "no-store"
    });

    if (response.status === 404) {
      setCachedValue(aircraftCache, icao24, null, AIRCRAFT_TTL_MS, AIRCRAFT_CACHE_MAX_ENTRIES);
      return null;
    }

    if (!response.ok) {
      throw new Error(`ADSBdb aircraft lookup failed with status ${response.status}`);
    }

    const data = (await response.json()) as AircraftResponse;
    const aircraft = data.response?.aircraft;
    const value =
      aircraft == null
        ? null
        : {
            aircraftType: aircraft.icao_type || aircraft.type || null,
            registration: aircraft.registration || null,
            registeredOwner: aircraft.registered_owner || null
          };

    setCachedValue(aircraftCache, icao24, value, AIRCRAFT_TTL_MS, AIRCRAFT_CACHE_MAX_ENTRIES);
    return value;
  })();

  aircraftRequests.set(icao24, request);

  try {
    return await request;
  } finally {
    aircraftRequests.delete(icao24);
  }
}

async function fetchRouteMetadata(callsign: string) {
  const normalizedCallsign = normalizeLookupCallsign(callsign);

  if (!normalizedCallsign) {
    return null;
  }

  const cached = getCachedValue(routeCache, normalizedCallsign);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = routeRequests.get(normalizedCallsign);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const response = await fetch(`${ADSBDB_BASE_URL}/callsign/${encodeURIComponent(normalizedCallsign)}`, {
      cache: "no-store"
    });

    if (response.status === 404) {
      setCachedValue(routeCache, normalizedCallsign, null, ROUTE_TTL_MS, ROUTE_CACHE_MAX_ENTRIES);
      return null;
    }

    if (!response.ok) {
      throw new Error(`ADSBdb callsign lookup failed with status ${response.status}`);
    }

    const data = (await response.json()) as CallsignResponse;
    const flightRoute = data.response?.flightroute;
    const value =
      flightRoute == null
        ? null
        : {
            airline: flightRoute.airline?.name ?? null,
            flightNumber: flightRoute.callsign_iata ?? flightRoute.callsign_icao ?? null,
            origin: normalizeRouteEndpointValue(flightRoute.origin),
            destination: normalizeRouteEndpointValue(flightRoute.destination)
          };

    setCachedValue(routeCache, normalizedCallsign, value, ROUTE_TTL_MS, ROUTE_CACHE_MAX_ENTRIES);
    return value;
  })();

  routeRequests.set(normalizedCallsign, request);

  try {
    return await request;
  } finally {
    routeRequests.delete(normalizedCallsign);
  }
}

function getCombinedCacheKey(icao24: string, callsign: string) {
  return `${icao24.toLowerCase()}|${normalizeLookupCallsign(callsign) ?? "unknown"}`;
}

function looksLikeCommercialFlight(flight: Flight) {
  const callsign = flight.callsign.trim().toUpperCase();

  return /^[A-Z]{3}\d/.test(callsign) && !/^N\d/.test(callsign);
}

async function fetchCombinedMetadata(icao24: string, callsign: string) {
  const normalizedCallsign = normalizeLookupCallsign(callsign);

  if (!normalizedCallsign) {
    return null;
  }

  const cacheKey = getCombinedCacheKey(icao24, callsign);
  const cached = getCachedValue(combinedCache, cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = combinedRequests.get(cacheKey);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const searchParams = new URLSearchParams({
      callsign: normalizedCallsign
    });
    const response = await fetch(
      `${ADSBDB_BASE_URL}/aircraft/${encodeURIComponent(icao24)}?${searchParams.toString()}`,
      {
        cache: "no-store"
      }
    );

    if (response.status === 404) {
      setCachedValue(combinedCache, cacheKey, null, COMBINED_TTL_MS, COMBINED_CACHE_MAX_ENTRIES);
      return null;
    }

    if (!response.ok) {
      throw new Error(`ADSBdb combined lookup failed with status ${response.status}`);
    }

    const data = (await response.json()) as CombinedResponse;
    const aircraft = data.response?.aircraft;
    const flightroute = data.response?.flightroute;
    const aircraftMetadata =
      aircraft == null
        ? null
        : {
            aircraftType: aircraft.icao_type || aircraft.type || null,
            registration: aircraft.registration || null,
            registeredOwner: aircraft.registered_owner || null
          };
    const routeMetadata =
      flightroute == null
        ? null
        : {
            airline: flightroute.airline?.name ?? null,
            flightNumber: flightroute.callsign_iata ?? flightroute.callsign_icao ?? null,
            origin: normalizeRouteEndpointValue(flightroute.origin),
            destination: normalizeRouteEndpointValue(flightroute.destination)
          };

    if (aircraftMetadata) {
      setCachedValue(aircraftCache, icao24, aircraftMetadata, AIRCRAFT_TTL_MS, AIRCRAFT_CACHE_MAX_ENTRIES);
    }

    if (routeMetadata) {
      setCachedValue(routeCache, normalizedCallsign, routeMetadata, ROUTE_TTL_MS, ROUTE_CACHE_MAX_ENTRIES);
    }

    const value = {
      aircraftMetadata,
      routeMetadata
    };

    setCachedValue(combinedCache, cacheKey, value, COMBINED_TTL_MS, COMBINED_CACHE_MAX_ENTRIES);
    return value;
  })();

  combinedRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    combinedRequests.delete(cacheKey);
  }
}

export function enrichFlightsWithAdsbdbFallback(flights: Flight[]) {
  const combinedToWarm = flights
    .filter(
      (flight) =>
        flight.callsign !== "Unknown" &&
        (
          flight.aircraftType == null ||
          flight.registration == null ||
          flight.registeredOwner == null ||
          (!looksLikeCommercialFlight(flight) &&
            (flight.airline == null ||
              flight.flightNumber == null ||
              flight.origin == null ||
              flight.destination == null))
        ) &&
        getCachedValue(combinedCache, getCombinedCacheKey(flight.id, flight.callsign)) === undefined
    )
    .slice(0, MAX_COMBINED_LOOKUPS_PER_REQUEST);
  const combinedCacheKeys = new Set(
    combinedToWarm.map((flight) => getCombinedCacheKey(flight.id, flight.callsign))
  );

  const aircraftToWarm = flights
    .filter(
      (flight) =>
        (flight.aircraftType == null || flight.registration == null || flight.registeredOwner == null) &&
        getCachedValue(aircraftCache, flight.id) === undefined
    )
    .slice(0, MAX_AIRCRAFT_LOOKUPS_PER_REQUEST);
  const routeToWarm = flights
    .filter(
      (flight) =>
        flight.callsign !== "Unknown" &&
        !looksLikeCommercialFlight(flight) &&
        (flight.airline == null ||
          flight.flightNumber == null ||
          flight.origin == null ||
          flight.destination == null) &&
        !combinedCacheKeys.has(getCombinedCacheKey(flight.id, flight.callsign)) &&
        getCachedValue(routeCache, normalizeLookupCallsign(flight.callsign) ?? "unknown") === undefined
    )
    .slice(0, MAX_ROUTE_LOOKUPS_PER_REQUEST);

  void Promise.all([
    ...combinedToWarm.map((flight) =>
      fetchCombinedMetadata(flight.id, flight.callsign).catch((error) => {
        console.error("ADSBdb combined fallback failed", {
          icao24: flight.id,
          callsign: flight.callsign,
          error
        });
        return null;
      })
    ),
    ...aircraftToWarm.map((flight) =>
      fetchAircraftMetadata(flight.id).catch((error) => {
        console.error("ADSBdb aircraft fallback failed", { icao24: flight.id, error });
        return null;
      })
    ),
    ...routeToWarm.map((flight) =>
      fetchRouteMetadata(flight.callsign).catch((error) => {
        console.error("ADSBdb route fallback failed", {
          icao24: flight.id,
          callsign: flight.callsign,
          error
        });
        return null;
      })
    )
  ]);

  return flights.map((flight) => {
    const normalizedCallsign = normalizeLookupCallsign(flight.callsign);
    const combinedMetadata =
      flight.callsign === "Unknown"
        ? null
        : (getCachedValue(combinedCache, getCombinedCacheKey(flight.id, flight.callsign)) ?? null);
    const aircraftMetadata =
      combinedMetadata?.aircraftMetadata ?? getCachedValue(aircraftCache, flight.id) ?? null;
    const routeMetadata =
      flight.callsign === "Unknown"
        ? null
        : looksLikeCommercialFlight(flight)
          ? null
          : (combinedMetadata?.routeMetadata ??
              (normalizedCallsign == null
                ? null
                : getCachedValue(routeCache, normalizedCallsign) ?? null));

    return {
      ...flight,
      aircraftType: flight.aircraftType ?? aircraftMetadata?.aircraftType ?? null,
      airline: flight.airline ?? routeMetadata?.airline ?? null,
      destination: flight.destination ?? routeMetadata?.destination ?? null,
      flightNumber: flight.flightNumber ?? routeMetadata?.flightNumber ?? null,
      origin: flight.origin ?? routeMetadata?.origin ?? null,
      registration: flight.registration ?? aircraftMetadata?.registration ?? null,
      registeredOwner: flight.registeredOwner ?? aircraftMetadata?.registeredOwner ?? null
    };
  });
}

export async function fetchAdsbdbSelectedMetadata(
  flight: Flight
): Promise<AdsbdbSelectedMetadata | null> {
  const isCommercial = looksLikeCommercialFlight(flight);
  const normalizedCallsign = normalizeLookupCallsign(flight.callsign);

  try {
    const combined =
      normalizedCallsign == null ? null : await fetchCombinedMetadata(flight.id, flight.callsign);

    const aircraftMetadata =
      combined?.aircraftMetadata ?? (await fetchAircraftMetadata(flight.id));
    const routeMetadata =
      isCommercial || normalizedCallsign == null
        ? null
        : (combined?.routeMetadata ?? (await fetchRouteMetadata(flight.callsign)));

    const selectedMetadata: AdsbdbSelectedMetadata = {
      aircraftType: aircraftMetadata?.aircraftType ?? null,
      registration: aircraftMetadata?.registration ?? null,
      registeredOwner: aircraftMetadata?.registeredOwner ?? null,
      airline: routeMetadata?.airline ?? null,
      destination: routeMetadata?.destination ?? null,
      flightNumber: routeMetadata?.flightNumber ?? null,
      origin: routeMetadata?.origin ?? null
    };

    if (Object.values(selectedMetadata).every((value) => value == null)) {
      return null;
    }

    return selectedMetadata;
  } catch (error) {
    console.error("ADSBdb selected-flight metadata failed", {
      icao24: flight.id,
      callsign: flight.callsign,
      error
    });
    return null;
  }
}
