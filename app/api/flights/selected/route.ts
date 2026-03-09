import { NextRequest, NextResponse } from "next/server";
import { fetchAeroApiSelectedFlightDetails, hasAeroApiCredentials } from "@/lib/flights/aeroapi";
import type { Flight } from "@/lib/flights/types";

export const revalidate = 0;

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
    registration: searchParams.get("registration"),
    registeredOwner: searchParams.get("registeredOwner")
  };
}

export async function GET(request: NextRequest) {
  if (!hasAeroApiCredentials()) {
    return NextResponse.json({
      details: null,
      source: "unavailable"
    });
  }

  const flight = getFlightFromSearchParams(request.nextUrl.searchParams);

  if (!flight) {
    return NextResponse.json(
      {
        error: "Missing required selected flight parameters"
      },
      { status: 400 }
    );
  }

  try {
    const details = await fetchAeroApiSelectedFlightDetails(flight);

    return NextResponse.json({
      details,
      source: "aeroapi"
    });
  } catch (error) {
    console.error("Failed to load selected AeroAPI flight details", error);

    return NextResponse.json(
      {
        details: null,
        source: "aeroapi-error"
      },
      { status: 200 }
    );
  }
}
