import { NextRequest, NextResponse } from "next/server";
import { APP_CONFIG } from "@/lib/config";
import { fetchAdsbLolFlights } from "@/lib/flights/adsblol";
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
// Why: adsb.lol is community-fed and occasionally has hiccups. When a
// discovery attempt fails, back off for 30s before retrying so we don't
// hammer them — and so the OpenSky fallback gets a chance to serve.
const ADSBLOL_DISCOVERY_COOLDOWN_MS = 1000 * 30;
const MAX_RADIUS_MILES = 250;
const FRESH_CACHE_HEADER = "private, max-age=2, stale-while-revalidate=30";
const STALE_CACHE_HEADER = "private, max-age=0, stale-while-revalidate=30";
const ERROR_CACHE_HEADER = "no-store";
// Why: feed cache is keyed on caller-supplied lat/lon/radius. A public
// deployment would otherwise be memory-pinnable by varying the request.
const FEED_CACHE_MAX_ENTRIES = 64;

type CachedFeed = {
  fetchedAt: number;
  flights: Flight[];
};

const feedCache = new Map<string, CachedFeed>();
let aeroApiDiscoveryCooldownUntil = 0;
let adsbLolDiscoveryCooldownUntil = 0;

function setCachedFeed(key: string, value: CachedFeed) {
  if (!feedCache.has(key) && feedCache.size >= FEED_CACHE_MAX_ENTRIES) {
    const oldestKey = feedCache.keys().next().value;
    if (oldestKey !== undefined) {
      feedCache.delete(oldestKey);
    }
  }
  feedCache.set(key, value);
}

// Why: default cascade is adsb.lol -> opensky -> mock. adsb.lol gives us
// the best GA coverage and richer fields (registration, type, owner)
// without an API key or quota. OpenSky is the institutional fallback for
// the rare case adsb.lol is down or has missed an aircraft. Explicit
// provider env values force a single source for testing/debug.
type DiscoveryProvider = "auto" | "adsblol" | "opensky" | "aeroapi";

function getDiscoveryProviderPreference(): DiscoveryProvider {
  const provider = process.env.FLIGHT_DISCOVERY_PROVIDER?.trim().toLowerCase();

  switch (provider) {
    case "aeroapi":
    case "opensky":
    case "adsblol":
    case "auto":
      return provider;
    default:
      return "auto";
  }
}

type ParsedArea =
  | {
      ok: true;
      area: {
        center: { latitude: number; longitude: number };
        radiusMiles: number;
      };
    }
  | { ok: false; error: string };

function parseArea(request: NextRequest): ParsedArea {
  const params = request.nextUrl.searchParams;
  const rawLat = params.get("latitude");
  const rawLon = params.get("longitude");
  const rawRadius = params.get("radiusMiles");

  const latitude = rawLat == null || rawLat === "" ? APP_CONFIG.center.latitude : Number(rawLat);
  const longitude = rawLon == null || rawLon === "" ? APP_CONFIG.center.longitude : Number(rawLon);
  const radiusMiles =
    rawRadius == null || rawRadius === "" ? APP_CONFIG.radiusMiles : Number(rawRadius);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, error: "latitude must be a finite number in [-90, 90]" };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, error: "longitude must be a finite number in [-180, 180]" };
  }
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0 || radiusMiles > MAX_RADIUS_MILES) {
    return {
      ok: false,
      error: `radiusMiles must be a finite number in (0, ${MAX_RADIUS_MILES}]`
    };
  }

  return {
    ok: true,
    area: {
      center: { latitude, longitude },
      radiusMiles
    }
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
  const parsed = parseArea(request);

  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, { status: 400, cacheControl: ERROR_CACHE_HEADER });
  }

  const { area } = parsed;
  const warmFeedMetadata = shouldWarmFeedMetadata(request);
  const discoveryProviderPreference = getDiscoveryProviderPreference();
  const canUseAeroApiDiscovery = hasAeroApiDiscoveryCredentials();
  const canUseOpenSky = hasOpenSkyCredentials();

  // Force-only paths for explicit overrides via FLIGHT_DISCOVERY_PROVIDER.
  // Default ("auto") falls into the cascade further down.
  if (discoveryProviderPreference === "aeroapi") {
    if (Date.now() >= aeroApiDiscoveryCooldownUntil && canUseAeroApiDiscovery) {
      try {
        const flights = await fetchAeroApiDiscoveryFlights(area);
        setCachedFeed(getAreaCacheKey(area), { fetchedAt: Date.now(), flights });
        return jsonResponse(
          { source: "aeroapi-discovery", center: area.center, radiusMiles: area.radiusMiles, flights },
          { cacheControl: FRESH_CACHE_HEADER }
        );
      } catch (error) {
        aeroApiDiscoveryCooldownUntil = Date.now() + AEROAPI_DISCOVERY_COOLDOWN_MS;
        console.error("Failed to load AeroAPI discovery flights", error);
      }
    }
    const cachedFlights = getCachedFeed(area);
    return cachedFlights
      ? jsonResponse(
          { source: "aeroapi-stale", center: area.center, radiusMiles: area.radiusMiles, flights: cachedFlights },
          { cacheControl: STALE_CACHE_HEADER }
        )
      : jsonResponse(
          { source: "aeroapi-unavailable", center: area.center, radiusMiles: area.radiusMiles, flights: [] },
          { status: 503, cacheControl: ERROR_CACHE_HEADER }
        );
  }

  // Cascade: adsb.lol -> opensky -> mock. Each provider's failure mode
  // falls through to the next; cached responses bridge transient outages.
  const tryAdsbLol =
    discoveryProviderPreference === "adsblol" || discoveryProviderPreference === "auto";
  const tryOpenSky =
    discoveryProviderPreference === "opensky" || discoveryProviderPreference === "auto";

  if (tryAdsbLol && Date.now() >= adsbLolDiscoveryCooldownUntil) {
    try {
      const flights = await fetchAdsbLolFlights(area, { warmAeroApiFeed: warmFeedMetadata });
      if (flights.length > 0) {
        setCachedFeed(getAreaCacheKey(area), { fetchedAt: Date.now(), flights });
        return jsonResponse(
          { source: "adsblol", center: area.center, radiusMiles: area.radiusMiles, flights },
          { cacheControl: FRESH_CACHE_HEADER }
        );
      }
      // Empty result is suspicious — let OpenSky have a chance instead of
      // returning zero flights to the client.
      console.warn("adsb.lol returned no flights for area; falling back");
    } catch (error) {
      adsbLolDiscoveryCooldownUntil = Date.now() + ADSBLOL_DISCOVERY_COOLDOWN_MS;
      console.error("Failed to load adsb.lol discovery flights", error);
    }
  }

  if (tryOpenSky && canUseOpenSky) {
    try {
      const flights = await fetchOpenSkyFlights(area, { warmAeroApiFeed: warmFeedMetadata });
      setCachedFeed(getAreaCacheKey(area), { fetchedAt: Date.now(), flights });
      return jsonResponse(
        { source: "opensky", center: area.center, radiusMiles: area.radiusMiles, flights },
        { cacheControl: FRESH_CACHE_HEADER }
      );
    } catch (error) {
      console.error("Failed to load OpenSky flights", error);
    }
  }

  // All live providers exhausted — try a stale cache before mock/empty.
  const cachedFlights = getCachedFeed(area);
  if (cachedFlights) {
    return jsonResponse(
      {
        source: tryAdsbLol ? "adsblol-stale" : "opensky-stale",
        center: area.center,
        radiusMiles: area.radiusMiles,
        flights: cachedFlights
      },
      { cacheControl: STALE_CACHE_HEADER }
    );
  }

  if (!canUseOpenSky && !canUseAeroApiDiscovery) {
    return jsonResponse(
      {
        source: "mock",
        center: area.center,
        radiusMiles: area.radiusMiles,
        flights: buildMockFlights(area.center)
      },
      { cacheControl: FRESH_CACHE_HEADER }
    );
  }

  return jsonResponse(
    {
      source: tryAdsbLol ? "adsblol-unavailable" : "opensky-unavailable",
      center: area.center,
      radiusMiles: area.radiusMiles,
      flights: []
    },
    { status: 503, cacheControl: ERROR_CACHE_HEADER }
  );
}
