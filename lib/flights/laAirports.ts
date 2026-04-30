// Why: small curated list of airports / heliports in and around the LA
// basin (and a few SoCal regional fields routinely visible from WeHo).
// Used by track-derived origin inference: match a flight's takeoff
// position (first leg-pruned trace point) to the nearest of these,
// turning "VFR" / "Route pending" into "From SMO" when AeroAPI has
// nothing on file.
//
// We store both ICAO (for documentation / future flight-planning use)
// and IATA (for display). Track inference returns the IATA code so its
// output matches AeroAPI's shape — a flight whose origin we infer as
// SMO reads "SMO → LAX" both before AND after AeroAPI catches up,
// rather than flickering between "KSMO → LAX" and "SMO → LAX".
//
// Coordinates are Wikipedia/AirNav airport reference points — close
// enough for the 2.0 mi proximity match used by inferOriginFromTrack
// (which catches the typical 0.5-2 mi climbout phase distance, not just
// the runway itself).
// Add or correct entries here when you notice a flight whose takeoff
// position should have been recognized but wasn't.

export type Airport = {
  icao: string;
  iata: string;
  name: string;
  latitude: number;
  longitude: number;
};

export const LA_AREA_AIRPORTS: Airport[] = [
  // LA basin majors
  { icao: "KLAX", iata: "LAX", name: "Los Angeles International", latitude: 33.9425, longitude: -118.4081 },
  { icao: "KBUR", iata: "BUR", name: "Hollywood Burbank", latitude: 34.2007, longitude: -118.3585 },
  { icao: "KVNY", iata: "VNY", name: "Van Nuys", latitude: 34.2098, longitude: -118.49 },
  { icao: "KSMO", iata: "SMO", name: "Santa Monica", latitude: 34.0158, longitude: -118.4513 },
  { icao: "KHHR", iata: "HHR", name: "Hawthorne", latitude: 33.9228, longitude: -118.3352 },
  { icao: "KTOA", iata: "TOA", name: "Zamperini Field (Torrance)", latitude: 33.8034, longitude: -118.3396 },
  { icao: "KLGB", iata: "LGB", name: "Long Beach", latitude: 33.8177, longitude: -118.1516 },
  { icao: "KFUL", iata: "FUL", name: "Fullerton Municipal", latitude: 33.872, longitude: -117.9799 },
  { icao: "KSNA", iata: "SNA", name: "John Wayne (Orange County)", latitude: 33.6757, longitude: -117.8682 },
  { icao: "KEMT", iata: "EMT", name: "El Monte", latitude: 34.0859, longitude: -118.0353 },
  { icao: "KWHP", iata: "WHP", name: "Whiteman", latitude: 34.2593, longitude: -118.4135 },
  { icao: "KCMA", iata: "CMA", name: "Camarillo", latitude: 34.2138, longitude: -119.0944 },
  { icao: "KOXR", iata: "OXR", name: "Oxnard", latitude: 34.2008, longitude: -119.207 },
  { icao: "KPOC", iata: "POC", name: "Brackett Field (La Verne)", latitude: 34.0916, longitude: -117.7817 },
  { icao: "KCNO", iata: "CNO", name: "Chino", latitude: 33.9748, longitude: -117.6377 },
  { icao: "KONT", iata: "ONT", name: "Ontario International", latitude: 34.056, longitude: -117.6012 },
  { icao: "KSBD", iata: "SBD", name: "San Bernardino International", latitude: 34.0954, longitude: -117.2353 },
  { icao: "KRIV", iata: "RIV", name: "March ARB / Riverside", latitude: 33.881, longitude: -117.2592 },
  { icao: "KRAL", iata: "RAL", name: "Riverside Municipal", latitude: 33.9519, longitude: -117.4452 },
  { icao: "KAJO", iata: "AJO", name: "Corona Municipal", latitude: 33.8978, longitude: -117.6024 },
  { icao: "KPSP", iata: "PSP", name: "Palm Springs International", latitude: 33.8297, longitude: -116.5067 },
  { icao: "KAVX", iata: "AVX", name: "Catalina (Airport in the Sky)", latitude: 33.405, longitude: -118.4156 },
  { icao: "KSDM", iata: "SDM", name: "Brown Field Municipal (San Diego)", latitude: 32.5723, longitude: -116.9803 },
  { icao: "KCRQ", iata: "CLD", name: "McClellan-Palomar (Carlsbad)", latitude: 33.1283, longitude: -117.2802 },
  { icao: "KMYF", iata: "MYF", name: "Montgomery Field (San Diego)", latitude: 32.8157, longitude: -117.1396 },
  { icao: "KSAN", iata: "SAN", name: "San Diego International", latitude: 32.7338, longitude: -117.1933 },
  { icao: "KAPV", iata: "APV", name: "Apple Valley", latitude: 34.5754, longitude: -117.1856 },
  { icao: "KVCV", iata: "VCV", name: "Southern California Logistics", latitude: 34.5975, longitude: -117.3831 },
  { icao: "KMHV", iata: "MHV", name: "Mojave Air & Space Port", latitude: 35.0594, longitude: -118.1517 },
  { icao: "KEDW", iata: "EDW", name: "Edwards AFB", latitude: 34.9054, longitude: -117.8838 },
  { icao: "KPMD", iata: "PMD", name: "Palmdale Regional / USAF Plant 42", latitude: 34.6294, longitude: -118.0846 },
  { icao: "KWJF", iata: "WJF", name: "General Wm. J. Fox (Lancaster)", latitude: 34.7411, longitude: -118.2189 },
  { icao: "KSZP", iata: "SZP", name: "Santa Paula", latitude: 34.3471, longitude: -119.0608 }
];
