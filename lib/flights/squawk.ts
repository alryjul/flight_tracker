import { hasCommercialFlightIdentity } from "@/lib/flights/scoring";
import type { Flight } from "@/lib/flights/types";

// Why: turn squawk codes into something meaningful for both UI labels
// and server-side enrichment routing decisions (whether to spend an
// AeroAPI call on a flight, or skip straight to track-derived origin
// inference).
//
// 1200 is the universal FAA VFR transponder code — "operating under
// visual flight rules with no flight plan filed."
//
// 0200-0277 is the discrete-code range SoCal Approach commonly assigns
// to VFR traffic in the LA basin for VFR flight following. Aircraft on
// the LA-area common pattern (e.g., trainers around SMO/HHR/CMA, news
// helos, LAPD birds) frequently get a code in this range. For our app
// (centered on WeHo), this is a strong "VFR" signal — IFR flights
// would have AeroAPI data via filed plans, so a discrete-code SoCal
// flight without route data is almost always VFR.
//
// Note: 0200-0277 codes are SoCal-specific; we'd need a different
// heuristic for other regions. If the home base ever moves outside
// the LA basin, revisit this.
export function isOperatingVfr(flight: Pick<Flight, "squawk">) {
  const squawk = flight.squawk?.trim();
  if (!squawk) return false;
  if (squawk === "1200") return true;
  if (/^02[0-7][0-7]$/.test(squawk)) return true;
  return false;
}

// Why: a stricter "should we even bother calling AeroAPI for this flight?"
// gate that's a strict superset of isOperatingVfr. Includes:
//   • Definitive VFR (1200 / SoCal range) — known no plan
//   • Null/missing squawk + GA-pattern callsign — likely VFR Cessna or
//     small helo not currently transmitting a squawk. Investigation
//     showed these are mostly pattern-work GA where AeroAPI returns
//     either nothing or just the same origin we'd already infer from
//     the track. Skipping saves real per-minute quota.
//
// Distinct from isOperatingVfr because the UI label needs the *strict*
// "I know this is VFR" signal — we don't want to display "VFR" on a
// flight whose only signal is "no squawk yet." This predicate is the
// looser quota-conservation gate, not a UI assertion.
export function isUnlikelyToHaveAeroApiData(flight: Flight) {
  if (isOperatingVfr(flight)) return true;
  const squawk = flight.squawk?.trim();
  if (!squawk && !hasCommercialFlightIdentity(flight)) return true;
  return false;
}
