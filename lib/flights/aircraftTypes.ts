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

  // ── Airbus A220 (formerly Bombardier C Series, ICAO still BCSx) ──
  // Why: the ICAO designator hasn't been updated since the 2018 rebrand
  // — AeroAPI still emits "BCS1" / "BCS3" — but the consumer name is
  // "A220-100" / "A220-300". Map to the rebrand for the badge; the
  // tooltip carries both names for context.
  BCS1: airliner("A220-100", "Airbus A220-100 (Bombardier CS100)"),
  BCS3: airliner("A220-300", "Airbus A220-300 (Bombardier CS300)"),

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

  // ── General aviation — Cessna single-engine ──
  // Why: Cessna model numbers (172, 182, 206, etc.) are universally
  // recognized in GA. The Plane icon in the badge plus the bare number
  // gives enough signal; the manufacturer + marketing model name
  // ("Cessna 172 Skyhawk") lives in the tooltip.
  C140: ga("140", "Cessna 140"),
  C150: ga("150", "Cessna 150"),
  C152: ga("152", "Cessna 152"),
  C162: ga("162", "Cessna 162 Skycatcher"),
  C170: ga("170", "Cessna 170"),
  C172: ga("172", "Cessna 172 Skyhawk"),
  C177: ga("177", "Cessna 177 Cardinal"),
  C180: ga("180", "Cessna 180 Skywagon"),
  C182: ga("182", "Cessna 182 Skylane"),
  C185: ga("185", "Cessna 185 Skywagon"),
  C206: ga("206", "Cessna 206 Stationair"),
  C208: ga("Caravan", "Cessna 208 Caravan"),
  C210: ga("210", "Cessna 210 Centurion"),

  // ── General aviation — Cessna twin / turboprop ──
  C310: ga("310", "Cessna 310"),
  C337: ga("337 Skymaster", "Cessna 337 Skymaster (push-pull twin)"),
  C402: ga("402", "Cessna 402 Businessliner"),
  C414: ga("414 Chancellor", "Cessna 414 Chancellor"),
  C421: ga("421 Golden Eagle", "Cessna 421 Golden Eagle"),
  C425: ga("Conquest I", "Cessna 425 Conquest I"),
  C441: ga("Conquest II", "Cessna 441 Conquest II"),

  // ── General aviation — Piper ──
  // Why: Piper marketing names (Cherokee, Saratoga, Seneca, Malibu)
  // are distinctive enough on their own — drop "Piper" from the badge,
  // keep it in the tooltip's full PA-xx designation.
  //
  // ICAO has two designator styles for the PA-28 family: the generic
  // "PA28" (used by some providers) and variant-specific "P28A" /
  // "P28R" / "P28T" (used by others, esp. AeroAPI). Map both styles
  // to the same display so a Cherokee reads consistently regardless
  // of which provider filled aircraftType.
  PA28: ga("Cherokee", "Piper PA-28 Cherokee"),
  P28A: ga("Cherokee", "Piper PA-28 Cherokee (140 / 151 / 161 / 181 / 235)"),
  P28B: ga("Cherokee Six", "Piper PA-28 Cherokee Six"),
  P28R: ga("Cherokee Arrow", "Piper PA-28R Cherokee Arrow"),
  P28T: ga("Turbo Arrow", "Piper PA-28RT Turbo Arrow"),
  PA31: ga("Navajo", "Piper PA-31 Navajo"),
  PA32: ga("Saratoga", "Piper PA-32 Saratoga"),
  P32R: ga("Saratoga", "Piper PA-32R Saratoga (retractable)"),
  PA34: ga("Seneca", "Piper PA-34 Seneca"),
  PA38: ga("Tomahawk", "Piper PA-38 Tomahawk"),
  PA42: ga("Cheyenne III", "Piper PA-42 Cheyenne III / IV"),
  PA44: ga("Seminole", "Piper PA-44 Seminole"),
  PA46: ga("Malibu", "Piper PA-46 Malibu"),
  P46T: ga("Meridian", "Piper PA-46 Meridian (turboprop)"),
  PA60: ga("Aerostar", "Ted Smith / Piper PA-60 Aerostar"),

  // ── General aviation — Beechcraft ──
  BE17: ga("Staggerwing", "Beechcraft Model 17 Staggerwing"),
  BE18: ga("Beech 18", "Beechcraft Model 18 Twin Beech"),
  BE23: ga("Sundowner", "Beechcraft Sundowner"),
  BE33: ga("Debonair", "Beechcraft Debonair"),
  BE35: ga("Bonanza", "Beechcraft Bonanza"),
  BE36: ga("Bonanza", "Beechcraft 36 Bonanza"),
  BE40: bizjet("Beechjet 400", "Beechjet 400 / Hawker 400"),
  BE55: ga("Baron 55", "Beechcraft Baron 55"),
  BE58: ga("Baron 58", "Beechcraft Baron 58"),
  BE60: ga("Duke", "Beechcraft Duke"),
  BE76: ga("Duchess", "Beechcraft Duchess"),
  BE77: ga("Skipper", "Beechcraft Skipper"),
  BE99: ga("Beech 99", "Beechcraft 99 Airliner"),
  BE9L: ga("King Air 90", "Beechcraft King Air 90"),
  BE20: ga("King Air 200", "Beechcraft King Air 200"),
  BE30: ga("King Air 350", "Beechcraft King Air 350"),
  BE40T: bizjet("King Air 400", "Beechcraft King Air 400"),

  // ── General aviation — Diamond ──
  DA40: ga("DA40", "Diamond DA40 Star"),
  DA42: ga("DA42", "Diamond DA42 Twin Star"),
  DA62: ga("DA62", "Diamond DA62"),

  // ── General aviation — Cirrus ──
  SR20: ga("SR20", "Cirrus SR20"),
  SR22: ga("SR22", "Cirrus SR22"),
  S22T: ga("SR22T", "Cirrus SR22T (turbo)"),
  SF50: bizjet("Vision Jet", "Cirrus SF50 Vision Jet"),

  // ── General aviation — Mooney M20 family ──
  // Why: ICAO uses several variant-specific codes (M20J, M20K, M20P,
  // M20T, M20R, etc.) that all read as "Mooney" colloquially. Map
  // each to a useful short label.
  M20J: ga("Mooney 201", "Mooney M20J 201"),
  M20K: ga("Mooney 231", "Mooney M20K 231 / 252"),
  M20P: ga("Mooney M20", "Mooney M20 (piston)"),
  M20R: ga("Mooney Ovation", "Mooney M20R Ovation"),
  M20T: ga("Mooney Acclaim", "Mooney M20TN Acclaim"),

  // ── General aviation — Eclipse ──
  EA50: bizjet("Eclipse 500", "Eclipse 500 / 550"),

  // ── General aviation — Quest / Daher Kodiak ──
  KODI: ga("Kodiak", "Quest / Daher Kodiak 100"),

  // ── General aviation — Lancair / Evolution ──
  LNC4: ga("Lancair IV", "Lancair IV / IV-P"),
  LNC2: ga("Lancair 320", "Lancair 320 / 360"),
  EVOT: ga("Evolution", "Lancair Evolution"),

  // ── General aviation — Aero Commander / Rockwell ──
  AC50: ga("Commander 500", "Aero Commander 500"),
  AC68: ga("Commander 680", "Aero Commander 680 / 690"),
  AC95: ga("Commander 690", "Rockwell Commander 690"),

  // ── General aviation — Aviat / Husky / Pitts ──
  HUSK: ga("Husky", "Aviat A-1 Husky"),
  PTS2: ga("Pitts S-2", "Pitts S-2 Special"),
  PTSA: ga("Pitts Special", "Pitts S-1 Special"),

  // ── General aviation — Extra ──
  EXTR: ga("Extra 300", "Extra 300 / 330"),
  E300: ga("Extra 300", "Extra 300"),

  // ── General aviation — Maule ──
  M5: ga("Maule M-5", "Maule M-5"),
  MX7: ga("Maule MX-7", "Maule MX-7"),

  // ── General aviation — Robin ──
  DR40: ga("Robin DR-400", "Robin DR-400"),

  // ── General aviation — ICON ──
  ICON: ga("ICON A5", "ICON A5 (LSA amphibian)"),

  // ── General aviation — Van's RV experimental homebuilts ──
  // Why: Van's RV-x series is the most common experimental kit-built
  // family in the US. Show as "RV-X" with the model number; tooltip
  // notes it's experimental.
  RV4: ga("RV-4", "Van's RV-4 (experimental)"),
  RV6: ga("RV-6", "Van's RV-6 (experimental)"),
  RV7: ga("RV-7", "Van's RV-7 (experimental)"),
  RV8: ga("RV-8", "Van's RV-8 (experimental)"),
  RV9: ga("RV-9", "Van's RV-9 (experimental)"),
  RV10: ga("RV-10", "Van's RV-10 (experimental)"),
  RV12: ga("RV-12", "Van's RV-12 (LSA)"),
  RV14: ga("RV-14", "Van's RV-14 (experimental)"),

  // ── General aviation — Grumman American AA series ──
  // Why: the AA5 ICAO designator covers the AA-5 Traveler / AA-5A
  // Cheetah / AA-5B Tiger lineage. AA-1 covers the Yankee / Trainer
  // / T-Cat / Lynx 2-seat predecessors. AeroAPI doesn't disambiguate
  // variants, so the badge stays generic.
  AA1: ga("AA-1", "Grumman American AA-1 (Yankee / Trainer / T-Cat / Lynx)"),
  AA5: ga("AA-5", "Grumman American AA-5 (Traveler / Cheetah / Tiger)"),

  // ── General aviation — Sling Aircraft (South African; common at
  //    Sling Pilot Academy at KTOA and other LA-area flight schools) ──
  SLG2: ga("Sling 2", "Sling Aircraft Sling 2"),
  SLG4: ga("Sling 4", "Sling Aircraft Sling 4"),
  SLTS: ga("Sling TSi", "Sling Aircraft Sling TSi"),

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
  B205: heli("Bell 205", "Bell 205 (civilian UH-1H Iroquois)"),
  B212: heli("Bell 212", "Bell 212 Twin Huey"),
  B214: heli("Bell 214", "Bell 214"),
  B222: heli("Bell 222", "Bell 222"),
  B230: heli("Bell 230", "Bell 230"),
  B407: heli("Bell 407", "Bell 407"),
  B412: heli("Bell 412", "Bell 412"),
  B429: heli("Bell 429", "Bell 429 GlobalRanger"),
  B430: heli("Bell 430", "Bell 430"),
  B47G: heli("Bell 47", "Bell 47"),
  B505: heli("Bell 505", "Bell 505 Jet Ranger X"),

  // ── Helicopters — Hughes / MD / Schweizer ──
  H269: heli("Hughes 269", "Hughes / Schweizer 269 (300C/CB/CBi)"),
  S300: heli("Schweizer 300", "Schweizer 300"),
  S330: heli("Schweizer 330", "Schweizer 330SP"),
  S333: heli("Schweizer 333", "Schweizer 333"),
  H500: heli("MD 500", "MD Helicopters MD 500 (Hughes 500)"),
  H530: heli("MD 530", "MD Helicopters MD 530F"),

  // ── Helicopters — Enstrom ──
  EN28: heli("Enstrom 280", "Enstrom F-28 / 280"),
  EN48: heli("Enstrom 480", "Enstrom 480"),

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
  MD90H: heli("MD 900", "MD Helicopters MD 900 Explorer"),

  // ── Military transport / tanker (active LA-area traffic from
  //    Edwards AFB, March ARB, NB Point Mugu, Camp Pendleton) ──
  // Why: regular overflights from western US bases. Use the well-known
  // designation in the badge (C-130, C-17), full type in the tooltip.
  // Categorized as airliner since they're large fixed-wing transports.
  C130: airliner("C-130", "Lockheed C-130 Hercules"),
  C30J: airliner("C-130J", "Lockheed C-130J Super Hercules"),
  C17: airliner("C-17", "Boeing C-17 Globemaster III"),
  C5: airliner("C-5", "Lockheed C-5 Galaxy"),
  C5M: airliner("C-5M", "Lockheed C-5M Super Galaxy"),
  A400: airliner("A400M", "Airbus A400M Atlas"),
  K35R: airliner("KC-135", "Boeing KC-135R Stratotanker"),
  K35E: airliner("KC-135E", "Boeing KC-135E Stratotanker"),
  KC10: airliner("KC-10", "McDonnell Douglas KC-10 Extender"),
  KC46: airliner("KC-46", "Boeing KC-46 Pegasus"),
  C2: airliner("C-2", "Grumman C-2 Greyhound"),
  E3CF: airliner("E-3 Sentry", "Boeing E-3 Sentry (AWACS)"),
  E6: airliner("E-6", "Boeing E-6 Mercury"),

  // ── Military fighter / patrol (less common overhead but possible) ──
  // Categorized as business-jet for icon purposes (it's a fixed-wing
  // jet); the tooltip carries the full military name.
  F16: bizjet("F-16", "General Dynamics F-16 Fighting Falcon"),
  F18: bizjet("F/A-18", "Boeing F/A-18 Hornet"),
  F18S: bizjet("F/A-18 Super Hornet", "Boeing F/A-18E/F Super Hornet"),
  F22: bizjet("F-22", "Lockheed Martin F-22 Raptor"),
  F35: bizjet("F-35", "Lockheed Martin F-35 Lightning II"),

  // ── Warbirds / classic trainers (KSMO / KCMA / KCNO airshow traffic) ──
  T6: ga("T-6 Texan", "North American T-6 Texan / Harvard"),
  AT6: ga("T-6 Texan", "North American AT-6 Texan"),
  T28: ga("T-28 Trojan", "North American T-28 Trojan"),
  T34: ga("T-34 Mentor", "Beechcraft T-34 Mentor"),
  T37: bizjet("T-37 Tweet", "Cessna T-37 Tweet"),
  T38: bizjet("T-38 Talon", "Northrop T-38 Talon"),
  L29: bizjet("L-29 Delfin", "Aero L-29 Delfin"),
  L39: bizjet("L-39 Albatros", "Aero L-39 Albatros"),
  P51: ga("P-51 Mustang", "North American P-51 Mustang"),
  DH82: ga("Tiger Moth", "de Havilland DH.82 Tiger Moth"),

  // ── Helicopters — military (often overhead from Camp Pendleton,
  //    Point Mugu, Edwards) ──
  CH47: heli("CH-47 Chinook", "Boeing CH-47 Chinook"),
  V22: heli("V-22 Osprey", "Bell-Boeing V-22 Osprey"), // tilt-rotor; rendered with helicopter icon
  AH64: heli("AH-64 Apache", "Boeing AH-64 Apache"),
  SH60: heli("SH-60 Seahawk", "Sikorsky SH-60 Seahawk"),
  H53: heli("CH-53", "Sikorsky CH-53 Sea Stallion / Super Stallion")
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

// Why: known multi-word manufacturer prefixes — listed explicitly so
// the simple "first word" derivation below doesn't truncate them
// ("De Havilland" → "De", "McDonnell Douglas" → "McDonnell"). Order
// matters less than membership; we match against the full prefix.
// Add to this list when a new ICAO entry's `full` starts with a
// multi-word brand we want to keep intact.
const MULTI_WORD_MANUFACTURERS = [
  "De Havilland",
  "McDonnell Douglas",
  "General Dynamics",
  "North American",
  "Northrop Grumman"
] as const;

// Why: extract a clean manufacturer name from the curated `full`
// label, suitable for inline display alongside the short type label
// ("Boeing 737-800", "Airbus AS350"). The `full` field can carry
// extra context — model variants ("MAX 8 200ER"), legacy parenthet-
// icals ("(Eurocopter AS350)"), or marketing names ("Sundowner") —
// which is great for tooltips but noisy as a quick-read label. This
// helper strips the parenthetical and pulls just the manufacturer
// token (or two-word brand when whitelisted), giving a stable
// "Airbus" / "Boeing" / "Bell" / etc.
//
// Returns null when the type is unmapped (no curated entry to derive
// from). Callers can fall back to whatever raw display they prefer
// in that case.
export function getAircraftManufacturer(
  icao: string | null | undefined
): string | null {
  const resolved = resolveAircraftType(icao);
  if (!resolved) return null;
  // Strip a trailing parenthetical: "Airbus H125 (Eurocopter AS350)"
  // → "Airbus H125".
  const stripped = resolved.full.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (stripped.length === 0) return null;
  for (const brand of MULTI_WORD_MANUFACTURERS) {
    if (stripped === brand || stripped.startsWith(`${brand} `)) {
      return brand;
    }
  }
  // Default: first whitespace-delimited token. Covers single-word
  // brands like Airbus / Boeing / Cessna / Bell / Leonardo / etc.
  const firstToken = stripped.split(/\s+/)[0];
  return firstToken && firstToken.length > 0 ? firstToken : null;
}
