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
    altitudeFeet: searchParams.get("altitudeFeet")
      ? Number(searchParams.get("altitudeFeet"))
      : null,
    groundspeedKnots: searchParams.get("groundspeedKnots")
      ? Number(searchParams.get("groundspeedKnots"))
      : null,
    headingDegrees: searchParams.get("headingDegrees")
      ? Number(searchParams.get("headingDegrees"))
      : null,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: searchParams.get("registration"),
    registeredOwner: searchParams.get("registeredOwner")
  };
}

export async function GET(request: NextRequest) {
  const flight = getFlightFromSearchParams(request.nextUrl.searchParams);
  const bypassCache = request.nextUrl.searchParams.get("refresh") === "1";

  if (!flight) {
    return NextResponse.json(
      {
        error: "Missing required selected flight parameters"
      },
      { status: 400 }
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

      return NextResponse.json({
        details: mergedDetails,
        source:
          trustedAeroApiDetails?.faFlightId
            ? "aeroapi"
            : adsbdbMetadata
              ? "aeroapi+adsbdb"
              : "opensky-track-fallback"
      });
    }

    if (mergedDetails) {
      primeFeedMetadataFromTrustedAeroApiDetails(flight, trustedAeroApiDetails);
    }

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error("Failed to load selected AeroAPI flight details", error);

    try {
      const [adsbdbMetadata, openSkyTrack] = await Promise.all([
        fetchAdsbdbSelectedMetadata(flight),
        fetchOpenSkySelectedFlightTrack(flight.id)
      ]);

      return NextResponse.json(
        {
          details:
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
              : null,
          source:
            adsbdbMetadata != null
              ? "adsbdb-fallback"
              : openSkyTrack.length > 0
                ? "opensky-track-fallback"
                : "aeroapi-error"
        },
        { status: 200 }
      );
    } catch (openSkyError) {
      console.error("Failed to load OpenSky selected flight track fallback", openSkyError);

      return NextResponse.json(
        {
          details: null,
          source: "aeroapi-error"
        },
        { status: 200 }
      );
    }
  }
}
