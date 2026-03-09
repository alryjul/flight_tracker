import type { Flight } from "@/lib/flights/types";

const ADSBDB_BASE_URL = "https://api.adsbdb.com/v0";
const AIRCRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ROUTE_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_AIRCRAFT_LOOKUPS_PER_REQUEST = 12;
const MAX_ROUTE_LOOKUPS_PER_REQUEST = 12;

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type AircraftResponse = {
  response?: {
    aircraft?: {
      icao_type: string;
      manufacturer: string;
      mode_s: string;
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

const aircraftCache = new Map<string, CacheEntry<AircraftMetadata | null>>();
const routeCache = new Map<string, CacheEntry<RouteMetadata | null>>();
const aircraftRequests = new Map<string, Promise<AircraftMetadata | null>>();
const routeRequests = new Map<string, Promise<RouteMetadata | null>>();

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
      setCachedValue(aircraftCache, icao24, null, AIRCRAFT_TTL_MS);
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

    setCachedValue(aircraftCache, icao24, value, AIRCRAFT_TTL_MS);

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
  const cached = getCachedValue(routeCache, callsign);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightRequest = routeRequests.get(callsign);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const response = await fetch(`${ADSBDB_BASE_URL}/callsign/${encodeURIComponent(callsign)}`, {
      cache: "no-store"
    });

    if (response.status === 404) {
      setCachedValue(routeCache, callsign, null, ROUTE_TTL_MS);
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

    setCachedValue(routeCache, callsign, value, ROUTE_TTL_MS);

    return value;
  })();

  routeRequests.set(callsign, request);

  try {
    return await request;
  } finally {
    routeRequests.delete(callsign);
  }
}

export async function enrichFlightsWithAdsbdb(flights: Flight[]) {
  const aircraftToFetch = new Set<string>();
  const callsignsToFetch = new Set<string>();

  for (const flight of flights) {
    if (flight.registration == null && getCachedValue(aircraftCache, flight.id) === undefined) {
      aircraftToFetch.add(flight.id);
    }

    if (
      flight.callsign !== "Unknown" &&
      (
        flight.airline == null ||
        flight.flightNumber == null ||
        flight.origin == null ||
        flight.destination == null
      ) &&
      getCachedValue(routeCache, flight.callsign) === undefined
    ) {
      callsignsToFetch.add(flight.callsign);
    }
  }

  await Promise.all([
    Promise.all(
      Array.from(aircraftToFetch).slice(0, MAX_AIRCRAFT_LOOKUPS_PER_REQUEST).map((icao24) =>
        fetchAircraftMetadata(icao24).catch((error) => {
          console.error("ADSBdb aircraft lookup failed", { icao24, error });
          return null;
        })
      )
    ),
    Promise.all(
      Array.from(callsignsToFetch).slice(0, MAX_ROUTE_LOOKUPS_PER_REQUEST).map((callsign) =>
        fetchRouteMetadata(callsign).catch((error) => {
          console.error("ADSBdb callsign lookup failed", { callsign, error });
          return null;
        })
      )
    )
  ]);

  return flights.map((flight) => {
    const aircraftMetadata = getCachedValue(aircraftCache, flight.id) ?? null;
    const routeMetadata =
      flight.callsign === "Unknown"
        ? null
        : (getCachedValue(routeCache, flight.callsign) ?? null);

    return {
      ...flight,
      airline: routeMetadata?.airline ?? flight.airline,
      aircraftType: aircraftMetadata?.aircraftType ?? flight.aircraftType,
      destination: routeMetadata?.destination ?? flight.destination,
      flightNumber: routeMetadata?.flightNumber ?? flight.flightNumber,
      origin: routeMetadata?.origin ?? flight.origin,
      registration: aircraftMetadata?.registration ?? flight.registration,
      registeredOwner: aircraftMetadata?.registeredOwner ?? flight.registeredOwner
    };
  });
}
