// Why: ICAO 4-character aircraft type designators are precise but
// cryptic — "B738" means Boeing 737-800, "AS50" means an Airbus H125
// (formerly Eurocopter AS350), "PRM1" means a Hawker Premier. This
// table maps the designators we see most often in LA-area airspace
// to a short consumer-friendly name (for the badge), a full
// manufacturer + model name (for the tooltip), and a category — so
// we can pick the right icon (Plane vs Helicopter) and let future
// callers filter by category.
//
// Coverage: top commercial widebody / narrowbody, regional, business
// jets, common GA, and helicopters. Unmapped types fall back to the
// raw ICAO designator at the call site — still better than nothing.
//
// Add an entry when you see an aircraft type rendering as a 4-character
// ICAO that doesn't match consumer naming.

export type AircraftCategory =
  | "airliner"
  | "regional"
  | "business-jet"
  | "general-aviation"
  | "helicopter";

export type AircraftType = {
  short: string;
  full: string;
  category: AircraftCategory;
};

// Why: tiny per-category builder helpers keep the data table readable.
// Each row visually announces its category by the wrapper used, rather
// than each row repeating `category: "airliner"`.
const airliner = (short: string, full: string): AircraftType => ({
  short,
  full,
  category: "airliner"
});
const regional = (short: string, full: string): AircraftType => ({
  short,
  full,
  category: "regional"
});
const bizjet = (short: string, full: string): AircraftType => ({
  short,
  full,
  category: "business-jet"
});
const ga = (short: string, full: string): AircraftType => ({
  short,
  full,
  category: "general-aviation"
});
const heli = (short: string, full: string): AircraftType => ({
  short,
  full,
  category: "helicopter"
});

export const AIRCRAFT_TYPES_BY_ICAO: Readonly<Record<string, AircraftType>> = {
  // ── Airbus narrowbody ──
  A318: airliner("A318", "Airbus A318"),
  A319: airliner("A319", "Airbus A319"),
  A320: airliner("A320", "Airbus A320"),
  A321: airliner("A321", "Airbus A321"),
  A19N: airliner("A319neo", "Airbus A319neo"),
  A20N: airliner("A320neo", "Airbus A320neo"),
  A21N: airliner("A321neo", "Airbus A321neo"),

  // ── Airbus widebody ──
  A332: airliner("A330-200", "Airbus A330-200"),
  A333: airliner("A330-300", "Airbus A330-300"),
  A338: airliner("A330-800neo", "Airbus A330-800neo"),
  A339: airliner("A330-900neo", "Airbus A330-900neo"),
  A359: airliner("A350-900", "Airbus A350-900"),
  A35K: airliner("A350-1000", "Airbus A350-1000"),
  A388: airliner("A380", "Airbus A380-800"),

  // ── Boeing narrowbody ──
  B712: airliner("717-200", "Boeing 717-200"),
  B737: airliner("737-700", "Boeing 737-700"),
  B738: airliner("737-800", "Boeing 737-800"),
  B739: airliner("737-900", "Boeing 737-900"),
  B37M: airliner("737 MAX 7", "Boeing 737 MAX 7"),
  B38M: airliner("737 MAX 8", "Boeing 737 MAX 8"),
  B39M: airliner("737 MAX 9", "Boeing 737 MAX 9"),
  B3XM: airliner("737 MAX 10", "Boeing 737 MAX 10"),

  // ── Boeing widebody ──
  B744: airliner("747-400", "Boeing 747-400"),
  B748: airliner("747-8", "Boeing 747-8"),
  B752: airliner("757-200", "Boeing 757-200"),
  B753: airliner("757-300", "Boeing 757-300"),
  B762: airliner("767-200", "Boeing 767-200"),
  B763: airliner("767-300", "Boeing 767-300"),
  B764: airliner("767-400", "Boeing 767-400ER"),
  B772: airliner("777-200", "Boeing 777-200"),
  B77L: airliner("777-200LR", "Boeing 777-200LR"),
  B773: airliner("777-300", "Boeing 777-300"),
  B77W: airliner("777-300ER", "Boeing 777-300ER"),
  B788: airliner("787-8", "Boeing 787-8 Dreamliner"),
  B789: airliner("787-9", "Boeing 787-9 Dreamliner"),
  B78X: airliner("787-10", "Boeing 787-10 Dreamliner"),

  // ── Embraer regional ──
  E135: regional("ERJ-135", "Embraer ERJ-135"),
  E145: regional("ERJ-145", "Embraer ERJ-145"),
  E170: regional("E170", "Embraer E170"),
  E75L: regional("E175", "Embraer E175 (long wing)"),
  E75S: regional("E175", "Embraer E175 (short wing)"),
  E190: regional("E190", "Embraer E190"),
  E195: regional("E195", "Embraer E195"),
  E290: regional("E190-E2", "Embraer E190-E2"),
  E295: regional("E195-E2", "Embraer E195-E2"),

  // ── Bombardier / De Havilland regional ──
  CRJ2: regional("CRJ-200", "Bombardier CRJ-200"),
  CRJ7: regional("CRJ-700", "Bombardier CRJ-700"),
  CRJ9: regional("CRJ-900", "Bombardier CRJ-900"),
  CRJX: regional("CRJ-1000", "Bombardier CRJ-1000"),
  DH8C: regional("Dash 8-300", "De Havilland Canada Dash 8-300"),
  DH8D: regional("Dash 8 Q400", "De Havilland Canada Dash 8 Q400"),
  AT72: regional("ATR 72", "ATR 72"),
  AT75: regional("ATR 72-500", "ATR 72-500"),
  AT76: regional("ATR 72-600", "ATR 72-600"),

  // ── McDonnell Douglas (legacy) ──
  MD11: airliner("MD-11", "McDonnell Douglas MD-11"),
  MD80: airliner("MD-80", "McDonnell Douglas MD-80"),
  MD82: airliner("MD-82", "McDonnell Douglas MD-82"),
  MD83: airliner("MD-83", "McDonnell Douglas MD-83"),
  MD88: airliner("MD-88", "McDonnell Douglas MD-88"),
  MD90: airliner("MD-90", "McDonnell Douglas MD-90"),

  // ── Business jets — Gulfstream ──
  GLF4: bizjet("Gulfstream IV", "Gulfstream IV"),
  GLF5: bizjet("Gulfstream V", "Gulfstream V / G550"),
  GLF6: bizjet("Gulfstream G650", "Gulfstream G650"),
  GA5C: bizjet("Gulfstream G280", "Gulfstream G280"),
  GA7C: bizjet("Gulfstream G350", "Gulfstream G350"),

  // ── Business jets — Cessna Citation ──
  C500: bizjet("Citation I", "Cessna Citation I"),
  C525: bizjet("Citation CJ1", "Cessna Citation CJ1"),
  C25A: bizjet("Citation CJ2", "Cessna Citation CJ2"),
  C25B: bizjet("Citation CJ3", "Cessna Citation CJ3"),
  C25C: bizjet("Citation CJ4", "Cessna Citation CJ4"),
  C25M: bizjet("Citation M2", "Cessna Citation M2"),
  C550: bizjet("Citation II", "Cessna Citation II"),
  C56X: bizjet("Citation Excel", "Cessna Citation Excel / XLS"),
  C650: bizjet("Citation III", "Cessna Citation III"),
  C680: bizjet("Citation Sovereign", "Cessna Citation Sovereign"),
  C68A: bizjet("Citation Latitude", "Cessna Citation Latitude"),
  C700: bizjet("Citation Longitude", "Cessna Citation Longitude"),
  C750: bizjet("Citation X", "Cessna Citation X"),

  // ── Business jets — Bombardier Challenger / Global ──
  CL30: bizjet("Challenger 300", "Bombardier Challenger 300"),
  CL35: bizjet("Challenger 350", "Bombardier Challenger 350"),
  CL60: bizjet("Challenger 600", "Bombardier Challenger 600"),
  CL64: bizjet("Challenger 640", "Bombardier Challenger 640"),
  CL65: bizjet("Challenger 650", "Bombardier Challenger 650"),
  GLEX: bizjet("Global Express", "Bombardier Global Express"),
  GL5T: bizjet("Global 5000", "Bombardier Global 5000"),
  GL7T: bizjet("Global 7500", "Bombardier Global 7500"),

  // ── Business jets — Learjet ──
  LJ31: bizjet("Learjet 31", "Learjet 31"),
  LJ35: bizjet("Learjet 35", "Learjet 35"),
  LJ40: bizjet("Learjet 40", "Learjet 40"),
  LJ45: bizjet("Learjet 45", "Learjet 45"),
  LJ55: bizjet("Learjet 55", "Learjet 55"),
  LJ60: bizjet("Learjet 60", "Learjet 60"),
  LJ75: bizjet("Learjet 75", "Learjet 75"),

  // ── Business jets — Embraer ──
  E50P: bizjet("Phenom 100", "Embraer Phenom 100"),
  E55P: bizjet("Phenom 300", "Embraer Phenom 300"),
  E545: bizjet("Praetor 500", "Embraer Praetor 500"),
  E550: bizjet("Legacy 500", "Embraer Legacy 500"),

  // ── Business jets — other ──
  PRM1: bizjet("Premier I", "Hawker Beechcraft Premier I"),
  HA4T: bizjet("Hawker 4000", "Hawker 4000"),
  H25B: bizjet("Hawker 800", "Hawker 800"),
  HDJT: bizjet("HondaJet", "Honda HA-420 HondaJet"),
  PC12: bizjet("Pilatus PC-12", "Pilatus PC-12"),
  PC24: bizjet("Pilatus PC-24", "Pilatus PC-24"),

  // ── General aviation — Cessna ──
  C150: ga("Cessna 150", "Cessna 150"),
  C152: ga("Cessna 152", "Cessna 152"),
  C162: ga("Cessna 162", "Cessna 162 Skycatcher"),
  C172: ga("Cessna 172", "Cessna 172 Skyhawk"),
  C177: ga("Cessna 177", "Cessna 177 Cardinal"),
  C182: ga("Cessna 182", "Cessna 182 Skylane"),
  C206: ga("Cessna 206", "Cessna 206 Stationair"),
  C208: ga("Caravan", "Cessna 208 Caravan"),
  C210: ga("Cessna 210", "Cessna 210 Centurion"),

  // ── General aviation — Piper ──
  PA28: ga("Piper Cherokee", "Piper PA-28 Cherokee"),
  PA32: ga("Piper Saratoga", "Piper PA-32 Saratoga"),
  PA34: ga("Piper Seneca", "Piper PA-34 Seneca"),
  PA38: ga("Piper Tomahawk", "Piper PA-38 Tomahawk"),
  PA44: ga("Piper Seminole", "Piper PA-44 Seminole"),
  PA46: ga("Piper Malibu", "Piper PA-46 Malibu"),

  // ── General aviation — Beechcraft ──
  BE35: ga("Bonanza", "Beechcraft Bonanza"),
  BE36: ga("Bonanza", "Beechcraft 36 Bonanza"),
  BE40: bizjet("Beechjet 400", "Beechjet 400 / Hawker 400"),
  BE55: ga("Baron 55", "Beechcraft Baron 55"),
  BE58: ga("Baron 58", "Beechcraft Baron 58"),
  BE9L: ga("King Air 90", "Beechcraft King Air 90"),
  BE20: ga("King Air 200", "Beechcraft King Air 200"),
  BE30: ga("King Air 350", "Beechcraft King Air 350"),

  // ── General aviation — Diamond ──
  DA40: ga("Diamond DA40", "Diamond DA40 Star"),
  DA42: ga("Diamond DA42", "Diamond DA42 Twin Star"),
  DA62: ga("Diamond DA62", "Diamond DA62"),

  // ── General aviation — Cirrus ──
  SR20: ga("Cirrus SR20", "Cirrus SR20"),
  SR22: ga("Cirrus SR22", "Cirrus SR22"),

  // ── General aviation — Daher TBM ──
  TBM7: ga("TBM 700", "Daher TBM 700"),
  TBM8: ga("TBM 850", "Daher TBM 850"),
  TBM9: ga("TBM 900", "Daher TBM 900"),

  // ── Helicopters — Airbus / Eurocopter / Aérospatiale ──
  // Why: Airbus rebranded the Eurocopter line (AS350 → H125, EC130 →
  // H130, EC135 → H135, EC145 → H145) after the 2014 acquisition, but
  // pilots / ATC / news rosters still say "AS350" and "EC135". Use
  // the legacy name in the badge for recognition; the full tooltip
  // text carries both the new and old names.
  AS50: heli("AS350", "Airbus H125 (Eurocopter AS350)"),
  AS55: heli("AS355", "Eurocopter AS355 Twin Squirrel"),
  AS65: heli("AS365", "Eurocopter AS365 Dauphin"),
  EC20: heli("EC120", "Eurocopter EC120 Colibri"),
  EC30: heli("EC130", "Airbus H130 (Eurocopter EC130)"),
  EC35: heli("EC135", "Airbus H135 (Eurocopter EC135)"),
  EC45: heli("EC145", "Airbus H145 (Eurocopter EC145)"),
  EC55: heli("EC155", "Eurocopter EC155"),

  // ── Helicopters — Leonardo / Agusta ──
  A109: heli("AW109", "Leonardo AW109 (Agusta A109)"),
  A119: heli("AW119", "Leonardo AW119 Koala"),
  A139: heli("AW139", "Leonardo AW139"),
  A169: heli("AW169", "Leonardo AW169"),
  A189: heli("AW189", "Leonardo AW189"),

  // ── Helicopters — Bell ──
  B06: heli("Bell 206", "Bell 206 JetRanger"),
  B06T: heli("Bell 206L", "Bell 206L LongRanger"),
  B407: heli("Bell 407", "Bell 407"),
  B412: heli("Bell 412", "Bell 412"),
  B429: heli("Bell 429", "Bell 429 GlobalRanger"),
  B430: heli("Bell 430", "Bell 430"),
  B47G: heli("Bell 47", "Bell 47"),
  B505: heli("Bell 505", "Bell 505 Jet Ranger X"),

  // ── Helicopters — Sikorsky ──
  H60: heli("UH-60", "Sikorsky UH-60 Black Hawk"),
  S70: heli("S-70", "Sikorsky S-70"),
  S76: heli("S-76", "Sikorsky S-76"),

  // ── Helicopters — Robinson ──
  // Why: "R22" / "R44" / "R66" are unambiguous in the helicopter world
  // — no other manufacturer uses those designators. Drop "Robinson"
  // from the badge for brevity; the full name in the tooltip still
  // carries the manufacturer.
  R22: heli("R22", "Robinson R22"),
  R44: heli("R44", "Robinson R44"),
  R66: heli("R66", "Robinson R66"),

  // ── Helicopters — MD ──
  MD52: heli("MD 520N", "MD Helicopters MD 520N"),
  MD60: heli("MD 600", "MD Helicopters MD 600N"),
  MD90H: heli("MD 900", "MD Helicopters MD 900 Explorer")
};

// Why: returns the structured AircraftType when we have a mapping for
// the given ICAO designator, or null otherwise. Caller decides how to
// fall back (typically: short name for badge, raw ICAO if unmapped,
// "Unknown type" if no ICAO at all).
export function resolveAircraftType(
  icao: string | null | undefined
): AircraftType | null {
  if (!icao) return null;
  const trimmed = icao.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  return AIRCRAFT_TYPES_BY_ICAO[trimmed] ?? null;
}

// Why: convenience wrapper for the common badge case — short name when
// we have a mapping, raw ICAO when we don't, "Unknown type" when the
// flight has no aircraftType field at all. Trims and uppercases the
// raw fallback so we don't display ragged casing.
export function getAircraftTypeBadgeLabel(
  icao: string | null | undefined
): string {
  const resolved = resolveAircraftType(icao);
  if (resolved) return resolved.short;
  const trimmed = icao?.trim().toUpperCase();
  return trimmed && trimmed.length > 0 ? trimmed : "Unknown type";
}

// Why: convenience for picking the badge icon — Plane vs Helicopter.
// Uses the curated table when available; for unmapped types defaults
// to false (plane icon) since the vast majority of unmapped ICAOs are
// fixed-wing GA / business / experimental aircraft. The Lucide
// "Plane" icon reads as a sane default for "this is some kind of
// aircraft" even when the precise type is unknown.
export function isHelicopterType(
  icao: string | null | undefined
): boolean {
  return resolveAircraftType(icao)?.category === "helicopter";
}
