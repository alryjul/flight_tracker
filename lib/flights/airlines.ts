// Why: most provider responses give us the ICAO 3-letter operator code
// ("SKW", "QXE", "AAL") rather than the readable airline name. Useful for
// ATC, useless for a sidebar reading "Operator: SKW". A single static
// lookup keeps every ingestion site honest — adsb.lol, adsbdb, aeroapi,
// opensky — without burning AeroAPI's paid /operators/{code} endpoint
// per flight per poll.
//
// Coverage: top US carriers, US regionals (especially LAX/BUR-area),
// major cargo, and foreign carriers that fly to/through LAX. ~120 entries
// hit ~99% of flights you'd see in West Hollywood airspace; extend
// freely. Unknown codes fall back to the bare ICAO code at the call
// site (still better than nothing, and indicates the gap).

export const AIRLINE_NAMES_BY_ICAO: Readonly<Record<string, string>> = {
  // ── US majors ──
  AAL: "American Airlines",
  AAY: "Allegiant Air",
  ASA: "Alaska Airlines",
  DAL: "Delta Air Lines",
  HAL: "Hawaiian Airlines",
  JBU: "JetBlue",
  MXY: "Breeze Airways",
  NKS: "Spirit Airlines",
  FFT: "Frontier Airlines",
  SCX: "Sun Country",
  SWA: "Southwest Airlines",
  UAL: "United Airlines",

  // ── US regionals (esp. LAX/BUR/LGB feeders) ──
  AWI: "Air Wisconsin",
  CPZ: "Compass Airlines",
  EDV: "Endeavor Air",
  ENY: "Envoy Air",
  GJS: "GoJet Airlines",
  JIA: "PSA Airlines",
  QXE: "Horizon Air",
  RPA: "Republic Airways",
  ASH: "Mesa Airlines",
  SKW: "SkyWest Airlines",
  TCF: "Shuttle America",
  TSC: "Air Transat",

  // ── US cargo / charter ──
  ABX: "ABX Air",
  ATN: "Air Transport International",
  GTI: "Atlas Air",
  FDX: "FedEx Express",
  PCM: "Mountain Air Cargo",
  UPS: "UPS Airlines",
  WGN: "Western Global",
  CKS: "Kalitta Air",
  ASQ: "ExpressJet",
  PAC: "Polar Air Cargo",
  ABW: "AirBridgeCargo",
  CLX: "Cargolux",
  GEC: "Lufthansa Cargo",
  CKK: "China Cargo Airlines",
  GSS: "Atlas Air",

  // ── Canada / Mexico / Caribbean ──
  ACA: "Air Canada",
  JZA: "Jazz Aviation",
  WJA: "WestJet",
  AMX: "Aeroméxico",
  VOI: "Volaris",
  AIJ: "ABC Aerolíneas",
  CUB: "Cubana",

  // ── Europe ──
  AFR: "Air France",
  AUA: "Austrian Airlines",
  BAW: "British Airways",
  BEE: "Flybe",
  BER: "Air Berlin",
  DLH: "Lufthansa",
  EZY: "easyJet",
  FIN: "Finnair",
  IBE: "Iberia",
  KLM: "KLM",
  RYR: "Ryanair",
  SAS: "SAS",
  SWR: "Swiss",
  TAP: "TAP Portugal",
  THY: "Turkish Airlines",
  VIR: "Virgin Atlantic",
  VLG: "Vueling",
  CFG: "Condor",
  SXS: "SunExpress",
  AAB: "Abelag Aviation",
  AEE: "Aegean Airlines",
  AFL: "Aeroflot",
  TVS: "Smartwings",

  // ── Asia / Pacific ──
  ANA: "All Nippon Airways",
  ANZ: "Air New Zealand",
  AAR: "Asiana Airlines",
  CCA: "Air China",
  CES: "China Eastern",
  CSN: "China Southern",
  CHH: "Hainan Airlines",
  CSC: "Sichuan Airlines",
  CSZ: "Shenzhen Airlines",
  CPA: "Cathay Pacific",
  CXA: "Xiamen Airlines",
  EVA: "EVA Air",
  CAL: "China Airlines",
  HVN: "Vietnam Airlines",
  JAL: "Japan Airlines",
  JJP: "Jetstar Japan",
  JST: "Jetstar",
  KAL: "Korean Air",
  LRC: "LATAM",
  MAS: "Malaysia Airlines",
  PAL: "Philippine Airlines",
  QFA: "Qantas",
  QTR: "Qatar Airways",
  SIA: "Singapore Airlines",
  THA: "Thai Airways",
  THT: "Air Tahiti Nui",
  VOZ: "Virgin Australia",
  AIC: "Air India",

  // ── Middle East / Africa ──
  ETD: "Etihad Airways",
  UAE: "Emirates",
  SVA: "Saudia",
  ETH: "Ethiopian Airlines",

  // ── South America ──
  ARG: "Aerolíneas Argentinas",
  AVA: "Avianca",
  CMP: "Copa Airlines",
  GLO: "Gol",
  TAM: "LATAM Brasil",

  // ── US business jet / fractional ──
  EJA: "NetJets",
  FLG: "Flexjet",
  XOJ: "VistaJet",
  WUP: "Wheels Up",

  // ── Charter / private ops ──
  LXJ: "Bombardier Business Jets",
  EJM: "Executive Jet Management",
  JTL: "Jet Linx Aviation",

  // ── Air ambulance / helicopter EMS ──
  CMD: "CALSTAR",
  REA: "REACH Air Medical",
  PHM: "PHI Air Medical",
  MED: "MedFlight"
};

// Why: callsign prefix → ICAO code. Most callsigns *are* the ICAO code
// followed by a flight number (SWA1184 → SWA + 1184). N-numbers and
// short callsigns aren't airlines. Slice the leading 3 alpha chars only;
// reject anything that doesn't look like a commercial callsign.
export function getIcaoOperatorFromCallsign(callsign: string | null): string | null {
  if (!callsign) return null;
  const trimmed = callsign.trim().toUpperCase();
  // N-prefixed registrations (US tail numbers) are not airline operators.
  if (/^N\d/.test(trimmed)) return null;
  // ICAO airline callsign: 3 letters + at least one digit somewhere.
  // Examples: SWA1184, QXE3120, KAL017
  const match = trimmed.match(/^([A-Z]{3})\d/);
  return match ? match[1]! : null;
}

// Why: the public-facing helper. Pass a 3-letter ICAO code (or anything
// that looks like one) and get back the readable airline name, or null
// if we don't have a mapping. Call sites can `resolveAirlineName(code) ?? code`
// to keep the code as a fallback when our table doesn't know the airline.
export function resolveAirlineName(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  return AIRLINE_NAMES_BY_ICAO[trimmed] ?? null;
}

// Why: convenience for "I have a callsign, give me a readable airline
// name if you can." Combines the prefix extraction + lookup; returns
// null for non-airline callsigns (N-numbers, short call signs).
export function deriveAirlineNameFromCallsign(callsign: string | null): string | null {
  return resolveAirlineName(getIcaoOperatorFromCallsign(callsign));
}
