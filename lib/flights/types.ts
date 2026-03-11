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
};
