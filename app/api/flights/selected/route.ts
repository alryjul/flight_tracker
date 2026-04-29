import { NextRequest, NextResponse } from "next/server";
import {
  fetchAeroApiSelectedFlightDetails,
  hasAeroApiCredentials,
  primeAeroApiFeedMetadata
} from "@/lib/flights/aeroapi";
import { fetchAdsbdbSelectedMetadata } from "@/lib/flights/adsbdb";
import { fetchOpenSkySelectedFlightTrack } from "@/lib/flights/openskyTrack";
import type { Flight } from "@/lib/flights/types";

export const revalidate = 0;

function normalizedUpper(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? null;
}

function hasCommercialFlightIdentity(flight: Flight) {
  if (flight.flightNumber) {
    return true;
  }

  const callsign = flight.callsign.trim().toUpperCase();
  return /^[A-Z]{3}\d/.test(callsign) && !/^N\d/.test(callsign);
}

function primeFeedMetadataFromTrustedAeroApiDetails(
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
  if (!details || !hasCommercialFlightIdentity(flight)) {
    return;
  }

  if (
    details.airline == null &&
    details.destination == null &&
    details.flightNumber == null &&
    details.origin == null
  ) {
    return;
  }

  primeAeroApiFeedMetadata(flight, {
    airline: details.airline,
    destination: details.destination,
    flightNumber: details.flightNumber,
    origin: details.origin
  });
}

function parseOptionalFiniteNumber(value: string | null) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFlightFromSearchParams(searchParams: URLSearchParams): Flight | null {
  const id = searchParams.get("id");
  const callsign = searchParams.get("callsign");

  if (!id || !callsign) {
    return null;
  }

  return {
    id,
    latitude: 0,
    longitude: 0,
    callsign,
    onGround: null,
    flightNumber: searchParams.get("flightNumber"),
    airline: searchParams.get("airline"),
    aircraftType: searchParams.get("aircraftType"),
    origin: searchParams.get("origin"),
    destination: searchParams.get("destination"),
    altitudeFeet: parseOptionalFiniteNumber(searchParams.get("altitudeFeet")),
    groundspeedKnots: parseOptionalFiniteNumber(searchParams.get("groundspeedKnots")),
    headingDegrees: parseOptionalFiniteNumber(searchParams.get("headingDegrees")),
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: searchParams.get("registration"),
    registeredOwner: searchParams.get("registeredOwner")
  };
}

const SELECTED_FRESH_CACHE_HEADER = "private, max-age=10, stale-while-revalidate=60";
const SELECTED_ERROR_CACHE_HEADER = "no-store";

function jsonResponse(
  body: Record<string, unknown>,
  init: { status?: number; cacheControl: string }
) {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { "Cache-Control": init.cacheControl }
  });
}

export async function GET(request: NextRequest) {
  const flight = getFlightFromSearchParams(request.nextUrl.searchParams);
  const bypassCache = request.nextUrl.searchParams.get("refresh") === "1";

  if (!flight) {
    return jsonResponse(
      { error: "Missing required selected flight parameters: id and callsign" },
      { status: 400, cacheControl: SELECTED_ERROR_CACHE_HEADER }
    );
  }

  try {
    const aeroApiAvailable = hasAeroApiCredentials();
    const [details, adsbdbMetadata, openSkyTrack] = await Promise.all([
      aeroApiAvailable
        ? fetchAeroApiSelectedFlightDetails(flight, { bypassCache })
        : Promise.resolve(null),
      fetchAdsbdbSelectedMetadata(flight),
      fetchOpenSkySelectedFlightTrack(flight.id).catch((error) => {
        console.error("Failed to load OpenSky selected flight track fallback", error);
        return [];
      })
    ]);

    const aeroApiRegistrationMismatch =
      normalizedUpper(flight.registration) != null &&
      normalizedUpper(details?.registration) != null &&
      normalizedUpper(flight.registration) !== normalizedUpper(details?.registration);
    const trustedAeroApiDetails = aeroApiRegistrationMismatch ? null : details;

    const mergedDetails =
      trustedAeroApiDetails == null && adsbdbMetadata == null && openSkyTrack.length === 0
        ? null
        : {
            aircraftType:
              trustedAeroApiDetails?.aircraftType ??
              adsbdbMetadata?.aircraftType ??
              flight.aircraftType,
            airline:
              trustedAeroApiDetails?.airline ??
              (flight.flightNumber == null ? adsbdbMetadata?.airline : null) ??
              flight.airline,
            destination:
              trustedAeroApiDetails?.destination ??
              (flight.flightNumber == null ? adsbdbMetadata?.destination : null) ??
              flight.destination,
            faFlightId: trustedAeroApiDetails?.faFlightId ?? null,
            flightNumber:
              trustedAeroApiDetails?.flightNumber ??
              (flight.flightNumber == null ? adsbdbMetadata?.flightNumber : null) ??
              flight.flightNumber,
            origin:
              trustedAeroApiDetails?.origin ??
              (flight.flightNumber == null ? adsbdbMetadata?.origin : null) ??
              flight.origin,
            registration:
              trustedAeroApiDetails?.registration ??
              adsbdbMetadata?.registration ??
              flight.registration,
            registeredOwner:
              trustedAeroApiDetails?.registeredOwner ??
              adsbdbMetadata?.registeredOwner ??
              flight.registeredOwner,
            status: trustedAeroApiDetails?.status ?? null,
            track: trustedAeroApiDetails?.track.length ? trustedAeroApiDetails.track : openSkyTrack
          };

    if (mergedDetails?.track.length) {
      primeFeedMetadataFromTrustedAeroApiDetails(flight, trustedAeroApiDetails);

      return jsonResponse(
        {
          details: mergedDetails,
          source:
            trustedAeroApiDetails?.faFlightId
              ? "aeroapi"
              : adsbdbMetadata
                ? "aeroapi+adsbdb"
                : "opensky-track-fallback"
        },
        { cacheControl: SELECTED_FRESH_CACHE_HEADER }
      );
    }

    if (mergedDetails) {
      primeFeedMetadataFromTrustedAeroApiDetails(flight, trustedAeroApiDetails);
    }

    return jsonResponse(
      {
        details: mergedDetails,
        source:
          mergedDetails == null
            ? "unavailable"
            : trustedAeroApiDetails?.faFlightId
              ? "aeroapi"
              : adsbdbMetadata
                ? "aeroapi+adsbdb"
                : openSkyTrack.length > 0
                  ? "opensky-track-fallback"
                  : "aeroapi"
      },
      {
        status: mergedDetails == null ? 503 : 200,
        cacheControl:
          mergedDetails == null ? SELECTED_ERROR_CACHE_HEADER : SELECTED_FRESH_CACHE_HEADER
      }
    );
  } catch (error) {
    console.error("Failed to load selected AeroAPI flight details", error);

    try {
      const [adsbdbMetadata, openSkyTrack] = await Promise.all([
        fetchAdsbdbSelectedMetadata(flight),
        fetchOpenSkySelectedFlightTrack(flight.id)
      ]);

      const fallbackDetails =
        adsbdbMetadata || openSkyTrack.length > 0
          ? {
              aircraftType: adsbdbMetadata?.aircraftType ?? flight.aircraftType,
              airline:
                (flight.flightNumber == null ? adsbdbMetadata?.airline : null) ?? flight.airline,
              destination:
                (flight.flightNumber == null ? adsbdbMetadata?.destination : null) ??
                flight.destination,
              faFlightId: null,
              flightNumber:
                (flight.flightNumber == null ? adsbdbMetadata?.flightNumber : null) ??
                flight.flightNumber,
              origin:
                (flight.flightNumber == null ? adsbdbMetadata?.origin : null) ?? flight.origin,
              registration: adsbdbMetadata?.registration ?? flight.registration,
              registeredOwner: adsbdbMetadata?.registeredOwner ?? flight.registeredOwner,
              status: null,
              track: openSkyTrack
            }
          : null;

      return jsonResponse(
        {
          details: fallbackDetails,
          source:
            adsbdbMetadata != null
              ? "adsbdb-fallback"
              : openSkyTrack.length > 0
                ? "opensky-track-fallback"
                : "aeroapi-error"
        },
        {
          status: fallbackDetails == null ? 502 : 200,
          cacheControl:
            fallbackDetails == null ? SELECTED_ERROR_CACHE_HEADER : SELECTED_FRESH_CACHE_HEADER
        }
      );
    } catch (openSkyError) {
      console.error("Failed to load OpenSky selected flight track fallback", openSkyError);

      return jsonResponse(
        { details: null, source: "aeroapi-error" },
        { status: 502, cacheControl: SELECTED_ERROR_CACHE_HEADER }
      );
    }
  }
}
