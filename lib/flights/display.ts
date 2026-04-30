import type { Flight } from "@/lib/flights/types";
import { isOperatingVfr } from "@/lib/flights/squawk";
import { getLiveFlightIdentityKey } from "@/lib/flights/identity";

export function getPrimaryIdentifier(flight: Flight) {
  return flight.flightNumber ?? flight.registration ?? flight.callsign;
}

export function getIdentifierLabel(flight: Flight) {
  if (flight.flightNumber) {
    return "Flight";
  }

  if (flight.registration) {
    return "Registration";
  }

  return "Callsign";
}

// Why: the secondary line under the card title exists to show the ATC
// callsign alongside the IATA-style flight number when they differ —
// "WN1184" big, "SWA1184" small underneath, the dispatcher view next to
// the boarding-pass view. When the two strings happen to be identical
// (charter ops where AeroAPI's ident_iata field echoes the ICAO callsign
// like "PGR1390 / PGR1390", or any flight where there's no IATA mapping
// so callsign IS the primary), rendering the same value twice was a
// duplicate, not a clarification. Compare against the primary directly
// so the dedup applies regardless of which field filled it in.
export function getSecondaryIdentifier(flight: Flight) {
  const primary = getPrimaryIdentifier(flight);
  if (flight.callsign && flight.callsign !== primary) {
    return flight.callsign;
  }

  return null;
}

export function getRouteLabel(flight: Flight) {
  if (flight.origin && flight.destination) {
    return `${flight.origin} to ${flight.destination}`;
  }

  if (flight.origin) {
    return `From ${flight.origin}`;
  }

  if (flight.destination) {
    return `To ${flight.destination}`;
  }

  return null;
}

export function getCompactRouteLabel(flight: Flight) {
  if (flight.origin && flight.destination) {
    return `${flight.origin} > ${flight.destination}`;
  }

  if (flight.origin) {
    return `From ${flight.origin}`;
  }

  if (flight.destination) {
    return `To ${flight.destination}`;
  }

  return null;
}

export function looksLikeManufacturerName(value: string | null) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toUpperCase();
  const manufacturerPrefixes = [
    "AIRBUS",
    "AGUSTA",
    "BEECH",
    "BEECHCRAFT",
    "BELL",
    "BOEING",
    "BOMBARDIER",
    "CESSNA",
    "DIAMOND",
    "EMBRAER",
    "EUROCOPTER",
    "GULFSTREAM",
    "LEONARDO",
    "MCDONNELL DOUGLAS",
    "PILATUS",
    "PIPER",
    "ROBINSON",
    "SIKORSKY",
    "TEXTRON"
  ];

  return manufacturerPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function normalizeRegisteredOwnerLabel(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();
  const normalized = trimmedValue.toUpperCase();

  if (looksLikeManufacturerName(trimmedValue)) {
    return null;
  }

  if (/^LAPD AIR SUPPORT DIVISION$/.test(normalized)) {
    return "LAPD Air Support";
  }

  if (/^LOS ANGELES POLICE DEPARTMENT$/.test(normalized)) {
    return "Los Angeles Police Department";
  }

  if (/^LOS ANGELES COUNTY SHERIFFS DEPARTMENT$/.test(normalized)) {
    return "LA County Sheriff's Department";
  }

  if (/^CALIFORNIA HIGHWAY PATROL$/.test(normalized)) {
    return "California Highway Patrol";
  }

  return trimmedValue;
}

export function looksLikeAgencyLabel(value: string | null) {
  if (!value) {
    return false;
  }

  return /(POLICE|SHERIFF|FIRE|PATROL|AIR SUPPORT|DEPARTMENT)/i.test(value);
}

// Why: a transient null/missing squawk between confirmed VFR squawks
// shouldn't flip the strip card from "VFR" → "Route pending" → "VFR".
// We latch the "VFR" status for an identity for a short window; once
// the squawk transitions to a real non-VFR code the latch is broken
// (the aircraft is genuinely no longer VFR).
const VFR_LATCH_DURATION_MS = 30_000;
// Why: cap the latch map. Long-running sessions accumulate entries as
// aircraft come and go (and identityKey changes on callsign reassign).
// Without this the map grows unbounded.
const VFR_LATCH_MAX_ENTRIES = 200;
const vfrLatchedAtByIdentity = new Map<string, number>();

function getVfrLatchKey(flight: Flight) {
  return getLiveFlightIdentityKey(flight);
}

export function refreshVfrLatchIfApplicable(flight: Flight) {
  if (isOperatingVfr(flight)) {
    const key = getVfrLatchKey(flight);
    // delete-then-set bubbles to "most recent" in insertion order so
    // active aircraft don't LRU-evict.
    vfrLatchedAtByIdentity.delete(key);
    if (vfrLatchedAtByIdentity.size >= VFR_LATCH_MAX_ENTRIES) {
      const oldest = vfrLatchedAtByIdentity.keys().next().value;
      if (oldest !== undefined) {
        vfrLatchedAtByIdentity.delete(oldest);
      }
    }
    vfrLatchedAtByIdentity.set(key, performance.now());
  }
}

export function isFlightVfrForLabel(flight: Flight) {
  if (isOperatingVfr(flight)) return true;
  // Real non-VFR squawk → break the latch (aircraft transitioned).
  const squawk = flight.squawk?.trim();
  if (squawk && squawk.length > 0) return false;
  // Squawk is null/missing → may be a transponder cycle. Honor the
  // recent-VFR latch.
  const latchedAt = vfrLatchedAtByIdentity.get(getVfrLatchKey(flight));
  if (latchedAt == null) return false;
  return performance.now() - latchedAt <= VFR_LATCH_DURATION_MS;
}

export function getRouteFallbackLabel(flight: Flight) {
  if (isFlightVfrForLabel(flight)) {
    return "VFR";
  }
  // Why: previously "Local flight" for GA, "Route pending" for commercial.
  // Confusing because "Local flight" reads like a status assertion when
  // really it just meant "no route data." Unified to "Route pending" —
  // honest about the state (we tried, nothing yet) without implying a
  // category about the flight.
  return "Route pending";
}

export function getStripRouteLabel(flight: Flight) {
  const routeLabel = getRouteLabel(flight);

  if (routeLabel) {
    return routeLabel;
  }

  if (flight.flightNumber) {
    return "Route pending";
  }

  return getRouteFallbackLabel(flight);
}

export function getHoverSubtitle(flight: Flight) {
  return (
    getCompactRouteLabel(flight) ??
    getSecondaryIdentifier(flight) ??
    formatAltitude(flight.altitudeFeet)
  );
}

export function getOperatorLabel(flight: Flight) {
  const airline = flight.airline?.trim() ?? null;
  const registeredOwner = normalizeRegisteredOwnerLabel(flight.registeredOwner);

  // Why: `airline` is typically a 3-letter ICAO code ("SWA", "AAL", "UAL")
  // — useful for ATC, useless for a sidebar reading "Operator: SWA". When
  // we also have a normalized registered owner ("Southwest Airlines"),
  // prefer the readable name. Fall back to the code only when the owner
  // field is missing or filtered out as a manufacturer ringer.
  if (airline && !looksLikeManufacturerName(airline)) {
    return registeredOwner ?? airline;
  }

  return registeredOwner ?? null;
}

export function getOperatorLabelTitle(flight: Flight) {
  const operatorLabel = getOperatorLabel(flight);

  // Why: "Airline" is reserved for scheduled passenger/cargo carriers,
  // not anything-with-a-3-letter-callsign. Real airlines come back with
  // a flightNumber populated (AAL2523 → "AA2523", SWA388 → "WN388",
  // FDX1415 → "FX1415"); air ambulance, charter, EMS, and private ops
  // get an ICAO callsign too (CMD7, EJA471) but no IATA flight number,
  // so they correctly fall through to "Operator".
  if (operatorLabel && flight.airline && flight.flightNumber) {
    return "Airline";
  }

  if (looksLikeAgencyLabel(operatorLabel)) {
    return "Agency";
  }

  // Why: deliberate fallback. We previously tried a fourth "Owner"
  // category for private GA flying under tail-number callsigns, but
  // distinguishing private owners from operating companies that also
  // use tail-number callsigns (Helinet Aviation Services, DYNAMIC
  // AVLEASE INC, etc.) required a keyword-list heuristic that grew
  // every time a new lessor/management firm showed up. "Operator" is
  // never wrong here — a private pilot is literally operating the
  // aircraft — just sometimes less precise than "Owner: John Smith"
  // would be. The maintenance and bug-surface cost wasn't worth the
  // tone gain.
  return "Operator";
}

export function getListSecondaryLeft(flight: Flight) {
  return getOperatorLabel(flight) ?? flight.callsign;
}

export function getAircraftTypeFamily(flight: Flight) {
  const type = flight.aircraftType?.toUpperCase() ?? "";

  if (type.startsWith("H")) {
    return "helicopter";
  }

  if (type.startsWith("C") || type.startsWith("PA") || type.startsWith("BE")) {
    return "general-aviation";
  }

  if (
    type.startsWith("E13") ||
    type.startsWith("E14") ||
    type.startsWith("CRJ") ||
    type.startsWith("AT7")
  ) {
    return "regional";
  }

  if (
    type.startsWith("GLF") ||
    type.startsWith("C25") ||
    type.startsWith("LJ") ||
    type.startsWith("CL")
  ) {
    return "business-jet";
  }

  if (type.startsWith("A") || type.startsWith("B7") || type.startsWith("B3") || type.startsWith("MD")) {
    return "airliner";
  }

  return "unknown";
}

export function looksLikeGeneralAviationFlight(flight: Flight) {
  const callsign = flight.callsign.trim().toUpperCase();
  const registration = flight.registration?.trim().toUpperCase() ?? null;

  if (registration?.startsWith("N")) {
    return true;
  }

  return /^N\d+[A-Z]{0,2}$/.test(callsign);
}

export function getGroundStatusLabel(status: string | null | undefined) {
  const normalizedStatus = status?.trim().toLowerCase() ?? "";

  if (normalizedStatus.includes("taxi")) {
    return "Taxiing";
  }

  if (
    normalizedStatus.includes("landed") ||
    normalizedStatus.includes("arrived") ||
    normalizedStatus.includes("on ground")
  ) {
    return "Landed";
  }

  return null;
}

export function formatAltitude(altitudeFeet: number | null, status?: string | null) {
  if (altitudeFeet != null) {
    return `${altitudeFeet.toLocaleString()} ft`;
  }

  return getGroundStatusLabel(status) ?? "Altitude unknown";
}

export function formatAirspeed(groundspeedKnots: number | null) {
  return groundspeedKnots == null ? "Speed unknown" : `${groundspeedKnots.toLocaleString()} kt`;
}
