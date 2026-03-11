import { NextRequest, NextResponse } from "next/server";
import { APP_CONFIG } from "@/lib/config";
import { buildMockFlights } from "@/lib/flights/mock";
import {
  fetchAeroApiDiscoveryFlights,
  hasAeroApiDiscoveryCredentials
} from "@/lib/flights/aeroapiDiscovery";
import { hasOpenSkyCredentials } from "@/lib/flights/openskyAuth";
import { fetchOpenSkyFlights } from "@/lib/flights/opensky";
import type { Flight } from "@/lib/flights/types";

export const revalidate = 0;

const STALE_FEED_TTL_MS = 1000 * 60 * 3;
const AEROAPI_DISCOVERY_COOLDOWN_MS = 1000 * 60 * 3;

type CachedFeed = {
  fetchedAt: number;
  flights: Flight[];
};

const feedCache = new Map<string, CachedFeed>();
let aeroApiDiscoveryCooldownUntil = 0;

function getDiscoveryProviderPreference() {
  const provider = process.env.FLIGHT_DISCOVERY_PROVIDER?.trim().toLowerCase();

  switch (provider) {
    case "aeroapi":
    case "opensky":
    case "auto":
      return provider;
    default:
      return "opensky";
  }
}

function getAreaFromRequest(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("latitude"));
  const longitude = Number(request.nextUrl.searchParams.get("longitude"));
  const radiusMiles = Number(request.nextUrl.searchParams.get("radiusMiles"));

  return {
    center: {
      latitude: Number.isFinite(latitude) ? latitude : APP_CONFIG.center.latitude,
      longitude: Number.isFinite(longitude) ? longitude : APP_CONFIG.center.longitude
    },
    radiusMiles:
      Number.isFinite(radiusMiles) && radiusMiles > 0 ? radiusMiles : APP_CONFIG.radiusMiles
  };
}

function shouldWarmFeedMetadata(request: NextRequest) {
  const value = request.nextUrl.searchParams.get("warmFeed");
  return value == null ? true : value !== "0";
}

function getAreaCacheKey(input: {
  center: {
    latitude: number;
    longitude: number;
  };
  radiusMiles: number;
}) {
  return [
    input.center.latitude.toFixed(3),
    input.center.longitude.toFixed(3),
    input.radiusMiles.toFixed(1)
  ].join("|");
}

function getCachedFeed(area: {
  center: {
    latitude: number;
    longitude: number;
  };
  radiusMiles: number;
}) {
  const cacheKey = getAreaCacheKey(area);
  const cached = feedCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.fetchedAt > STALE_FEED_TTL_MS) {
    feedCache.delete(cacheKey);
    return null;
  }

  return cached.flights;
}

export async function GET(request: NextRequest) {
  const area = getAreaFromRequest(request);
  const warmFeedMetadata = shouldWarmFeedMetadata(request);
  const discoveryProviderPreference = getDiscoveryProviderPreference();
  const canUseAeroApiDiscovery = hasAeroApiDiscoveryCredentials();
  const canUseOpenSky = hasOpenSkyCredentials();
  const useMockData = !canUseOpenSky && !canUseAeroApiDiscovery;
  const shouldTryAeroApiDiscovery =
    Date.now() >= aeroApiDiscoveryCooldownUntil &&
    discoveryProviderPreference === "aeroapi";

  if (shouldTryAeroApiDiscovery && canUseAeroApiDiscovery) {
    try {
      const flights = await fetchAeroApiDiscoveryFlights(area);
      feedCache.set(getAreaCacheKey(area), {
        fetchedAt: Date.now(),
        flights
      });

      return NextResponse.json({
        source: "aeroapi-discovery",
        center: area.center,
        radiusMiles: area.radiusMiles,
        flights
      });
    } catch (error) {
      aeroApiDiscoveryCooldownUntil = Date.now() + AEROAPI_DISCOVERY_COOLDOWN_MS;
      console.error("Failed to load AeroAPI discovery flights", error);

      if (discoveryProviderPreference === "aeroapi") {
        const cachedFlights = getCachedFeed(area);

        if (cachedFlights) {
          return NextResponse.json(
            {
              source: "aeroapi-stale",
              center: area.center,
              radiusMiles: area.radiusMiles,
              flights: cachedFlights
            },
            { status: 200 }
          );
        }

        return NextResponse.json(
          {
            source: "aeroapi-unavailable",
            center: area.center,
            radiusMiles: area.radiusMiles,
            flights: []
          },
          { status: 200 }
        );
      }
    }
  }

  if (useMockData) {
    return NextResponse.json({
      source: "mock",
      center: area.center,
      radiusMiles: area.radiusMiles,
      flights: buildMockFlights(area.center)
    });
  }

  try {
    const flights = await fetchOpenSkyFlights(area, {
      warmAeroApiFeed: warmFeedMetadata
    });
    feedCache.set(getAreaCacheKey(area), {
      fetchedAt: Date.now(),
      flights
    });

    return NextResponse.json({
      source: "opensky",
      center: area.center,
      radiusMiles: area.radiusMiles,
      flights
    });
  } catch (error) {
    console.error("Failed to load OpenSky flights", error);

    const cachedFlights = getCachedFeed(area);

    if (cachedFlights) {
      return NextResponse.json(
        {
          source: "opensky-stale",
          center: area.center,
          radiusMiles: area.radiusMiles,
          flights: cachedFlights
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        source: "opensky-unavailable",
        center: area.center,
        radiusMiles: area.radiusMiles,
        flights: []
      },
      { status: 200 }
    );
  }
}
