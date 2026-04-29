export type Flight = {
  id: string;
  latitude: number;
  longitude: number;
  callsign: string;
  onGround: boolean | null;
  flightNumber: string | null;
  airline: string | null;
  aircraftType: string | null;
  origin: string | null;
  destination: string | null;
  altitudeFeet: number | null;
  groundspeedKnots: number | null;
  headingDegrees: number | null;
  positionTimestampSec: number | null;
  lastContactTimestampSec: number | null;
  registration: string | null;
  registeredOwner: string | null;
  // Why: 4-digit transponder code as a string (preserves leading zeros).
  // 1200 means "VFR, no flight plan" — useful for explaining route gaps
  // (no flight plan filed = no API has origin/destination). Special codes
  // 7500/7600/7700 are also worth surfacing as emergency/lost-comms states
  // if we want them later.
  squawk: string | null;
};
