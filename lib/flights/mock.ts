import { APP_CONFIG } from "@/lib/config";
import type { Flight } from "@/lib/flights/types";

const mockFlights: Flight[] = [
  {
    id: "aal2731",
    latitude: 33.9762,
    longitude: -118.4218,
    callsign: "AAL2731",
    flightNumber: "AA2731",
    airline: "American Airlines",
    aircraftType: "A321",
    origin: "LAX",
    destination: "DFW",
    altitudeFeet: 8025,
    groundspeedKnots: 248,
    headingDegrees: 74,
    registration: "N123NN",
    registeredOwner: "American Airlines"
  },
  {
    id: "swa1184",
    latitude: 34.1731,
    longitude: -118.3538,
    callsign: "SWA1184",
    flightNumber: "WN1184",
    airline: "Southwest",
    aircraftType: "B738",
    origin: "BUR",
    destination: "OAK",
    altitudeFeet: 6250,
    groundspeedKnots: 210,
    headingDegrees: 312,
    registration: "N8674B",
    registeredOwner: "Southwest Airlines"
  },
  {
    id: "dal481",
    latitude: 34.0528,
    longitude: -118.2912,
    callsign: "DAL481",
    flightNumber: "DL481",
    airline: "Delta Air Lines",
    aircraftType: "A220",
    origin: "SLC",
    destination: "LAX",
    altitudeFeet: 5480,
    groundspeedKnots: 198,
    headingDegrees: 262,
    registration: "N127DU",
    registeredOwner: "Delta Air Lines"
  },
  {
    id: "asa522",
    latitude: 34.1197,
    longitude: -118.4863,
    callsign: "ASA522",
    flightNumber: "AS522",
    airline: "Alaska Airlines",
    aircraftType: "B39M",
    origin: "SEA",
    destination: "LAX",
    altitudeFeet: 9120,
    groundspeedKnots: 286,
    headingDegrees: 128,
    registration: "N915AK",
    registeredOwner: "Alaska Airlines"
  }
];

export function buildMockFlights() {
  const phase = Math.floor(Date.now() / 8000) % 6;

  return mockFlights.map((flight, index) => ({
    ...flight,
    latitude: flight.latitude + (phase - 2) * 0.004 + index * 0.001,
    longitude: flight.longitude + (phase - 2) * 0.006 - index * 0.001
  }));
}
