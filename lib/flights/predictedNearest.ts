import type { Flight } from "@/lib/flights/types";
import { distanceBetweenPointsMiles } from "@/lib/geo";

// Why: how far ahead we extrapolate a flight's position when ranking
// candidates for nearest-plane prefetch. 60s is the right horizon: it's
// long enough that a plane approaching at 500kt (~9.6 mi/min) shows up
// as "becoming closer" while not being so long that the linear-velocity
// assumption breaks down (planes turn, sweep coverage gaps, etc.).
const NEAREST_PREDICTION_HORIZON_SEC = 60;
// Why: below this groundspeed the plane is effectively stationary —
// hovering helicopter, parked-but-still-broadcasting GA, holding pattern
// with low net groundspeed. Linear extrapolation is noise at these
// speeds, so fall back to current distance instead. 5 kt is well below
// any meaningful airborne speed.
const NEAREST_PREDICTION_MIN_SPEED_KNOTS = 5;
const STATUTE_MILES_PER_NAUTICAL_MILE = 1.15077945;

// Why: predict the minimum distance from `flight` to `center` over the
// next NEAREST_PREDICTION_HORIZON_SEC seconds, assuming heading and
// groundspeed remain constant (linear extrapolation). Used by prefetch
// rankers to score candidates by "where will this plane be in the next
// minute" rather than just "where is it now," so a plane currently
// 4th-closest but flying directly at home base outranks a plane
// currently 1st but flying away.
//
// Math: project to a local (north, east) miles frame centered on home
// base. The plane traces the line `p + t·v`. Distance squared
// `|p + t·v|²` is a quadratic in t with minimum at
// `t* = -(p · v) / |v|²`. Clamp t* to [0, horizon]: t* < 0 means already
// past closest (use current), t* > horizon means closest is beyond our
// prediction window (use position at horizon). Falls back to current
// distance when groundspeed or heading aren't reliable enough to
// project.
//
// Flat-Earth math is accurate to ~0.1% over our 250 mi max radius. The
// extra rigor of haversine doesn't matter at these scales and the
// flat-frame math is faster + simpler.
export function predictedMinDistanceMiles(
  flight: Flight,
  center: { latitude: number; longitude: number }
): number {
  const distNow = distanceBetweenPointsMiles({
    fromLatitude: flight.latitude,
    fromLongitude: flight.longitude,
    toLatitude: center.latitude,
    toLongitude: center.longitude
  });

  if (
    flight.groundspeedKnots == null ||
    flight.groundspeedKnots < NEAREST_PREDICTION_MIN_SPEED_KNOTS ||
    flight.headingDegrees == null
  ) {
    return distNow;
  }

  const milesPerDegLat = 69.0;
  const milesPerDegLon = 69.0 * Math.cos((center.latitude * Math.PI) / 180);
  const planeN = (flight.latitude - center.latitude) * milesPerDegLat;
  const planeE = (flight.longitude - center.longitude) * milesPerDegLon;

  const speedMph = flight.groundspeedKnots * STATUTE_MILES_PER_NAUTICAL_MILE;
  const headingRad = (flight.headingDegrees * Math.PI) / 180;
  // Heading: 0 = north, 90 = east. north → +N, east → +E.
  const velN = speedMph * Math.cos(headingRad);
  const velE = speedMph * Math.sin(headingRad);

  const dotPV = planeN * velN + planeE * velE;
  const speedSquared = velN * velN + velE * velE;
  if (speedSquared === 0) return distNow;

  const tStarHours = -dotPV / speedSquared;
  const horizonHours = NEAREST_PREDICTION_HORIZON_SEC / 3600;
  const tEval = Math.max(0, Math.min(tStarHours, horizonHours));

  const futurePosN = planeN + tEval * velN;
  const futurePosE = planeE + tEval * velE;
  return Math.sqrt(futurePosN * futurePosN + futurePosE * futurePosE);
}

// Why: pick the top-N flights most likely to be the next "nearest."
// Pre-computes scores once per flight so the sort comparator doesn't
// recalculate them O(n log n) times — `predictedMinDistanceMiles` does
// a few trig calls per invocation, cheap individually but wasteful when
// the comparator runs 5–8x per item. Returns the original Flight
// objects (not the scored wrappers) so callers can pass them straight
// through to fetchers. Stable across ties via the input order.
export function pickPredictedNearestFlights(
  flights: Flight[],
  center: { latitude: number; longitude: number },
  count: number
): Flight[] {
  if (count <= 0 || flights.length === 0) return [];
  const scored = flights.map((flight) => ({
    flight,
    score: predictedMinDistanceMiles(flight, center)
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, count).map((entry) => entry.flight);
}
