export type Flight = {
  id: string;
  latitude: number;
  longitude: number;
  callsign: string;
  flightNumber: string | null;
  airline: string | null;
  aircraftType: string | null;
  origin: string | null;
  destination: string | null;
  altitudeFeet: number | null;
  groundspeedKnots: number | null;
  headingDegrees: number | null;
  registration: string | null;
  registeredOwner: string | null;
};
