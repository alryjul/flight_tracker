import { NextResponse } from "next/server";
import { APP_CONFIG } from "@/lib/config";
import { buildMockFlights } from "@/lib/flights/mock";
import { hasOpenSkyCredentials } from "@/lib/flights/openskyAuth";
import { fetchOpenSkyFlights } from "@/lib/flights/opensky";

export const revalidate = 0;

export async function GET() {
  const useMockData = !hasOpenSkyCredentials();

  if (useMockData) {
    return NextResponse.json({
      source: "mock",
      center: APP_CONFIG.center,
      radiusMiles: APP_CONFIG.radiusMiles,
      flights: buildMockFlights()
    });
  }

  try {
    const flights = await fetchOpenSkyFlights();

    return NextResponse.json({
      source: "opensky",
      center: APP_CONFIG.center,
      radiusMiles: APP_CONFIG.radiusMiles,
      flights
    });
  } catch (error) {
    console.error("Failed to load OpenSky flights", error);

    return NextResponse.json(
      {
        source: "mock-fallback",
        center: APP_CONFIG.center,
        radiusMiles: APP_CONFIG.radiusMiles,
        flights: buildMockFlights()
      },
      { status: 200 }
    );
  }
}
