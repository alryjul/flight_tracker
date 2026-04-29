import type { Flight } from "@/lib/flights/types";
import { distanceBetweenPointsMiles } from "@/lib/geo";

// Why: tier model with hard horizons. Single source of truth for the
// server-side discovery slice (top-80 candidates per provider) AND the
// client-side visible-flight ranking (top-50 rendered icons / strip
// cards). Keeping them in one place means future tweaks to the tier
// definitions automatically apply everywhere — no chance of drift
// between server and client.
//
// Tiers:
//   • magic zone (≤ 8 mi): score = miles − 100. Always priority.
//   • GA past 12 mi: score = miles + 100. Hard bury.
//   • anything past 35 mi: score = miles + 50. Soft bury (commercials at
//     the edge can still compete if no closer traffic).
//   • In-range bonuses: commercial −12 mi, low altitude (<3000 ft,
//     airborne) −6 mi.
//   • In-range penalties: GA on ground +25 mi, commercial on ground
//     +4 mi.
export const RANKING_MAGIC_ZONE_MILES = 8;
export const RANKING_GA_HORIZON_MILES = 12;
export const RANKING_COMMERCIAL_HORIZON_MILES = 35;
export const RANKING_COMMERCIAL_BONUS_MILES = 12;
export const RANKING_LOW_ALTITUDE_BONUS_MILES = 6;
export const RANKING_LOW_ALTITUDE_FEET = 3000;
export const RANKING_GROUND_PENALTY_MILES = 25;
export const RANKING_COMMERCIAL_GROUND_PENALTY_MILES = 4;
export const RANKING_HARD_BURY_OFFSET = 100;
export const RANKING_SOFT_BURY_OFFSET = 50;
export const RANKING_MAGIC_ZONE_OFFSET = 100;

// Why: ICAO airline callsigns are 3 letters + a flight number digit
// (e.g., UAL2019, SKW4726). N-prefixed registrations look like
// `N<digit>...` so we explicitly exclude them — `N123AB` is a GA
// registration, not a commercial flight number. Single source of truth
// to prevent the four near-duplicates we used to have drifting.
const COMMERCIAL_CALLSIGN_PATTERN = /^[A-Z]{3}\d/;
const GA_N_REGISTRATION_PATTERN = /^N\d/;

export function isCommercialCallsignString(callsign: string | null | undefined) {
  if (callsign == null) return false;
  const normalized = callsign.trim().toUpperCase();
  return (
    COMMERCIAL_CALLSIGN_PATTERN.test(normalized) &&
    !GA_N_REGISTRATION_PATTERN.test(normalized)
  );
}

// Why: shared callsign-prefix check used by feed enrichment, the
// selected-flight metadata trust check, and the strip operator-label
// rendering. Exported so we don't drift between scoring.ts and
// FlightMap.tsx.
export function hasCommercialFlightIdentity(flight: Flight) {
  if (flight.flightNumber) {
    return true;
  }
  return isCommercialCallsignString(flight.callsign);
}

// Why: server-side scoring runs BEFORE AeroAPI feed-metadata enrichment,
// so flightNumber is always null at that point. The callsign-only check
// is the only signal available. Client uses the more permissive
// hasCommercialFlightIdentity (which also considers flightNumber, set by
// enrichment).
function isCommercialCallsignIdentity(flight: Flight) {
  return isCommercialCallsignString(flight.callsign);
}

// Internal: applies the tier model given a precomputed isCommercial flag.
// The two public scoring functions only differ in how they detect
// commercial status — the math itself is identical.
function scoreWithTiers(flight: Flight, miles: number, isCommercial: boolean) {
  if (miles <= RANKING_MAGIC_ZONE_MILES) {
    return miles - RANKING_MAGIC_ZONE_OFFSET;
  }
  if (!isCommercial && miles > RANKING_GA_HORIZON_MILES) {
    return miles + RANKING_HARD_BURY_OFFSET;
  }
  if (miles > RANKING_COMMERCIAL_HORIZON_MILES) {
    return miles + RANKING_SOFT_BURY_OFFSET;
  }

  let score = miles;
  if (isCommercial) {
    score -= RANKING_COMMERCIAL_BONUS_MILES;
  }
  if (flight.onGround) {
    score += isCommercial
      ? RANKING_COMMERCIAL_GROUND_PENALTY_MILES
      : RANKING_GROUND_PENALTY_MILES;
  } else if (
    flight.altitudeFeet != null &&
    flight.altitudeFeet < RANKING_LOW_ALTITUDE_FEET
  ) {
    score -= RANKING_LOW_ALTITUDE_BONUS_MILES;
  }
  return score;
}

function distanceMiles(
  flight: Flight,
  center: { latitude: number; longitude: number }
) {
  return distanceBetweenPointsMiles({
    fromLatitude: center.latitude,
    fromLongitude: center.longitude,
    toLatitude: flight.latitude,
    toLongitude: flight.longitude
  });
}

// Server-side: callsign-only commercial detection (flightNumber not yet
// populated at discovery scoring time).
export function getDiscoveryScore(
  flight: Flight,
  center: { latitude: number; longitude: number }
) {
  return scoreWithTiers(
    flight,
    distanceMiles(flight, center),
    isCommercialCallsignIdentity(flight)
  );
}

// Client-side: callsign + flightNumber commercial detection. Used to
// pick the visible top-50 from the server's top-80 slice.
export function getVisibilityScore(
  flight: Flight,
  center: { latitude: number; longitude: number }
) {
  return scoreWithTiers(
    flight,
    distanceMiles(flight, center),
    hasCommercialFlightIdentity(flight)
  );
}
