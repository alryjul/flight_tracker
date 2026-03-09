import { APP_CONFIG } from "@/lib/config";
import { enrichFlightsWithAdsbdb } from "@/lib/flights/adsbdb";
import { isWithinBoundingBox, milesToLatitudeDelta, milesToLongitudeDelta } from "@/lib/geo";
import { getOpenSkyAuthorizationHeader } from "@/lib/flights/openskyAuth";
import type { Flight } from "@/lib/flights/types";

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

function getBounds() {
  const { latitude, longitude } = APP_CONFIG.center;
  const lamin = latitude - milesToLatitudeDelta(APP_CONFIG.radiusMiles);
  const lamax = latitude + milesToLatitudeDelta(APP_CONFIG.radiusMiles);
  const lomin = longitude - milesToLongitudeDelta(APP_CONFIG.radiusMiles, latitude);
  const lomax = longitude + milesToLongitudeDelta(APP_CONFIG.radiusMiles, latitude);

  return { lamin, lamax, lomin, lomax };
}

function normalizeCallsign(callsign: string | null) {
  return callsign?.trim() || "Unknown";
}

export async function fetchOpenSkyFlights(): Promise<Flight[]> {
  const { lamin, lamax, lomin, lomax } = getBounds();
  const authorizationHeader = await getOpenSkyAuthorizationHeader();
  const searchParams = new URLSearchParams({
    lamin: String(lamin),
    lamax: String(lamax),
    lomin: String(lomin),
    lomax: String(lomax)
  });

  const response = await fetch(
    `https://opensky-network.org/api/states/all?${searchParams.toString()}`,
    {
      headers: authorizationHeader ? { Authorization: authorizationHeader } : undefined,
      next: {
        revalidate: 0
      }
    }
  );

  if (!response.ok) {
    throw new Error(`OpenSky request failed with status ${response.status}`);
  }

  const data = (await response.json()) as OpenSkyResponse;

  const flights = (data.states ?? [])
    .map((state): Flight | null => {
      const icao24 = state[0];
      const callsign = state[1];
      const longitude = state[5];
      const latitude = state[6];
      const baroAltitudeMeters = state[7];
      const velocityMetersPerSecond = state[9];
      const headingDegrees = state[10];

      if (
        icao24 == null ||
        longitude == null ||
        latitude == null ||
        !isWithinBoundingBox({
          latitude,
          longitude,
          centerLatitude: APP_CONFIG.center.latitude,
          centerLongitude: APP_CONFIG.center.longitude,
          radiusMiles: APP_CONFIG.radiusMiles
        })
      ) {
        return null;
      }

      return {
        id: icao24,
        latitude,
        longitude,
        callsign: normalizeCallsign(callsign),
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
        registration: null,
        registeredOwner: null
      };
    })
    .filter((flight): flight is Flight => flight != null)
    .slice(0, 50);

  return enrichFlightsWithAdsbdb(flights);
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
