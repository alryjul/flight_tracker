import { APP_CONFIG } from "@/lib/config";
import { enrichFlightsWithTrackInferredOrigin } from "@/lib/flights/adsblol";
import { enrichFlightsWithAdsbdbFallback } from "@/lib/flights/adsbdb";
import {
  enrichFlightsWithAeroApiMetadata,
  isStationaryOnGroundFlight
} from "@/lib/flights/aeroapi";
import {
  distanceBetweenPointsMiles,
  isWithinBoundingBox,
  milesToLatitudeDelta,
  milesToLongitudeDelta
} from "@/lib/geo";
import { getOpenSkyAuthorizationHeader } from "@/lib/flights/openskyAuth";
import { getDiscoveryScore } from "@/lib/flights/scoring";
import type { Flight } from "@/lib/flights/types";

const DISCOVERY_FLIGHT_CANDIDATE_LIMIT = 80;

export type FlightArea = {
  center: {
    latitude: number;
    longitude: number;
  };
  radiusMiles: number;
};

type OpenSkyResponse = {
  states: Array<
    [
      string | null,
      string | null,
      string | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      boolean | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      string | null,
      boolean | null,
      number | null
    ]
  > | null;
};

function getBounds(area: FlightArea) {
  const { latitude, longitude } = area.center;
  const lamin = latitude - milesToLatitudeDelta(area.radiusMiles);
  const lamax = latitude + milesToLatitudeDelta(area.radiusMiles);
  const lomin = longitude - milesToLongitudeDelta(area.radiusMiles, latitude);
  const lomax = longitude + milesToLongitudeDelta(area.radiusMiles, latitude);

  return { lamin, lamax, lomin, lomax };
}

function normalizeCallsign(callsign: string | null) {
  return callsign?.trim() || "Unknown";
}


export async function fetchOpenSkyFlights(
  area: FlightArea = {
    center: APP_CONFIG.center,
    radiusMiles: APP_CONFIG.radiusMiles
  },
  options?: { warmAeroApiFeed?: boolean }
): Promise<Flight[]> {
  const { lamin, lamax, lomin, lomax } = getBounds(area);
  const authorizationHeader = await getOpenSkyAuthorizationHeader();
  const searchParams = new URLSearchParams({
    lamin: String(lamin),
    lamax: String(lamax),
    lomin: String(lomin),
    lomax: String(lomax)
  });

  const requestInit: RequestInit = {
    next: { revalidate: 0 }
  } as RequestInit;
  if (authorizationHeader) {
    requestInit.headers = { Authorization: authorizationHeader };
  }
  const response = await fetch(
    `https://opensky-network.org/api/states/all?${searchParams.toString()}`,
    requestInit
  );

  if (!response.ok) {
    throw new Error(`OpenSky request failed with status ${response.status}`);
  }

  const data = (await response.json()) as OpenSkyResponse;

  const flights = (data.states ?? [])
    .map((state): Flight | null => {
      const icao24 = state[0];
      const callsign = state[1];
      const positionTimestampSec = state[3];
      const lastContactTimestampSec = state[4];
      const longitude = state[5];
      const latitude = state[6];
      const baroAltitudeMeters = state[7];
      const onGround = state[8];
      const velocityMetersPerSecond = state[9];
      const headingDegrees = state[10];
      // Squawk lives at index 14 in OpenSky's state vector. Stays null if
      // not transmitted.
      const squawkRaw = state[14];
      const squawk =
        typeof squawkRaw === "string" && squawkRaw.trim().length > 0
          ? squawkRaw.trim()
          : null;

      if (
        icao24 == null ||
        longitude == null ||
        latitude == null ||
        !isWithinBoundingBox({
          latitude,
          longitude,
          centerLatitude: area.center.latitude,
          centerLongitude: area.center.longitude,
          radiusMiles: area.radiusMiles
        })
      ) {
        return null;
      }

      return {
        id: icao24,
        latitude,
        longitude,
        callsign: normalizeCallsign(callsign),
        onGround,
        flightNumber: null,
        airline: deriveAirlineFromCallsign(callsign),
        aircraftType: null,
        origin: null,
        destination: null,
        altitudeFeet:
          baroAltitudeMeters == null ? null : Math.round(baroAltitudeMeters * 3.28084),
        groundspeedKnots:
          velocityMetersPerSecond == null
            ? null
            : Math.round(velocityMetersPerSecond * 1.94384),
        headingDegrees,
        positionTimestampSec,
        lastContactTimestampSec,
        registration: null,
        registeredOwner: null,
        squawk
      };
    })
    .filter((flight): flight is Flight => flight != null)
    // Why: drop parked / barely-moving aircraft at the source so the
    // strip and viewport aren't crowded by stationary aircraft at
    // airports. Matches adsb.lol's discovery filter for parity.
    .filter((flight) => !isStationaryOnGroundFlight(flight))
    .sort((left, right) => getDiscoveryScore(left, area.center) - getDiscoveryScore(right, area.center))
    .slice(0, DISCOVERY_FLIGHT_CANDIDATE_LIMIT);

  // See adsblol.ts for the full chain rationale — same pattern here.
  const adsbdbEnriched = enrichFlightsWithAdsbdbFallback(flights);
  const trackInferred = await enrichFlightsWithTrackInferredOrigin(adsbdbEnriched, {
    warm: options?.warmAeroApiFeed ?? true,
    center: area.center
  });
  return enrichFlightsWithAeroApiMetadata(trackInferred, {
    warm: options?.warmAeroApiFeed ?? true,
    center: area.center
  });
}

function deriveAirlineFromCallsign(callsign: string | null) {
  const prefix = callsign?.trim().slice(0, 3).toUpperCase();

  switch (prefix) {
    case "AAL":
      return "American Airlines";
    case "DAL":
      return "Delta Air Lines";
    case "SWA":
      return "Southwest";
    case "UAL":
      return "United Airlines";
    case "ASA":
      return "Alaska Airlines";
    case "JBU":
      return "JetBlue";
    default:
      return null;
  }
}
