import { NextRequest, NextResponse } from "next/server";
import {
  fetchAeroApiSelectedFlightDetails,
  hasAeroApiCredentials,
  primeAeroApiFeedMetadata
} from "@/lib/flights/aeroapi";
import { fetchAdsbdbSelectedMetadata } from "@/lib/flights/adsbdb";
import { fetchAdsbLolSelectedFlightTrack } from "@/lib/flights/adsblol";
import { fetchOpenSkySelectedFlightTrack } from "@/lib/flights/openskyTrack";
import { hasCommercialFlightIdentity } from "@/lib/flights/scoring";
import { inferOriginFromTrack } from "@/lib/flights/trackInference";
import { lookupFaaOwner } from "@/lib/flights/faaInquiry";
import { looksLikeManufacturerName } from "@/lib/flights/display";
import type { Flight } from "@/lib/flights/types";

// Why: when ADSBdb / AeroAPI / adsb.lol all leave registeredOwner null
// (or return a manufacturer ringer like "Airbus Helicopters" that we know
// isn't a real operator), fall back to the FAA's web inquiry. Cached
// inside lookupFaaOwner so the cost is paid at most once per N-number per
// 24h. Selected-flight enrichment is per-click, so a one-shot await is
// fine — the bulk feed handles its FAA fallback non-blockingly.
async function resolveOwnerWithFaaFallback(
  upstreamOwner: string | null | undefined,
  callsign: string
): Promise<string | null> {
  const upstream = upstreamOwner ?? null;
  if (upstream != null && upstream.trim() !== "" && !looksLikeManufacturerName(upstream)) {
    return upstream;
  }
  const faa = await lookupFaaOwner(callsign);
  return faa ?? upstream;
}

export const revalidate = 0;

function normalizedUpper(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? null;
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
    registeredOwner: searchParams.get("registeredOwner"),
    squawk: searchParams.get("squawk")
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
    const [details, adsbdbMetadata, adsbLolTrack, openSkyTrack] = await Promise.all([
      aeroApiAvailable
        // Why: skipTrack avoids the /flights/{faFlightId}/track AeroAPI
        // call entirely. adsb.lol (with current-leg pruning) and OpenSky
        // give us comprehensive track data without burning AeroAPI quota.
        // We still need AeroAPI for metadata (operator name, airline,
        // route, faFlightId), so the metadata path is unchanged.
        ? fetchAeroApiSelectedFlightDetails(flight, { bypassCache, skipTrack: true })
        : Promise.resolve(null),
      fetchAdsbdbSelectedMetadata(flight),
      fetchAdsbLolSelectedFlightTrack(flight.id).catch((error) => {
        console.error("Failed to load adsb.lol selected flight track", error);
        return [];
      }),
      fetchOpenSkySelectedFlightTrack(flight.id).catch((error) => {
        console.error("Failed to load OpenSky selected flight track fallback", error);
        return [];
      })
    ]);

    // Why: registration mismatch means our resolved AeroAPI flight record is
    // probably not the right *aircraft* (different tail than what OpenSky/ADSBdb
    // reports for this icao24). Don't surface its metadata. But the track
    // points are physical positions for whatever flight AeroAPI did match —
    // and we resolved that match via callsign + position + timing scoring.
    // Most of the time it's still the right physical aircraft and the reg
    // discrepancy is a stale registry record. Trust the track separately so a
    // reg disagreement doesn't blank the trail.
    const aeroApiRegistrationMismatch =
      normalizedUpper(flight.registration) != null &&
      normalizedUpper(details?.registration) != null &&
      normalizedUpper(flight.registration) !== normalizedUpper(details?.registration);
    const trustedAeroApiMetadata = aeroApiRegistrationMismatch ? null : details;
    const aeroApiTrack = details?.track ?? [];

    const hasAnyData =
      trustedAeroApiMetadata != null ||
      adsbdbMetadata != null ||
      aeroApiTrack.length > 0 ||
      adsbLolTrack.length > 0 ||
      openSkyTrack.length > 0;

    // Why: pick whichever track source has the most points for the current
    // leg. AeroAPI is high-quality but can be sparse (e.g., a flight that
    // just departed has only a few recorded positions). adsb.lol's
    // trace_full is pruned to the current leg by isolateCurrentLeg, so it
    // gives full departure-to-now coverage when the flight path is within
    // volunteer feeder coverage. OpenSky is sparse fallback. Picking the
    // longest track avoids surfacing a 3-point AeroAPI sample when adsb.lol
    // already has a comprehensive 200-point trail of the same flight.
    let selectedTrack: typeof aeroApiTrack = [];
    let selectedTrackProvider: "aeroapi" | "adsblol" | "opensky-track" | "none" = "none";
    if (aeroApiTrack.length >= selectedTrack.length) {
      selectedTrack = aeroApiTrack;
      selectedTrackProvider = aeroApiTrack.length > 0 ? "aeroapi" : selectedTrackProvider;
    }
    if (adsbLolTrack.length > selectedTrack.length) {
      selectedTrack = adsbLolTrack;
      selectedTrackProvider = "adsblol";
    }
    if (openSkyTrack.length > selectedTrack.length) {
      selectedTrack = openSkyTrack;
      selectedTrackProvider = "opensky-track";
    }

    // Why: when AeroAPI returns nothing (unfiled VFR — most LA helicopters
    // and pattern Cessnas) and the selected flight has track data, the
    // first leg-pruned trace point is usually the actual takeoff position.
    // Match it to a known LA-area airport, or reverse-geocode to a
    // neighborhood label. Strip card "From KSMO" or "From Bel Air" beats
    // a fallback "Route pending" / "VFR".
    const aeroApiOrigin = trustedAeroApiMetadata?.origin ?? null;
    const adsbdbOrigin =
      flight.flightNumber == null ? adsbdbMetadata?.origin ?? null : null;
    const upstreamOrigin = aeroApiOrigin ?? adsbdbOrigin ?? flight.origin ?? null;
    // Why: only adsb.lol traces go through isolateCurrentLeg. AeroAPI's
    // /track and OpenSky's /tracks/all return points with no leg awareness
    // — their trace[0] could be mid-flight or include yesterday's leg.
    // Running inferOriginFromTrack on those would happily geocode garbage.
    // adsb.lol's leg-pruned trace is the only safe input.
    const trackInferredOrigin =
      upstreamOrigin == null &&
      selectedTrack.length > 0 &&
      selectedTrackProvider === "adsblol"
        ? await inferOriginFromTrack(selectedTrack)
        : null;
    const finalOrigin = upstreamOrigin ?? trackInferredOrigin;

    const resolvedOwner = !hasAnyData
      ? null
      : await resolveOwnerWithFaaFallback(
          trustedAeroApiMetadata?.registeredOwner ??
            adsbdbMetadata?.registeredOwner ??
            flight.registeredOwner,
          flight.callsign
        );

    const mergedDetails = !hasAnyData
      ? null
      : {
          aircraftType:
            trustedAeroApiMetadata?.aircraftType ??
            adsbdbMetadata?.aircraftType ??
            flight.aircraftType,
          airline:
            trustedAeroApiMetadata?.airline ??
            (flight.flightNumber == null ? adsbdbMetadata?.airline : null) ??
            flight.airline,
          destination:
            trustedAeroApiMetadata?.destination ??
            (flight.flightNumber == null ? adsbdbMetadata?.destination : null) ??
            flight.destination,
          faFlightId: trustedAeroApiMetadata?.faFlightId ?? null,
          flightNumber:
            trustedAeroApiMetadata?.flightNumber ??
            (flight.flightNumber == null ? adsbdbMetadata?.flightNumber : null) ??
            flight.flightNumber,
          origin: finalOrigin,
          registration:
            trustedAeroApiMetadata?.registration ??
            adsbdbMetadata?.registration ??
            flight.registration,
          registeredOwner: resolvedOwner,
          status: trustedAeroApiMetadata?.status ?? null,
          // Schedule times only come from AeroAPI; the adsbdb / track
          // fallbacks have no schedule data, so these surface as null
          // when AeroAPI metadata is unavailable. Display layer hides
          // the time line when null.
          scheduledOut: trustedAeroApiMetadata?.scheduledOut ?? null,
          estimatedOut: trustedAeroApiMetadata?.estimatedOut ?? null,
          actualOut: trustedAeroApiMetadata?.actualOut ?? null,
          scheduledIn: trustedAeroApiMetadata?.scheduledIn ?? null,
          estimatedIn: trustedAeroApiMetadata?.estimatedIn ?? null,
          actualIn: trustedAeroApiMetadata?.actualIn ?? null,
          originTimezone: trustedAeroApiMetadata?.originTimezone ?? null,
          destinationTimezone: trustedAeroApiMetadata?.destinationTimezone ?? null,
          track: selectedTrack
        };

    const trackSource: "aeroapi" | "adsblol" | "opensky-track" | "none" =
      selectedTrackProvider;

    function describeSource() {
      if (mergedDetails == null) return "unavailable";
      if (trustedAeroApiMetadata?.faFlightId) return "aeroapi";
      if (adsbdbMetadata && trackSource === "aeroapi") return "aeroapi+adsbdb";
      if (adsbdbMetadata && trackSource === "adsblol") return "adsblol+adsbdb";
      if (adsbdbMetadata) return "adsbdb-fallback";
      if (trackSource === "adsblol") return "adsblol-track-fallback";
      if (trackSource === "opensky-track") return "opensky-track-fallback";
      return "aeroapi";
    }

    if (mergedDetails?.track.length) {
      primeFeedMetadataFromTrustedAeroApiDetails(flight, trustedAeroApiMetadata);

      return jsonResponse(
        { details: mergedDetails, source: describeSource(), trackSource },
        { cacheControl: SELECTED_FRESH_CACHE_HEADER }
      );
    }

    if (mergedDetails) {
      primeFeedMetadataFromTrustedAeroApiDetails(flight, trustedAeroApiMetadata);
    }

    return jsonResponse(
      {
        details: mergedDetails,
        source: describeSource(),
        trackSource
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
      const [adsbdbMetadata, adsbLolTrack, openSkyTrack] = await Promise.all([
        fetchAdsbdbSelectedMetadata(flight),
        fetchAdsbLolSelectedFlightTrack(flight.id).catch(() => []),
        fetchOpenSkySelectedFlightTrack(flight.id)
      ]);

      const fallbackTrack =
        adsbLolTrack.length > 0 ? adsbLolTrack : openSkyTrack;

      const fallbackHasData = adsbdbMetadata != null || fallbackTrack.length > 0;
      const fallbackResolvedOwner = fallbackHasData
        ? await resolveOwnerWithFaaFallback(
            adsbdbMetadata?.registeredOwner ?? flight.registeredOwner,
            flight.callsign
          )
        : null;

      const fallbackDetails = fallbackHasData
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
            registeredOwner: fallbackResolvedOwner,
            status: null,
            // Schedule times are AeroAPI-only; this fallback path runs
            // when AeroAPI failed, so they're all null.
            scheduledOut: null,
            estimatedOut: null,
            actualOut: null,
            scheduledIn: null,
            estimatedIn: null,
            actualIn: null,
            originTimezone: null,
            destinationTimezone: null,
            track: fallbackTrack
          }
        : null;

      return jsonResponse(
        {
          details: fallbackDetails,
          source:
            adsbdbMetadata != null
              ? "adsbdb-fallback"
              : adsbLolTrack.length > 0
                ? "adsblol-track-fallback"
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
