import type { SelectedFlightTrackPoint } from "@/lib/flights/aeroapi";
import { LA_AREA_AIRPORTS } from "@/lib/flights/laAirports";
import { distanceBetweenPointsMiles } from "@/lib/geo";

// Why: a track-derived takeoff point should be (a) inside the trace as
// the very first point AFTER leg-pruning (= start of current leg) AND
// (b) actually look like takeoff conditions — low altitude, slow speed.
// If the trace simply starts mid-flight (e.g., adsb.lol's coverage
// kicked in after the aircraft was already airborne), the "first point"
// is just the data window's edge, not the real departure. Inferring an
// origin from that would be wrong.
const TAKEOFF_MAX_ALTITUDE_FT = 1500;
const TAKEOFF_MAX_GROUNDSPEED_KT = 80;

// Why: a takeoff trace's first leg-pruned point is rarely the runway
// itself — adsb.lol coverage tends to kick in once the aircraft is
// already in the climbout phase, typically 0.5-2 mi from the airport
// reference point at 500-1000 ft AGL. 0.3 mi was way too tight (saw
// N241TD lift off from KSMO get geocoded to "Venice" because the
// first post-gap point was 0.79 mi south of the field).
//
// 2.0 mi gives comfortable coverage:
//   • Catches climbout from any LA-area airport (KSMO, KBUR, KVNY,
//     KHHR, KLAX, KSNA, KCMA, etc.)
//   • Stays well clear of the next-nearest airport (LA's airports
//     are 5+ mi apart, so no false attribution)
//   • Combined with the takeoff guard (alt ≤ 1500 ft, gs ≤ 80 kt),
//     prevents a flight overhead at cruise from getting nailed to
//     a random nearby airport
const AIRPORT_MATCH_RADIUS_MILES = 2.0;

function looksLikeTakeoff(point: SelectedFlightTrackPoint): boolean {
  const altOk =
    point.altitudeFeet == null || point.altitudeFeet <= TAKEOFF_MAX_ALTITUDE_FT;
  const gsOk =
    point.groundspeedKnots == null ||
    point.groundspeedKnots <= TAKEOFF_MAX_GROUNDSPEED_KT;
  return altOk && gsOk;
}

function findNearestAirport(latitude: number, longitude: number) {
  let bestMatch: { iata: string; distanceMiles: number } | null = null;
  for (const airport of LA_AREA_AIRPORTS) {
    const distanceMiles = distanceBetweenPointsMiles({
      fromLatitude: latitude,
      fromLongitude: longitude,
      toLatitude: airport.latitude,
      toLongitude: airport.longitude
    });
    if (
      distanceMiles <= AIRPORT_MATCH_RADIUS_MILES &&
      (bestMatch == null || distanceMiles < bestMatch.distanceMiles)
    ) {
      bestMatch = { iata: airport.iata, distanceMiles };
    }
  }
  return bestMatch;
}

// Why: when AeroAPI didn't have an origin (unfiled VFR), the start of
// the leg-pruned adsb.lol trace usually IS the takeoff position.
// Match it to a known airport in LA_AREA_AIRPORTS — if found, return
// the IATA code (matching AeroAPI's display shape) so the route reads
// consistently regardless of which path filled it in.
//
// We deliberately do NOT reverse-geocode the lat/lon when no airport
// matches. Reverse-geocoding produced city/neighborhood labels
// ("Redding", "Fletcher Hills") for fixed-wing flights from airports
// outside our LA-focused DB, which AeroAPI would later supersede with
// a proper IATA code ("RDD", "SEE") — producing a jarring flicker
// like "Redding → LAX" suddenly becoming "RDD → LAX" mid-session.
// Returning null here keeps the route as "Route pending" until
// AeroAPI catches up, which is more honest about what we know.
//
// (Helipad / non-airport AeroAPI origins still get reverse-geocoded
// downstream — AeroAPI emits "L lat lon" pseudo-codes that the
// AeroAPI normalization path resolves separately to "Cedars-Sinai"
// etc., independent of this function.)
//
// Returns null when:
//   • trace is empty
//   • the first point doesn't look like takeoff (mid-flight data start)
//   • takeoff position doesn't match any airport in our DB
export function inferOriginFromTrack(
  trace: SelectedFlightTrackPoint[]
): string | null {
  const first = trace[0];
  if (!first) return null;
  if (!looksLikeTakeoff(first)) return null;

  const airport = findNearestAirport(first.latitude, first.longitude);
  return airport?.iata ?? null;
}
