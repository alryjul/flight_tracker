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

export function getSecondaryIdentifier(flight: Flight) {
  if (flight.flightNumber) {
    return flight.callsign;
  }

  if (flight.registration && flight.callsign !== flight.registration) {
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

// Why: a flight that's flying under its own N-number (callsign === tail
// number) and has no resolved airline isn't being run as a commercial
// "operation" — it's a private owner flying their own plane. We use this
// signal to swap the dt from "Operator" to "Owner". Charter/EMS/fractional
// (CMD7, EJA471, REA15) keep their ICAO callsigns even when N-registered,
// so they don't match this pattern and stay "Operator".
function isFlyingUnderTailNumber(flight: Flight) {
  return /^N\d+[A-Z]{0,2}$/.test(flight.callsign.trim().toUpperCase());
}

export function getOperatorLabelTitle(flight: Flight) {
  const operatorLabel = getOperatorLabel(flight);

  // Why: "Airline" is reserved for scheduled passenger/cargo carriers,
  // not anything-with-a-3-letter-callsign. Real airlines come back with
  // a flightNumber populated (AAL2523 → "AA2523", SWA388 → "WN388",
  // FDX1415 → "FX1415"); air ambulance, charter, EMS, and private ops
  // get an ICAO callsign too (CMD7, EJA471) but no IATA flight number,
  // so they correctly fall through to "Operator". Using flightNumber as
  // the gate sharpens the previous hasCommercialFlightIdentity check,
  // which incorrectly labeled CALSTAR helicopters as "Airline".
  if (operatorLabel && flight.airline && flight.flightNumber) {
    return "Airline";
  }

  // Why: agency check before owner so LAPD/CHP/sheriff helicopters —
  // which fly under their N-numbers but read more honestly as "Agency"
  // — don't fall into the owner branch.
  if (looksLikeAgencyLabel(operatorLabel)) {
    return "Agency";
  }

  // Why: when a flight's callsign is just its tail number and there's
  // no operating airline string, "Owner" reads more honestly than
  // "Operator" — it's typically a person, LLC, flying club, or flight
  // school whose name appears via the registered-owner field. Saying
  // "Operator: John Smith" implies a commercial operation; "Owner: John
  // Smith" matches reality.
  if (operatorLabel && !flight.airline && isFlyingUnderTailNumber(flight)) {
    return "Owner";
  }

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
