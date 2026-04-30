import { distanceBetweenPointsMiles, milesToLatitudeDelta, milesToLongitudeDelta } from "@/lib/geo";
import { getDiscoveryScore } from "@/lib/flights/scoring";
import { resolveAirlineName } from "@/lib/flights/airlines";
import type { Flight } from "@/lib/flights/types";

const AEROAPI_BASE_URL = "https://aeroapi.flightaware.com/aeroapi";
const DISCOVERY_FLIGHT_CANDIDATE_LIMIT = 80;
const MAX_POSITION_AGE_MS = 1000 * 60 * 5;
const MIN_DISCOVERY_FLIGHTS = 8;

type FlightArea = {
  center: {
    latitude: number;
    longitude: number;
  };
  radiusMiles: number;
};

type AeroApiDiscoveryResponse = {
  flights?: AeroApiDiscoveryFlight[];
};

type AeroApiDiscoveryFlight = {
  ident: string | null;
  ident_icao: string | null;
  ident_iata: string | null;
  registration: string | null;
  operator: string | null;
  operator_iata: string | null;
  aircraft_type: string | null;
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
  last_position: {
    altitude: number | null;
    groundspeed: number | null;
    heading: number | null;
    latitude: number | null;
    longitude: number | null;
    timestamp: string | null;
  } | null;
};

function getAeroApiHeaders() {
  const apiKey = process.env.AEROAPI_KEY;

  if (!apiKey) {
    return null;
  }

  return {
    "x-apikey": apiKey
  };
}

function getBoundingBox(area: FlightArea) {
  const { latitude, longitude } = area.center;

  return {
    lowLat: latitude - milesToLatitudeDelta(area.radiusMiles),
    hiLat: latitude + milesToLatitudeDelta(area.radiusMiles),
    lowLon: longitude - milesToLongitudeDelta(area.radiusMiles, latitude),
    hiLon: longitude + milesToLongitudeDelta(area.radiusMiles, latitude)
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

function getCallsign(input: AeroApiDiscoveryFlight) {
  return input.ident_icao || input.ident || input.registration || "Unknown";
}

function getFlightId(input: AeroApiDiscoveryFlight) {
  return (input.registration || input.ident_icao || input.ident || input.ident_iata || "unknown")
    .trim()
    .toLowerCase();
}

function normalizeFlight(input: AeroApiDiscoveryFlight): Flight | null {
  const latitude = input.last_position?.latitude;
  const longitude = input.last_position?.longitude;
  const timestamp = input.last_position?.timestamp;

  if (
    latitude == null ||
    longitude == null ||
    (latitude === 0 && longitude === 0) ||
    timestamp == null
  ) {
    return null;
  }

  const positionTimestamp = Date.parse(timestamp);

  if (
    Number.isNaN(positionTimestamp) ||
    Date.now() - positionTimestamp > MAX_POSITION_AGE_MS
  ) {
    return null;
  }

  return {
    id: getFlightId(input),
    latitude,
    longitude,
    callsign: getCallsign(input),
    onGround: null,
    flightNumber: input.ident_iata ?? null,
    // Why: AeroAPI returns operator codes; resolve to readable names so
    // the strip card shows "Southwest Airlines" not "SWA".
    airline:
      resolveAirlineName(input.operator) ??
      resolveAirlineName(input.operator_iata) ??
      input.operator ??
      input.operator_iata ??
      null,
    aircraftType: input.aircraft_type ?? null,
    origin: normalizeAirportCode(input.origin),
    destination: normalizeAirportCode(input.destination),
    altitudeFeet:
      input.last_position?.altitude == null ? null : Math.round(input.last_position.altitude * 100),
    groundspeedKnots: input.last_position?.groundspeed ?? null,
    headingDegrees: input.last_position?.heading ?? null,
    positionTimestampSec:
      input.last_position?.timestamp == null
        ? null
        : Math.round(Date.parse(input.last_position.timestamp) / 1000),
    lastContactTimestampSec:
      input.last_position?.timestamp == null
        ? null
        : Math.round(Date.parse(input.last_position.timestamp) / 1000),
    registration: input.registration ?? null,
    registeredOwner: input.operator ?? null,
    squawk: null
  };
}

export function hasAeroApiDiscoveryCredentials() {
  return process.env.AEROAPI_KEY != null;
}

export async function fetchAeroApiDiscoveryFlights(area: FlightArea): Promise<Flight[]> {
  const headers = getAeroApiHeaders();

  if (!headers) {
    throw new Error("Missing AeroAPI credentials");
  }

  const { lowLat, hiLat, lowLon, hiLon } = getBoundingBox(area);
  const query = `{<= hiLat ${hiLat.toFixed(4)}} {>= lowLat ${lowLat.toFixed(4)}} {<= hiLon ${hiLon.toFixed(4)}} {>= lowLon ${lowLon.toFixed(4)}}`;
  const searchParams = new URLSearchParams({
    query,
    max_pages: "1"
  });

  const response = await fetch(
    `${AEROAPI_BASE_URL}/flights/search/advanced?${searchParams.toString()}`,
    {
      headers,
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(`AeroAPI discovery request failed with status ${response.status}`);
  }

  const data = (await response.json()) as AeroApiDiscoveryResponse;
  const flights = (data.flights ?? [])
    .map(normalizeFlight)
    .filter((flight): flight is Flight => flight != null)
    .sort((left, right) => getDiscoveryScore(left, area.center) - getDiscoveryScore(right, area.center))
    .slice(0, DISCOVERY_FLIGHT_CANDIDATE_LIMIT);

  if (flights.length < MIN_DISCOVERY_FLIGHTS) {
    throw new Error(
      `AeroAPI discovery returned only ${flights.length} current flights after filtering`
    );
  }

  return flights;
}
