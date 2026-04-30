import {
  DEADBAND_FRACTION_OF_EXPECTED_MOVE,
  MAX_POSITION_JITTER_DEADBAND_MILES,
  MIN_POSITION_CHANGE_MILES,
  refreshMs
} from "@/lib/config/flight-map-constants";
import type { AeroApiFeedMetadata } from "@/lib/flights/aeroapi";
import { looksLikeGeneralAviationFlight } from "@/lib/flights/display";
import { hasCommercialFlightIdentity } from "@/lib/flights/scoring";
import type { Flight } from "@/lib/flights/types";
import { distanceBetweenPointsMiles } from "@/lib/geo";
import type {
  RememberedFlightMetadata,
  SelectedFlightDetailsResponse
} from "@/lib/types/flight-map";

export function getFeedMetadataMerge(
  flight: Flight,
  details:
    | {
        airline: string | null;
        destination: string | null;
        flightNumber: string | null;
        origin: string | null;
      }
    | null
) {
  if (!details) {
    return null;
  }

  const metadata: AeroApiFeedMetadata = {
    airline: details.airline ?? flight.airline,
    destination: details.destination ?? flight.destination,
    flightNumber: details.flightNumber ?? flight.flightNumber,
    origin: details.origin ?? flight.origin,
    aircraftType: null,
    registration: null
  };

  if (
    metadata.airline == null &&
    metadata.destination == null &&
    metadata.flightNumber == null &&
    metadata.origin == null
  ) {
    return null;
  }

  return metadata;
}

export function stabilizeFlightsForJitter(nextFlights: Flight[], currentFlights: Flight[]) {
  if (currentFlights.length === 0) {
    return nextFlights;
  }

  const currentFlightsById = new Map(currentFlights.map((flight) => [flight.id, flight]));

  return nextFlights.map((flight) => {
    const currentFlight = currentFlightsById.get(flight.id);

    if (!currentFlight) {
      return flight;
    }

    const currentTimestamp =
      currentFlight.positionTimestampSec ?? currentFlight.lastContactTimestampSec ?? null;
    const nextTimestamp = flight.positionTimestampSec ?? flight.lastContactTimestampSec ?? null;

    if (currentTimestamp != null && nextTimestamp != null && nextTimestamp <= currentTimestamp) {
      return {
        ...flight,
        latitude: currentFlight.latitude,
        longitude: currentFlight.longitude,
        positionTimestampSec: currentFlight.positionTimestampSec,
        lastContactTimestampSec: currentFlight.lastContactTimestampSec
      };
    }

    const deltaMiles = distanceBetweenPointsMiles({
      fromLatitude: currentFlight.latitude,
      fromLongitude: currentFlight.longitude,
      toLatitude: flight.latitude,
      toLongitude: flight.longitude
    });

    const effectiveGroundspeedKnots = Math.max(
      flight.groundspeedKnots ?? 0,
      currentFlight.groundspeedKnots ?? 0
    );
    const expectedMoveMiles = effectiveGroundspeedKnots * 1.15078 * (refreshMs / 3_600_000);
    const dynamicDeadbandMiles = Math.min(
      MAX_POSITION_JITTER_DEADBAND_MILES,
      Math.max(MIN_POSITION_CHANGE_MILES, expectedMoveMiles * DEADBAND_FRACTION_OF_EXPECTED_MOVE)
    );

    if (deltaMiles < dynamicDeadbandMiles) {
      return {
        ...flight,
        latitude: currentFlight.latitude,
        longitude: currentFlight.longitude
      };
    }

    return flight;
  });
}

export function mergeSelectedFlightDetailsIntoFlight(
  flight: Flight,
  details: SelectedFlightDetailsResponse["details"]
) {
  if (!details) {
    return flight;
  }

  return {
    ...flight,
    aircraftType: details.aircraftType ?? flight.aircraftType,
    airline: details.airline ?? flight.airline,
    destination: details.destination ?? flight.destination,
    flightNumber: details.flightNumber ?? flight.flightNumber,
    origin: details.origin ?? flight.origin,
    registration: details.registration ?? flight.registration,
    registeredOwner: details.registeredOwner ?? flight.registeredOwner
  };
}

export function shouldRetrySelectedFlightEnrichment(
  flightRequest: {
    aircraftType: string | null;
    airline: string | null;
    callsign: string;
    destination: string | null;
    flightNumber: string | null;
    id: string;
    origin: string | null;
    registration: string | null;
    registeredOwner: string | null;
  },
  response: SelectedFlightDetailsResponse
) {
  if (!response.details) {
    return true;
  }

  const details = response.details;
  const requestFlightLike: Flight = {
    id: flightRequest.id,
    latitude: 0,
    longitude: 0,
    callsign: flightRequest.callsign,
    onGround: null,
    flightNumber: flightRequest.flightNumber,
    airline: flightRequest.airline,
    aircraftType: flightRequest.aircraftType,
    origin: flightRequest.origin,
    destination: flightRequest.destination,
    altitudeFeet: null,
    groundspeedKnots: null,
    headingDegrees: null,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    squawk: null,
    registration: flightRequest.registration,
    registeredOwner: flightRequest.registeredOwner
  };

  if (hasCommercialFlightIdentity(requestFlightLike)) {
    return (
      details.airline == null ||
      details.flightNumber == null ||
      details.origin == null ||
      details.destination == null ||
      details.faFlightId == null ||
      details.track.length === 0
    );
  }

  if (looksLikeGeneralAviationFlight(requestFlightLike)) {
    return (
      details.aircraftType == null ||
      details.registration == null ||
      details.registeredOwner == null ||
      details.track.length === 0
    );
  }

  return details.track.length === 0;
}

export function mergeRememberedMetadataIntoFlight(
  flight: Flight,
  metadata: RememberedFlightMetadata | undefined
) {
  if (!metadata) {
    return flight;
  }

  return {
    ...flight,
    aircraftType: flight.aircraftType ?? metadata.aircraftType ?? null,
    registration: flight.registration ?? metadata.registration ?? null,
    registeredOwner: flight.registeredOwner ?? metadata.registeredOwner ?? null
  };
}

export function mergeFeedMetadataIntoFlight(flight: Flight, metadata: AeroApiFeedMetadata | undefined) {
  if (!metadata) {
    return flight;
  }

  return {
    ...flight,
    airline: metadata.airline ?? flight.airline,
    destination: metadata.destination ?? flight.destination,
    flightNumber: metadata.flightNumber ?? flight.flightNumber,
    origin: metadata.origin ?? flight.origin
  };
}
