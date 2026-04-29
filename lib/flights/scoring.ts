import type { Flight } from "@/lib/flights/types";
import { distanceBetweenPointsMiles } from "@/lib/geo";

// Why: this scoring controls each discovery provider's top-N slice
// (currently 80) that gets shipped to the client. It MUST stay aligned
// with the client's `getVisibilityScore` (components/FlightMap.tsx) —
// otherwise flights the client would prefer (e.g., a heavy at 25 mi
// cruising in to KLAX) get cut here before the client can re-rank them.
//
// Tiered model with hard horizons mirrors the client tiers exactly:
//   • magic zone (≤ 8 mi): always priority
//   • GA past 12 mi: hard buried
//   • anything past 35 mi: soft buried (commercials at the edge can still
//     compete if no closer traffic)
//   • bonuses: commercial −12 mi, low altitude (<3000 ft, airborne) −6 mi
//   • penalties: GA on ground +25 mi, commercial on ground +4 mi
//
// Server-side providers can only key commercial-vs-GA on callsign prefix
// (no flightNumber yet at this stage — AeroAPI enrichment runs after
// scoring). The client uses both signals, so a few flights might be
// ranked slightly differently between server and client; that's
// acceptable because the slice is permissive enough (top-80) for the
// client's re-rank to top-50 to recover any borderline cases.
export const DISCOVERY_RANKING_MAGIC_ZONE_MILES = 8;
export const DISCOVERY_RANKING_GA_HORIZON_MILES = 12;
export const DISCOVERY_RANKING_COMMERCIAL_HORIZON_MILES = 35;
export const DISCOVERY_RANKING_COMMERCIAL_BONUS_MILES = 12;
export const DISCOVERY_RANKING_LOW_ALTITUDE_BONUS_MILES = 6;
export const DISCOVERY_RANKING_LOW_ALTITUDE_FEET = 3000;
export const DISCOVERY_RANKING_GROUND_PENALTY_MILES = 25;
export const DISCOVERY_RANKING_COMMERCIAL_GROUND_PENALTY_MILES = 4;
export const DISCOVERY_RANKING_HARD_BURY_OFFSET = 100;
export const DISCOVERY_RANKING_SOFT_BURY_OFFSET = 50;
export const DISCOVERY_RANKING_MAGIC_ZONE_OFFSET = 100;

function isCommercialCallsignIdentity(flight: Flight) {
  const callsign = flight.callsign.trim().toUpperCase();
  return /^[A-Z]{3}\d/.test(callsign) && !/^N\d/.test(callsign);
}

export function getDiscoveryScore(
  flight: Flight,
  center: { latitude: number; longitude: number }
) {
  const miles = distanceBetweenPointsMiles({
    fromLatitude: center.latitude,
    fromLongitude: center.longitude,
    toLatitude: flight.latitude,
    toLongitude: flight.longitude
  });
  const isCommercial = isCommercialCallsignIdentity(flight);

  if (miles <= DISCOVERY_RANKING_MAGIC_ZONE_MILES) {
    return miles - DISCOVERY_RANKING_MAGIC_ZONE_OFFSET;
  }

  if (!isCommercial && miles > DISCOVERY_RANKING_GA_HORIZON_MILES) {
    return miles + DISCOVERY_RANKING_HARD_BURY_OFFSET;
  }
  if (miles > DISCOVERY_RANKING_COMMERCIAL_HORIZON_MILES) {
    return miles + DISCOVERY_RANKING_SOFT_BURY_OFFSET;
  }

  let score = miles;
  if (isCommercial) {
    score -= DISCOVERY_RANKING_COMMERCIAL_BONUS_MILES;
  }
  if (flight.onGround) {
    score += isCommercial
      ? DISCOVERY_RANKING_COMMERCIAL_GROUND_PENALTY_MILES
      : DISCOVERY_RANKING_GROUND_PENALTY_MILES;
  } else if (
    flight.altitudeFeet != null &&
    flight.altitudeFeet < DISCOVERY_RANKING_LOW_ALTITUDE_FEET
  ) {
    score -= DISCOVERY_RANKING_LOW_ALTITUDE_BONUS_MILES;
  }
  return score;
}
