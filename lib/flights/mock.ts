import { APP_CONFIG } from "@/lib/config";
import type { Flight } from "@/lib/flights/types";

const mockFlightTemplates: Array<
  Omit<
    Flight,
    "latitude" | "longitude"
  > & {
    latitudeOffset: number;
    longitudeOffset: number;
  }
> = [
  {
    id: "aal2731",
    latitudeOffset: -0.1139,
    longitudeOffset: -0.0601,
    callsign: "AAL2731",
    onGround: false,
    flightNumber: "AA2731",
    airline: "American Airlines",
    aircraftType: "A321",
    origin: "LAX",
    destination: "DFW",
    altitudeFeet: 8025,
    groundspeedKnots: 248,
    headingDegrees: 74,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: "N123NN",
    registeredOwner: "American Airlines"
  },
  {
    id: "swa1184",
    latitudeOffset: 0.083,
    longitudeOffset: 0.0079,
    callsign: "SWA1184",
    onGround: false,
    flightNumber: "WN1184",
    airline: "Southwest",
    aircraftType: "B738",
    origin: "BUR",
    destination: "OAK",
    altitudeFeet: 6250,
    groundspeedKnots: 210,
    headingDegrees: 312,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: "N8674B",
    registeredOwner: "Southwest Airlines"
  },
  {
    id: "dal481",
    latitudeOffset: -0.0373,
    longitudeOffset: 0.0705,
    callsign: "DAL481",
    onGround: false,
    flightNumber: "DL481",
    airline: "Delta Air Lines",
    aircraftType: "A220",
    origin: "SLC",
    destination: "LAX",
    altitudeFeet: 5480,
    groundspeedKnots: 198,
    headingDegrees: 262,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: "N127DU",
    registeredOwner: "Delta Air Lines"
  },
  {
    id: "asa522",
    latitudeOffset: 0.0296,
    longitudeOffset: -0.1246,
    callsign: "ASA522",
    onGround: false,
    flightNumber: "AS522",
    airline: "Alaska Airlines",
    aircraftType: "B39M",
    origin: "SEA",
    destination: "LAX",
    altitudeFeet: 9120,
    groundspeedKnots: 286,
    headingDegrees: 128,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: "N915AK",
    registeredOwner: "Alaska Airlines"
  }
];

export function buildMockFlights(
  center: {
    latitude: number;
    longitude: number;
  } = APP_CONFIG.center
) {
  const phase = Math.floor(Date.now() / 8000) % 6;

  return mockFlightTemplates.map((flight, index) => ({
    ...flight,
    latitude:
      center.latitude + flight.latitudeOffset + (phase - 2) * 0.004 + index * 0.001,
    longitude:
      center.longitude + flight.longitudeOffset + (phase - 2) * 0.006 - index * 0.001
  }));
}
