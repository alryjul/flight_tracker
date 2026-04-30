// Why: curated list of airports used by track-derived origin inference.
// When AeroAPI hasn't yet (or doesn't ever) supply a route, the start of
// the leg-pruned adsb.lol trace is matched against the nearest airport
// here so the route reads "From SMO" / "RDD → LAX" instead of "Route
// pending" or — worse — a reverse-geocoded city name that AeroAPI
// would later supersede.
//
// Scope: heavy in the LA basin (the app's home airspace) but extends to
// all California public airports + western US + major US hubs so that
// flights overhead LA from any common origin resolve directly to an
// airport code rather than falling through to reverse-geocode. Add
// entries when you notice a flight whose takeoff position should have
// been recognized but wasn't — the comment in trackInference.ts
// references this file specifically.
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

export type Airport = {
  icao: string;
  iata: string;
  name: string;
  latitude: number;
  longitude: number;
};

export const KNOWN_AIRPORTS: Airport[] = [
  // ── LA basin & SoCal ──
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
  { icao: "KAPV", iata: "APV", name: "Apple Valley", latitude: 34.5754, longitude: -117.1856 },
  { icao: "KVCV", iata: "VCV", name: "Southern California Logistics", latitude: 34.5975, longitude: -117.3831 },
  { icao: "KMHV", iata: "MHV", name: "Mojave Air & Space Port", latitude: 35.0594, longitude: -118.1517 },
  { icao: "KEDW", iata: "EDW", name: "Edwards AFB", latitude: 34.9054, longitude: -117.8838 },
  { icao: "KPMD", iata: "PMD", name: "Palmdale Regional / USAF Plant 42", latitude: 34.6294, longitude: -118.0846 },
  { icao: "KWJF", iata: "WJF", name: "General Wm. J. Fox (Lancaster)", latitude: 34.7411, longitude: -118.2189 },
  { icao: "KSZP", iata: "SZP", name: "Santa Paula", latitude: 34.3471, longitude: -119.0608 },

  // ── San Diego / Imperial ──
  { icao: "KSAN", iata: "SAN", name: "San Diego International", latitude: 32.7338, longitude: -117.1933 },
  { icao: "KSDM", iata: "SDM", name: "Brown Field Municipal (San Diego)", latitude: 32.5723, longitude: -116.9803 },
  { icao: "KMYF", iata: "MYF", name: "Montgomery Field (San Diego)", latitude: 32.8157, longitude: -117.1396 },
  { icao: "KSEE", iata: "SEE", name: "Gillespie Field (El Cajon)", latitude: 32.8262, longitude: -116.9722 },
  { icao: "KCRQ", iata: "CLD", name: "McClellan-Palomar (Carlsbad)", latitude: 33.1283, longitude: -117.2802 },
  { icao: "KOKB", iata: "OKB", name: "Oceanside Municipal", latitude: 33.2172, longitude: -117.3502 },
  { icao: "KIPL", iata: "IPL", name: "Imperial County", latitude: 32.8342, longitude: -115.5786 },
  { icao: "KBLH", iata: "BLH", name: "Blythe", latitude: 33.6192, longitude: -114.7174 },

  // ── Central California coast ──
  { icao: "KSBA", iata: "SBA", name: "Santa Barbara Municipal", latitude: 34.4262, longitude: -119.8403 },
  { icao: "KIZA", iata: "IZA", name: "Santa Ynez", latitude: 34.6068, longitude: -120.0758 },
  { icao: "KSMX", iata: "SMX", name: "Santa Maria Public", latitude: 34.8989, longitude: -120.4574 },
  { icao: "KSBP", iata: "SBP", name: "San Luis Obispo County", latitude: 35.2369, longitude: -120.6411 },
  { icao: "KPRB", iata: "PRB", name: "Paso Robles Municipal", latitude: 35.6730, longitude: -120.6273 },
  { icao: "KMRY", iata: "MRY", name: "Monterey Regional", latitude: 36.5871, longitude: -121.8430 },
  { icao: "KSNS", iata: "SNS", name: "Salinas Municipal", latitude: 36.6628, longitude: -121.6065 },
  { icao: "KWVI", iata: "WVI", name: "Watsonville Municipal", latitude: 36.9357, longitude: -121.79 },

  // ── San Francisco Bay Area ──
  { icao: "KSFO", iata: "SFO", name: "San Francisco International", latitude: 37.6213, longitude: -122.379 },
  { icao: "KOAK", iata: "OAK", name: "Oakland International", latitude: 37.7213, longitude: -122.2207 },
  { icao: "KSJC", iata: "SJC", name: "San Jose Mineta International", latitude: 37.3639, longitude: -121.9289 },
  { icao: "KHWD", iata: "HWD", name: "Hayward Executive", latitude: 37.6593, longitude: -122.1217 },
  { icao: "KPAO", iata: "PAO", name: "Palo Alto", latitude: 37.4612, longitude: -122.115 },
  { icao: "KHAF", iata: "HAF", name: "Half Moon Bay", latitude: 37.5135, longitude: -122.5008 },
  { icao: "KCCR", iata: "CCR", name: "Buchanan Field (Concord)", latitude: 37.9897, longitude: -122.0567 },
  { icao: "KLVK", iata: "LVK", name: "Livermore Municipal", latitude: 37.6934, longitude: -121.8204 },
  { icao: "KAPC", iata: "APC", name: "Napa County", latitude: 38.2132, longitude: -122.281 },
  { icao: "KSTS", iata: "STS", name: "Charles M. Schulz–Sonoma County", latitude: 38.5090, longitude: -122.8127 },

  // ── Sacramento / Northern California ──
  { icao: "KSMF", iata: "SMF", name: "Sacramento International", latitude: 38.6954, longitude: -121.5908 },
  { icao: "KSAC", iata: "SAC", name: "Sacramento Executive", latitude: 38.5125, longitude: -121.4936 },
  { icao: "KMHR", iata: "MHR", name: "Sacramento Mather", latitude: 38.5538, longitude: -121.2974 },
  { icao: "KSCK", iata: "SCK", name: "Stockton Metropolitan", latitude: 37.8942, longitude: -121.2386 },
  { icao: "KMOD", iata: "MOD", name: "Modesto City–County", latitude: 37.6258, longitude: -120.9544 },
  { icao: "KMCE", iata: "MCE", name: "Merced Regional", latitude: 37.2848, longitude: -120.5138 },
  { icao: "KCIC", iata: "CIC", name: "Chico Municipal", latitude: 39.7954, longitude: -121.8585 },
  { icao: "KRDD", iata: "RDD", name: "Redding Municipal", latitude: 40.5090, longitude: -122.2934 },
  { icao: "KACV", iata: "ACV", name: "California Redwood Coast / Humboldt", latitude: 40.9781, longitude: -124.1086 },
  { icao: "KCEC", iata: "CEC", name: "Del Norte County / Crescent City", latitude: 41.7802, longitude: -124.2367 },

  // ── Central Valley / Sierra ──
  { icao: "KFAT", iata: "FAT", name: "Fresno Yosemite International", latitude: 36.7762, longitude: -119.7181 },
  { icao: "KVIS", iata: "VIS", name: "Visalia Municipal", latitude: 36.3167, longitude: -119.3925 },
  { icao: "KBFL", iata: "BFL", name: "Meadows Field (Bakersfield)", latitude: 35.4336, longitude: -119.0577 },
  { icao: "KMMH", iata: "MMH", name: "Mammoth Yosemite", latitude: 37.6240, longitude: -118.8378 },
  { icao: "KBIH", iata: "BIH", name: "Eastern Sierra Regional (Bishop)", latitude: 37.3729, longitude: -118.3636 },
  { icao: "KTRK", iata: "TRK", name: "Truckee Tahoe", latitude: 39.32, longitude: -120.1394 },

  // ── Nevada ──
  { icao: "KLAS", iata: "LAS", name: "Harry Reid International (Las Vegas)", latitude: 36.084, longitude: -115.1537 },
  { icao: "KVGT", iata: "VGT", name: "North Las Vegas", latitude: 36.2106, longitude: -115.1944 },
  { icao: "KHND", iata: "HND", name: "Henderson Executive", latitude: 35.9728, longitude: -115.1336 },
  { icao: "KRNO", iata: "RNO", name: "Reno-Tahoe International", latitude: 39.4991, longitude: -119.7681 },
  { icao: "KTVL", iata: "TVL", name: "Lake Tahoe", latitude: 38.8939, longitude: -119.9954 },

  // ── Arizona ──
  { icao: "KPHX", iata: "PHX", name: "Phoenix Sky Harbor", latitude: 33.4342, longitude: -112.008 },
  { icao: "KIWA", iata: "AZA", name: "Phoenix-Mesa Gateway", latitude: 33.3078, longitude: -111.6555 },
  { icao: "KDVT", iata: "DVT", name: "Phoenix Deer Valley", latitude: 33.6883, longitude: -112.0825 },
  { icao: "KSDL", iata: "SCF", name: "Scottsdale", latitude: 33.6228, longitude: -111.9106 },
  { icao: "KGYR", iata: "GYR", name: "Phoenix Goodyear", latitude: 33.4225, longitude: -112.3756 },
  { icao: "KTUS", iata: "TUS", name: "Tucson International", latitude: 32.1162, longitude: -110.941 },
  { icao: "KFLG", iata: "FLG", name: "Flagstaff Pulliam", latitude: 35.1397, longitude: -111.6711 },
  { icao: "KPRC", iata: "PRC", name: "Prescott Regional", latitude: 34.6545, longitude: -112.4196 },
  { icao: "KIFP", iata: "IFP", name: "Laughlin/Bullhead International", latitude: 35.1574, longitude: -114.56 },

  // ── Pacific Northwest ──
  { icao: "KPDX", iata: "PDX", name: "Portland International", latitude: 45.5887, longitude: -122.5975 },
  { icao: "KHIO", iata: "HIO", name: "Portland Hillsboro", latitude: 45.5404, longitude: -122.9494 },
  { icao: "KTTD", iata: "TTD", name: "Portland Troutdale", latitude: 45.5494, longitude: -122.4019 },
  { icao: "KEUG", iata: "EUG", name: "Mahlon Sweet (Eugene)", latitude: 44.1245, longitude: -123.2122 },
  { icao: "KMFR", iata: "MFR", name: "Rogue Valley International (Medford)", latitude: 42.3742, longitude: -122.873 },
  { icao: "KRDM", iata: "RDM", name: "Roberts Field (Redmond/Bend)", latitude: 44.2541, longitude: -121.15 },
  { icao: "KSEA", iata: "SEA", name: "Seattle-Tacoma International", latitude: 47.4502, longitude: -122.3088 },
  { icao: "KBFI", iata: "BFI", name: "Boeing Field / King County", latitude: 47.53, longitude: -122.3019 },
  { icao: "KRNT", iata: "RNT", name: "Renton Municipal", latitude: 47.4928, longitude: -122.2156 },
  { icao: "KPAE", iata: "PAE", name: "Snohomish County / Paine Field", latitude: 47.9063, longitude: -122.2814 },
  { icao: "KGEG", iata: "GEG", name: "Spokane International", latitude: 47.6199, longitude: -117.5337 },

  // ── Mountain West ──
  { icao: "KSLC", iata: "SLC", name: "Salt Lake City International", latitude: 40.7884, longitude: -111.9778 },
  { icao: "KDEN", iata: "DEN", name: "Denver International", latitude: 39.8617, longitude: -104.6731 },
  { icao: "KAPA", iata: "APA", name: "Centennial (Denver South)", latitude: 39.5701, longitude: -104.8492 },
  { icao: "KBJC", iata: "BJC", name: "Rocky Mountain Metro", latitude: 39.9088, longitude: -105.1172 },
  { icao: "KCOS", iata: "COS", name: "Colorado Springs", latitude: 38.8058, longitude: -104.7008 },
  { icao: "KASE", iata: "ASE", name: "Aspen-Pitkin County", latitude: 39.2232, longitude: -106.8688 },
  { icao: "KEGE", iata: "EGE", name: "Eagle County (Vail)", latitude: 39.6426, longitude: -106.9176 },
  { icao: "KBOI", iata: "BOI", name: "Boise", latitude: 43.5644, longitude: -116.2228 },

  // ── Texas ──
  { icao: "KDFW", iata: "DFW", name: "Dallas/Fort Worth International", latitude: 32.8998, longitude: -97.0403 },
  { icao: "KDAL", iata: "DAL", name: "Dallas Love Field", latitude: 32.8471, longitude: -96.8517 },
  { icao: "KIAH", iata: "IAH", name: "Houston George Bush", latitude: 29.9844, longitude: -95.3414 },
  { icao: "KHOU", iata: "HOU", name: "Houston Hobby", latitude: 29.6454, longitude: -95.2789 },
  { icao: "KAUS", iata: "AUS", name: "Austin-Bergstrom", latitude: 30.1945, longitude: -97.6699 },
  { icao: "KSAT", iata: "SAT", name: "San Antonio International", latitude: 29.5337, longitude: -98.4698 },
  { icao: "KELP", iata: "ELP", name: "El Paso International", latitude: 31.8067, longitude: -106.3781 },

  // ── East Coast & Midwest hubs ──
  { icao: "KORD", iata: "ORD", name: "Chicago O'Hare", latitude: 41.9786, longitude: -87.9048 },
  { icao: "KMDW", iata: "MDW", name: "Chicago Midway", latitude: 41.7868, longitude: -87.7522 },
  { icao: "KATL", iata: "ATL", name: "Atlanta Hartsfield-Jackson", latitude: 33.6407, longitude: -84.4277 },
  { icao: "KJFK", iata: "JFK", name: "New York JFK", latitude: 40.6398, longitude: -73.7789 },
  { icao: "KLGA", iata: "LGA", name: "New York LaGuardia", latitude: 40.7769, longitude: -73.874 },
  { icao: "KEWR", iata: "EWR", name: "Newark Liberty", latitude: 40.6925, longitude: -74.1687 },
  { icao: "KBOS", iata: "BOS", name: "Boston Logan", latitude: 42.3656, longitude: -71.0096 },
  { icao: "KPHL", iata: "PHL", name: "Philadelphia International", latitude: 39.8744, longitude: -75.2424 },
  { icao: "KDCA", iata: "DCA", name: "Reagan National (Washington)", latitude: 38.8512, longitude: -77.0402 },
  { icao: "KIAD", iata: "IAD", name: "Dulles (Washington)", latitude: 38.9531, longitude: -77.4565 },
  { icao: "KBWI", iata: "BWI", name: "Baltimore-Washington", latitude: 39.1754, longitude: -76.6683 },
  { icao: "KMIA", iata: "MIA", name: "Miami International", latitude: 25.7959, longitude: -80.287 },
  { icao: "KFLL", iata: "FLL", name: "Fort Lauderdale-Hollywood", latitude: 26.0726, longitude: -80.1527 },
  { icao: "KMCO", iata: "MCO", name: "Orlando International", latitude: 28.4312, longitude: -81.3081 },
  { icao: "KTPA", iata: "TPA", name: "Tampa International", latitude: 27.9756, longitude: -82.5333 },
  { icao: "KDTW", iata: "DTW", name: "Detroit Metropolitan Wayne County", latitude: 42.2125, longitude: -83.3534 },
  { icao: "KMSP", iata: "MSP", name: "Minneapolis-St. Paul", latitude: 44.8848, longitude: -93.2223 },
  { icao: "KCLT", iata: "CLT", name: "Charlotte Douglas", latitude: 35.214, longitude: -80.9431 },
  { icao: "KMSY", iata: "MSY", name: "Louis Armstrong New Orleans", latitude: 29.9934, longitude: -90.258 },

  // ── Military / federal airfields ──
  // Why: military bases with no commercial passenger service still
  // generate ADS-B traffic (training flights, refueling, transport).
  // Most don't have IATA codes — we use the FAA LID instead, which is
  // also what AeroAPI tends to surface in its `code` field for these
  // fields. KSLI in particular was reverse-geocoding to "Los Alamitos"
  // (the city) instead of resolving to "SLI" — this section closes
  // those gaps for SoCal Navy/Marine/Army airfields plus the major
  // western Air Force bases.
  { icao: "KSLI", iata: "SLI", name: "JFTB Los Alamitos AAF", latitude: 33.79, longitude: -118.0525 },
  { icao: "KNZY", iata: "NZY", name: "NAS North Island (San Diego)", latitude: 32.6993, longitude: -117.2153 },
  { icao: "KNKX", iata: "NKX", name: "MCAS Miramar", latitude: 32.8682, longitude: -117.143 },
  { icao: "KNFG", iata: "NFG", name: "MCAS Camp Pendleton (Munn Field)", latitude: 33.3017, longitude: -117.355 },
  { icao: "KNTD", iata: "NTD", name: "NAS Point Mugu (Ventura County)", latitude: 34.1203, longitude: -119.1212 },
  { icao: "KNJK", iata: "NJK", name: "NAF El Centro", latitude: 32.8294, longitude: -115.6717 },
  { icao: "KNXP", iata: "NXP", name: "MCAGCC Twentynine Palms", latitude: 34.2964, longitude: -116.1622 },
  { icao: "KNID", iata: "NID", name: "NAWS China Lake", latitude: 35.6853, longitude: -117.6913 },
  { icao: "KSUU", iata: "SUU", name: "Travis AFB", latitude: 38.2627, longitude: -121.9272 },
  { icao: "KMCC", iata: "MCC", name: "McClellan Airfield (Sacramento)", latitude: 38.6676, longitude: -121.4007 },
  { icao: "KBAB", iata: "BAB", name: "Beale AFB", latitude: 39.1361, longitude: -121.4366 },
  { icao: "KLUF", iata: "LUF", name: "Luke AFB", latitude: 33.535, longitude: -112.3831 },
  { icao: "KDMA", iata: "DMA", name: "Davis-Monthan AFB", latitude: 32.1665, longitude: -110.8829 },
  { icao: "KFHU", iata: "FHU", name: "Sierra Vista / Fort Huachuca", latitude: 31.5885, longitude: -110.3443 },
  { icao: "KNYL", iata: "YUM", name: "MCAS Yuma / Yuma International", latitude: 32.6566, longitude: -114.6061 },

  // ── Police / public-safety helipads ──
  // Why: LAPD ASD launches almost exclusively from a couple of dedicated
  // helipads that have no IATA code. AeroAPI returns either "L lat lon"
  // pseudo-codes (which then reverse-geocode to neighborhood names like
  // "Downtown") or FAA LIDs like "58CA" — neither of which a casual
  // reader would recognize. Curating these entries (combined with the
  // AIRPORT_CODE_DISPLAY_OVERRIDES table below) lets the route field
  // read "From LAPD Hooper Heliport" / "LAPD Hooper Heliport to BUR"
  // regardless of whether the AeroAPI path or the track-inference path
  // filled the origin.
  //
  // Convention: when an entry has no real IATA, put the canonical
  // readable name in the iata field — that's what the display shows.
  // The icao field becomes a documentation-only agency code (LAPD-H,
  // LAPD-L) since these helipads aren't in ICAO either. LASD Aero
  // Bureau (Long Beach) and LAFD/CHP Air Ops (Van Nuys) are already
  // covered by KLGB / KVNY in the LA basin section above.
  {
    icao: "LAPD-H",
    iata: "LAPD Hooper Heliport",
    name: "LAPD Hooper Memorial Heliport (Piper Tech, Downtown LA)",
    latitude: 34.0594,
    longitude: -118.2381
  },
  {
    icao: "LAPD-L",
    iata: "LAPD Lopez Canyon Heliport",
    name: "LAPD Lopez Canyon Heliport (Sylmar)",
    latitude: 34.3267,
    longitude: -118.3978
  },

  // ── Hawaii ──
  { icao: "PHNL", iata: "HNL", name: "Daniel K. Inouye (Honolulu)", latitude: 21.3187, longitude: -157.9224 },
  { icao: "PHOG", iata: "OGG", name: "Kahului (Maui)", latitude: 20.8986, longitude: -156.4305 },
  { icao: "PHKO", iata: "KOA", name: "Ellison Onizuka Kona", latitude: 19.7388, longitude: -156.0456 },
  { icao: "PHLI", iata: "LIH", name: "Lihue (Kauai)", latitude: 21.976, longitude: -159.3389 },

  // ── Alaska (limited) ──
  { icao: "PANC", iata: "ANC", name: "Ted Stevens Anchorage", latitude: 61.1742, longitude: -149.9962 },
  { icao: "PAFA", iata: "FAI", name: "Fairbanks International", latitude: 64.8151, longitude: -147.856 }
];

// Why: AeroAPI sometimes returns FAA private-use heliport codes
// ("58CA", various others) for facilities that have no IATA — the route
// then reads as a meaningless five-character string. This map rewrites
// those codes at the AeroAPI normalization step to the same canonical
// readable name that the track-inference path uses, so both paths
// agree on the display string regardless of which one filled origin.
//
// Add an entry when you spot a flight whose route reads as a numeric
// FAA LID instead of a recognizable name. Match keys are upper-case;
// codes are normalized before lookup.
export const AIRPORT_CODE_DISPLAY_OVERRIDES: Readonly<Record<string, string>> = {
  "58CA": "LAPD Hooper Heliport"
  // Lopez Canyon's FAA LID is unconfirmed — add when discovered.
};

// Why: thin wrapper that handles trim+upper normalization + null pass-
// through, so call sites don't have to. Returns the override when one
// exists, otherwise the original code unchanged. Returns null only
// when input is null.
export function applyAirportCodeDisplayOverride(
  code: string | null | undefined
): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;
  const upper = trimmed.toUpperCase();
  return AIRPORT_CODE_DISPLAY_OVERRIDES[upper] ?? trimmed;
}
