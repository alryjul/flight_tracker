"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap } from "maplibre-gl";
import { APP_CONFIG } from "@/lib/config";
import {
  distanceBetweenPointsMiles,
  milesToLatitudeDelta,
  milesToLongitudeDelta
} from "@/lib/geo";
import type { Flight } from "@/lib/flights/types";
import type { AeroApiFeedMetadata } from "@/lib/flights/aeroapi";

type FlightApiResponse = {
  center: {
    latitude: number;
    longitude: number;
  };
  flights: Flight[];
  radiusMiles: number;
  source: string;
};

type HomeBaseCenter = {
  latitude: number;
  longitude: number;
};

type SelectedFlightDetailsResponse = {
  details: {
    aircraftType: string | null;
    airline: string | null;
    destination: string | null;
    faFlightId: string | null;
    flightNumber: string | null;
    origin: string | null;
    registration: string | null;
    registeredOwner: string | null;
    status: string | null;
    track: Array<{
      altitudeFeet: number | null;
      groundspeedKnots: number | null;
      heading: number | null;
      latitude: number;
      longitude: number;
      timestamp: string;
    }>;
  } | null;
  source: string;
};

type HoveredFlightState = {
  flightId: string;
  left: number;
  top: number;
};

type FlightSnapshot = {
  capturedAt: number;
  flights: Flight[];
  flightsById: Map<string, Flight>;
};

// Why: critically-damped spring chase. Each "chase episode" begins when a new
// reported position arrives — we capture the icon's current visual position
// as `from`, set `target` to the new reported position, and stamp
// `targetSetAt` with the current frame time. Between updates the rendered
// position evolves continuously toward target via
//   pos(t) = target + (from - target) × exp(-(t - targetSetAt) / SPRING_TAU_SEC)
// The cap timestamp follows the same recurrence with the same time constant
// (`fromProviderTimestampSec` chases `lastProviderTimestampSec`), keeping it
// in lockstep with the icon — that's the invariant that prevents the trail
// from leading the dot.
type FlightAnimationState = {
  averageProviderDeltaSec: number | null;
  identityKey: string;

  // --- Position chase ---
  fromLatitude: number;
  fromLongitude: number;
  targetLatitude: number;
  targetLongitude: number;

  // --- Cap-timestamp chase (matched τ → matches lag dynamics) ---
  fromProviderTimestampSec: number | null;
  lastProviderTimestampSec: number | null;

  // --- Chase episode anchor ---
  // Frame time (performance.now base) when the current target was set.
  // All spring evaluations use elapsed = (frameTime - targetSetAt) / 1000.
  targetSetAt: number;

  // --- Auxiliary (heading/speed for trail filtering, breadcrumbs, debug) ---
  targetGroundspeedKnots: number | null;
  targetHeadingDegrees: number | null;
};

type BreadcrumbPoint = {
  coordinate: [number, number];
  providerTimestampSec: number | null;
};

type FlightBreadcrumbBuffer = {
  points: BreadcrumbPoint[];
  lastSeenAt: number;
};

type SelectedTrackPoint = NonNullable<SelectedFlightDetailsResponse["details"]>["track"][number];

type TrendDirection = "up" | "down" | null;

type RememberedFlightMetadata = Partial<
  Pick<Flight, "aircraftType" | "registration" | "registeredOwner">
>;

type IdentityScopedValue<T> = {
  identityKey: string;
  value: T;
};

const refreshMs = 4000;
const HIDDEN_TAB_REFRESH_MS = 30_000;
const PROXIMITY_RING_MILES = [3, 8];
const HOME_BASE_STORAGE_KEY = "flight-tracker-home-base";
const VISIBLE_FLIGHT_LIMIT = 50;
const VISIBLE_FLIGHT_ENTRY_COUNT = 45;
// Why: bumping the exit rank from 60 → 80 widens the hysteresis band a
// flight has to cross before it gets retracted. Combined with the score's
// hard horizons (which prevent far-away GA from competing for top-50 slots
// at all), this leaves the visible set very stable over time.
const VISIBLE_FLIGHT_EXIT_RANK = 80;
// Why: 60 s linger means a flight that just slipped past the exit rank
// hangs around long enough for a couple of polls to confirm or refute the
// drop, masking any remaining single-poll score jitter.
const VISIBLE_FLIGHT_LINGER_MS = 1000 * 60;

// --- Ranking tuning ---
// The visibility score is base distance from home + adjustments. Tiered:
//   • Within MAGIC_ZONE_MILES: capped negative score → always top-of-list.
//     If you can see it from the front yard, it deserves a slot.
//   • GA beyond GA_HORIZON_MILES: hard buried (Cessna patterns in Pomona
//     stop competing for visibility, ever).
//   • Anything beyond COMMERCIAL_HORIZON_MILES: hard buried (long-range
//     overflights past our useful range).
//   • Inside the eligible bands: weighted bonuses for commercial identity,
//     low altitude (visible approach/departure), and a penalty for cruise
//     altitude (boring overhead dot).
//
// The hard horizons are the main churn-killer: they prevent fringe-rank
// flights from oscillating in/out of the visible set on noise.
const RANKING_MAGIC_ZONE_MILES = 8;
const RANKING_GA_HORIZON_MILES = 12;
const RANKING_COMMERCIAL_HORIZON_MILES = 25;
const RANKING_COMMERCIAL_BONUS_MILES = 8;
const RANKING_LOW_ALTITUDE_BONUS_MILES = 6;
const RANKING_LOW_ALTITUDE_FEET = 3000;
const RANKING_HIGH_CRUISE_PENALTY_MILES = 3;
const RANKING_HIGH_CRUISE_FEET = 30000;
const RANKING_GROUND_PENALTY_MILES = 25;
const RANKING_COMMERCIAL_GROUND_PENALTY_MILES = 8;
const RANKING_HARD_BURY_OFFSET = 100;
const RANKING_SOFT_BURY_OFFSET = 50;
const RANKING_MAGIC_ZONE_OFFSET = 100;
const STRIP_REORDER_INTERVAL_MS = 24000;
const STRIP_REORDER_RANK_THRESHOLD = 2;
const STRIP_REORDER_SCORE_THRESHOLD = 1.25;
const STRIP_RANK_CUE_MS = 2200;
const SNAPSHOT_HISTORY_RETENTION_MS = refreshMs * 18;
// Why: snapshot history is pruned aggressively (72s) because it drives
// animation interpolation and per-poll change detection — it doesn't need
// long memory. But the *selected flight's* breadcrumb trail benefits from
// far more history: a hovering GA helicopter watched for 20 minutes should
// still show its flight path, not just the last 72s. The per-flight buffer
// below is independent of the snapshot pruning.
const FLIGHT_BREADCRUMB_BUFFER_MAX_POINTS = 600;
const FLIGHT_BREADCRUMB_BUFFER_RETENTION_MS = 1000 * 60 * 30;
const SELECTED_TRACK_REFRESH_GRACE_MS = 1000 * 30;
const MAX_TRACK_SEGMENT_MILES = 320;
const MAX_TRACK_TO_AIRCRAFT_MILES = 2.5;
// Why: the bridge connects the trace tail to the first live breadcrumb
// when the temporal-overlap filter has already dropped breadcrumbs the
// trace covers. In nominal operation that gap is small (just past the
// trace's ~1 min lag with adsb.lol full+recent merged). In edge cases —
// brief feeder coverage holes, very fast aircraft, late selection — the
// gap can stretch. We prefer a continuous visual line over a disjoint
// for any plausible same-flight gap, only refusing to bridge when the
// distance is so extreme the data is almost certainly corrupted (e.g.,
// stale trace from a previous flight bleeding through). 100 mi covers
// ~12 min of jet cruise or ~50 min of helicopter — comfortably past
// realistic coverage holes, comfortably short of mistaken-flight
// territory.
const MAX_PROVIDER_TO_BREADCRUMB_CONNECT_MILES = 100;
const MIN_POSITION_CHANGE_MILES = 0.03;
const MAX_POSITION_JITTER_DEADBAND_MILES = 0.12;
// Why: critically-damped spring time constant for the icon-position chase.
// The rendered icon evolves toward the latest reported position via
//   pos += (target - pos) × (1 - exp(-dt / τ))
// In steady-state linear motion with poll interval P, the icon's lag behind
// the *latest reported position* settles at
//   L* = P × τ_avg / (1 - exp(-P/τ))
// which for our P ≈ 4s polls gives ~8 s of icon-lag at τ = 6 s. The cap
// timestamp uses the same τ so trail and icon move in lockstep — that's
// the invariant that prevents the trail from leading the dot.
//
// Tuning intuition: bigger τ = laxer chase = more lag, more glide.
// Smaller τ = stiffer chase = less lag, more reactive (visible "snaps" on
// turns at very small τ). 6 s is the "ambient buttery glide" sweet spot.
const SPRING_TAU_SEC = 8;
// Why: on page load (or when a flight first enters the viewport), the
// spring has nowhere to chase if from = target — icons sit static until the
// next poll lands. We bootstrap by extrapolating the target forward by
// the reported data lag (now − provider timestamp) along the reported
// heading × groundspeed, giving the spring an immediate target to chase.
// Capped because positionTimestampSec can be unreliable for stale or
// outlier reports — 10 s is a generous ceiling that still bounds visible
// "wrong direction" extrapolation if heading happens to be wrong.
const BOOTSTRAP_MAX_EXTRAPOLATION_SEC = 10;
// Why: tuning factors used in two or more places. Naming them (a) makes the
// intent obvious at the call site and (b) prevents the values drifting apart
// when one spot gets tweaked.
//
// PROVIDER_DELTA_EMA_DECAY: the new sample's weight is (1 - decay). Larger
//   decay = slower to react to changing poll cadence. 0.65 gives ~3 polls
//   of effective averaging. Used by the diagnostic and could be useful if
//   we ever want τ to adapt to actual poll cadence.
//
// DEADBAND_FRACTION_OF_EXPECTED_MOVE: tiny moves below this fraction of
//   the expected per-poll move are treated as jitter and suppressed. 0.25
//   = a quarter of expected move, which is small enough to keep the icon
//   visibly responsive yet kills GPS noise on parked aircraft.
const PROVIDER_DELTA_EMA_DECAY = 0.65;
const DEADBAND_FRACTION_OF_EXPECTED_MOVE = 0.25;
const ALTITUDE_TREND_THRESHOLD_FEET = 100;
const AIRSPEED_TREND_THRESHOLD_KNOTS = 5;
const METRIC_TREND_LOOKBACK_MS = 1000 * 30;
const MIN_METRIC_TREND_POINTS = 3;
const SELECTED_ENRICHMENT_RETRY_DELAYS_MS = [6000, 18000, 36000];
const STRIP_HOVER_ECHO_DURATION_MS = 1400;
const STRIP_HOVER_ECHO_BASE_RADIUS = 13;
const STRIP_HOVER_ECHO_GROWTH = 14;
const MAX_BREADCRUMB_OVERLAP_MILES = 0.18;
// Why: when a new poll lands the breadcrumb is appended at the freshly
// reported provider position INSTANTLY, while the icon starts a multi-second
// lerp from its previous rendered position toward that same target. During
// the lerp the breadcrumb sits at a position the icon hasn't visually reached
// yet — so the rendered LineString goes (provider_track) → (breadcrumb_at_new_pos)
// → (icon_at_lerp_pos), which paints a forward-then-back zigzag past the dot.
// Filter breadcrumbs whose forward projection on the icon's heading exceeds
// this tolerance — that drops the in-flight-lerp breadcrumbs without losing
// behind-the-dot ones. ~8 m tolerance keeps the filter from oscillating on
// rounding noise near zero.
const BREADCRUMB_LEAD_TOLERANCE_MILES = 0.005;

function buildRingCoordinates(center: HomeBaseCenter, radiusMiles: number, steps = 72) {
  const coordinates: [number, number][] = [];

  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const latitudeOffset = Math.sin(angle) * milesToLatitudeDelta(radiusMiles);
    const longitudeOffset =
      Math.cos(angle) * milesToLongitudeDelta(radiusMiles, center.latitude + latitudeOffset);

    coordinates.push([center.longitude + longitudeOffset, center.latitude + latitudeOffset]);
  }

  return coordinates;
}

function buildHomeBaseFeatures(center: HomeBaseCenter) {
  return {
    type: "FeatureCollection" as const,
    features: [
      ...PROXIMITY_RING_MILES.map((radiusMiles) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: buildRingCoordinates(center, radiusMiles)
        },
        properties: {
          radiusMiles
        }
      })),
      {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [center.longitude, center.latitude]
        },
        properties: {
          kind: "home-base"
        }
      }
    ]
  };
}

function buildOpeningBounds(center: HomeBaseCenter, radiusMiles: number): LngLatBoundsLike {
  const openingRadiusMiles = Math.min(radiusMiles, APP_CONFIG.openingRadiusMiles);

  return [
    [
      center.longitude - milesToLongitudeDelta(openingRadiusMiles, center.latitude),
      center.latitude - milesToLatitudeDelta(openingRadiusMiles)
    ],
    [
      center.longitude + milesToLongitudeDelta(openingRadiusMiles, center.latitude),
      center.latitude + milesToLatitudeDelta(openingRadiusMiles)
    ]
  ];
}

function getPrimaryIdentifier(flight: Flight) {
  return flight.flightNumber ?? flight.registration ?? flight.callsign;
}

function getIdentifierLabel(flight: Flight) {
  if (flight.flightNumber) {
    return "Flight";
  }

  if (flight.registration) {
    return "Registration";
  }

  return "Callsign";
}

function getSecondaryIdentifier(flight: Flight) {
  if (flight.flightNumber) {
    return flight.callsign;
  }

  if (flight.registration && flight.callsign !== flight.registration) {
    return flight.callsign;
  }

  return null;
}

function getRouteLabel(flight: Flight) {
  if (flight.origin && flight.destination) {
    return `${flight.origin} to ${flight.destination}`;
  }

  if (flight.origin) {
    return `From ${flight.origin}`;
  }

  if (flight.destination) {
    return `To ${flight.destination}`;
  }

  return null;
}

function getCompactRouteLabel(flight: Flight) {
  if (flight.origin && flight.destination) {
    return `${flight.origin} > ${flight.destination}`;
  }

  if (flight.origin) {
    return `From ${flight.origin}`;
  }

  if (flight.destination) {
    return `To ${flight.destination}`;
  }

  return null;
}

function hasCommercialFlightIdentity(flight: Flight) {
  if (flight.flightNumber) {
    return true;
  }

  const callsign = flight.callsign.trim().toUpperCase();

  return /^[A-Z]{3}\d/.test(callsign) && !/^N\d/.test(callsign);
}

function getFeedMetadataMerge(
  flight: Flight,
  details:
    | {
        airline: string | null;
        destination: string | null;
        flightNumber: string | null;
        origin: string | null;
      }
    | null
) {
  if (!details) {
    return null;
  }

  const metadata: AeroApiFeedMetadata = {
    airline: details.airline ?? flight.airline,
    destination: details.destination ?? flight.destination,
    flightNumber: details.flightNumber ?? flight.flightNumber,
    origin: details.origin ?? flight.origin,
    aircraftType: null,
    registration: null
  };

  if (
    metadata.airline == null &&
    metadata.destination == null &&
    metadata.flightNumber == null &&
    metadata.origin == null
  ) {
    return null;
  }

  return metadata;
}

function looksLikeManufacturerName(value: string | null) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toUpperCase();
  const manufacturerPrefixes = [
    "AIRBUS",
    "AGUSTA",
    "BEECH",
    "BEECHCRAFT",
    "BELL",
    "BOEING",
    "BOMBARDIER",
    "CESSNA",
    "DIAMOND",
    "EMBRAER",
    "EUROCOPTER",
    "GULFSTREAM",
    "LEONARDO",
    "MCDONNELL DOUGLAS",
    "PILATUS",
    "PIPER",
    "ROBINSON",
    "SIKORSKY",
    "TEXTRON"
  ];

  return manufacturerPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function normalizeRegisteredOwnerLabel(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();
  const normalized = trimmedValue.toUpperCase();

  if (looksLikeManufacturerName(trimmedValue)) {
    return null;
  }

  if (/^LAPD AIR SUPPORT DIVISION$/.test(normalized)) {
    return "LAPD Air Support";
  }

  if (/^LOS ANGELES POLICE DEPARTMENT$/.test(normalized)) {
    return "Los Angeles Police Department";
  }

  if (/^LOS ANGELES COUNTY SHERIFFS DEPARTMENT$/.test(normalized)) {
    return "LA County Sheriff's Department";
  }

  if (/^CALIFORNIA HIGHWAY PATROL$/.test(normalized)) {
    return "California Highway Patrol";
  }

  return trimmedValue;
}

function looksLikeAgencyLabel(value: string | null) {
  if (!value) {
    return false;
  }

  return /(POLICE|SHERIFF|FIRE|PATROL|AIR SUPPORT|DEPARTMENT)/i.test(value);
}

function getRouteFallbackLabel(flight: Flight) {
  return looksLikeGeneralAviationFlight(flight) ? "Local flight" : "Route pending";
}

function getStripRouteLabel(flight: Flight) {
  const routeLabel = getRouteLabel(flight);

  if (routeLabel) {
    return routeLabel;
  }

  if (flight.flightNumber) {
    return "Route pending";
  }

  return looksLikeGeneralAviationFlight(flight) ? "Local flight" : getRouteFallbackLabel(flight);
}

function getHoverSubtitle(flight: Flight) {
  return getCompactRouteLabel(flight) ?? getSecondaryIdentifier(flight) ?? formatAltitude(flight.altitudeFeet);
}

function getOperatorLabel(flight: Flight) {
  const airline = flight.airline?.trim() ?? null;
  const registeredOwner = normalizeRegisteredOwnerLabel(flight.registeredOwner);

  if (airline && !looksLikeManufacturerName(airline)) {
    return airline;
  }

  return registeredOwner ?? null;
}

function getOperatorLabelTitle(flight: Flight) {
  const airline = flight.airline?.trim() ?? null;
  const operatorLabel = getOperatorLabel(flight);

  if (operatorLabel && airline && operatorLabel === airline && hasCommercialFlightIdentity(flight)) {
    return "Airline";
  }

  if (looksLikeAgencyLabel(operatorLabel)) {
    return "Agency";
  }

  return "Operator";
}

function getListSecondaryLeft(flight: Flight) {
  return getOperatorLabel(flight) ?? flight.callsign;
}

function getAircraftTypeFamily(flight: Flight) {
  const type = flight.aircraftType?.toUpperCase() ?? "";

  if (type.startsWith("H")) {
    return "helicopter";
  }

  if (type.startsWith("C") || type.startsWith("PA") || type.startsWith("BE")) {
    return "general-aviation";
  }

  if (
    type.startsWith("E13") ||
    type.startsWith("E14") ||
    type.startsWith("CRJ") ||
    type.startsWith("AT7")
  ) {
    return "regional";
  }

  if (
    type.startsWith("GLF") ||
    type.startsWith("C25") ||
    type.startsWith("LJ") ||
    type.startsWith("CL")
  ) {
    return "business-jet";
  }

  if (type.startsWith("A") || type.startsWith("B7") || type.startsWith("B3") || type.startsWith("MD")) {
    return "airliner";
  }

  return "unknown";
}

function looksLikeGeneralAviationFlight(flight: Flight) {
  const callsign = flight.callsign.trim().toUpperCase();
  const registration = flight.registration?.trim().toUpperCase() ?? null;

  if (registration?.startsWith("N")) {
    return true;
  }

  return /^N\d+[A-Z]{0,2}$/.test(callsign);
}

function getGroundStatusLabel(status: string | null | undefined) {
  const normalizedStatus = status?.trim().toLowerCase() ?? "";

  if (normalizedStatus.includes("taxi")) {
    return "Taxiing";
  }

  if (
    normalizedStatus.includes("landed") ||
    normalizedStatus.includes("arrived") ||
    normalizedStatus.includes("on ground")
  ) {
    return "Landed";
  }

  return null;
}

function formatAltitude(altitudeFeet: number | null, status?: string | null) {
  if (altitudeFeet != null) {
    return `${altitudeFeet.toLocaleString()} ft`;
  }

  return getGroundStatusLabel(status) ?? "Altitude unknown";
}

function formatAirspeed(groundspeedKnots: number | null) {
  return groundspeedKnots == null ? "Speed unknown" : `${groundspeedKnots.toLocaleString()} kt`;
}

function getMetricTrend(
  values: Array<number | null>,
  threshold: number
): TrendDirection {
  const meaningfulValues = values.filter((value): value is number => value != null);

  if (meaningfulValues.length < MIN_METRIC_TREND_POINTS) {
    return null;
  }

  const firstValue = meaningfulValues[0]!;
  const lastValue = meaningfulValues[meaningfulValues.length - 1]!;
  const netDelta = lastValue - firstValue;

  if (Math.abs(netDelta) < threshold) {
    return null;
  }

  const direction: TrendDirection = netDelta > 0 ? "up" : "down";
  const stepThreshold = Math.max(1, threshold * 0.3);
  let alignedSteps = 0;
  let opposingSteps = 0;

  for (let index = 1; index < meaningfulValues.length; index += 1) {
    const delta = meaningfulValues[index]! - meaningfulValues[index - 1]!;

    if (Math.abs(delta) < stepThreshold) {
      continue;
    }

    if (delta > 0) {
      if (direction === "up") {
        alignedSteps += 1;
      } else {
        opposingSteps += 1;
      }
    } else if (direction === "down") {
      alignedSteps += 1;
    } else {
      opposingSteps += 1;
    }
  }

  if (alignedSteps === 0) {
    return null;
  }

  return alignedSteps >= opposingSteps ? direction : null;
}

function getFlightMetricHistory(
  snapshots: FlightSnapshot[],
  flight: Pick<Flight, "id" | "callsign">,
  getValue: (flight: Flight) => number | null
) {
  const identityKey = getLiveFlightIdentityKey(flight);
  const now = performance.now();

  return snapshots
    .filter((snapshot) => now - snapshot.capturedAt <= METRIC_TREND_LOOKBACK_MS)
    .map((snapshot) => snapshot.flightsById.get(flight.id))
    .filter(
      (snapshotFlight): snapshotFlight is Flight =>
        snapshotFlight != null && getLiveFlightIdentityKey(snapshotFlight) === identityKey
    )
    .map(getValue);
}

function getDistanceFromHomeBaseMiles(flight: Flight, center: HomeBaseCenter) {
  return distanceBetweenPointsMiles({
    fromLatitude: center.latitude,
    fromLongitude: center.longitude,
    toLatitude: flight.latitude,
    toLongitude: flight.longitude
  });
}

function getVisibilityScore(flight: Flight, center: HomeBaseCenter) {
  const miles = getDistanceFromHomeBaseMiles(flight, center);
  const isCommercial = hasCommercialFlightIdentity(flight);

  // Magic zone — anything inside this radius wins regardless of phase or
  // type. The cap at (miles - OFFSET) keeps these flights ordered by
  // distance among themselves but firmly above everything else.
  if (miles <= RANKING_MAGIC_ZONE_MILES) {
    return miles - RANKING_MAGIC_ZONE_OFFSET;
  }

  // Hard horizons — flights past the relevant horizon can't compete for
  // top-50 slots. This is the main churn killer: a fringe-rank flight far
  // away can't oscillate in/out of the visible set on tiny distance noise.
  if (!isCommercial && miles > RANKING_GA_HORIZON_MILES) {
    return miles + RANKING_HARD_BURY_OFFSET;
  }
  if (miles > RANKING_COMMERCIAL_HORIZON_MILES) {
    return miles + RANKING_SOFT_BURY_OFFSET;
  }

  // In-range adjustments
  let score = miles;
  if (isCommercial) {
    score -= RANKING_COMMERCIAL_BONUS_MILES;
  }
  if (flight.onGround) {
    // Taxiing heavies at LAX are still interesting. Parked GA at SMO are
    // not. Different penalties.
    score += isCommercial
      ? RANKING_COMMERCIAL_GROUND_PENALTY_MILES
      : RANKING_GROUND_PENALTY_MILES;
  } else if (flight.altitudeFeet != null) {
    if (flight.altitudeFeet < RANKING_LOW_ALTITUDE_FEET) {
      // Visible approach / departure — surface this strongly.
      score -= RANKING_LOW_ALTITUDE_BONUS_MILES;
    } else if (flight.altitudeFeet > RANKING_HIGH_CRUISE_FEET) {
      // Cruise overhead is a pinpoint dot — less ambient interest.
      score += RANKING_HIGH_CRUISE_PENALTY_MILES;
    }
  }
  return score;
}

function getLiveFlightIdentityKey(flight: Pick<Flight, "id" | "callsign">) {
  return `${flight.id}|${flight.callsign.trim().toUpperCase()}`;
}

function getIdentityScopedValue<T>(
  scopedValue: IdentityScopedValue<T> | undefined,
  flight: Pick<Flight, "id" | "callsign">
) {
  if (!scopedValue) {
    return null;
  }

  return scopedValue.identityKey === getLiveFlightIdentityKey(flight) ? scopedValue.value : null;
}

function getDistanceFromHomeBaseCoordinates(
  latitude: number,
  longitude: number,
  center: HomeBaseCenter
) {
  return distanceBetweenPointsMiles({
    fromLatitude: center.latitude,
    fromLongitude: center.longitude,
    toLatitude: latitude,
    toLongitude: longitude
  });
}

function formatDistanceMiles(distanceMiles: number) {
  return `${distanceMiles.toFixed(1)} mi`;
}

function dedupeCoordinates(coordinates: [number, number][]) {
  return coordinates.filter((point, index, points) => {
    const previousPoint = points[index - 1];

    return previousPoint == null || previousPoint[0] !== point[0] || previousPoint[1] !== point[1];
  });
}

function isValidTrackCoordinate(coordinate: [number, number]) {
  const [longitude, latitude] = coordinate;

  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

// Why: a single teleport point (antenna handoff, stale ICAO assignment,
// transient garbage) used to nuke the entire accumulated trail. Now we
// drop the bad point and keep going. Only after CONSECUTIVE_TELEPORTS_TO_RESET
// bad points in a row do we treat it as a real trajectory discontinuity
// (e.g., wraparound, ICAO reassigned to a flight halfway across the world).
const CONSECUTIVE_TELEPORTS_TO_RESET = 3;

function sanitizeCoordinateSequence(coordinates: [number, number][]) {
  const dedupedCoordinates = dedupeCoordinates(coordinates.filter(isValidTrackCoordinate));
  const sanitizedCoordinates: [number, number][] = [];
  let consecutiveTeleports = 0;

  for (const coordinate of dedupedCoordinates) {
    const previousCoordinate = sanitizedCoordinates[sanitizedCoordinates.length - 1];

    if (!previousCoordinate) {
      sanitizedCoordinates.push(coordinate);
      consecutiveTeleports = 0;
      continue;
    }

    const segmentMiles = distanceBetweenPointsMiles({
      fromLatitude: previousCoordinate[1],
      fromLongitude: previousCoordinate[0],
      toLatitude: coordinate[1],
      toLongitude: coordinate[0]
    });
    const longitudeDelta = Math.abs(coordinate[0] - previousCoordinate[0]);
    const isTeleport = longitudeDelta > 120 || segmentMiles > MAX_TRACK_SEGMENT_MILES;

    if (isTeleport) {
      consecutiveTeleports += 1;
      if (consecutiveTeleports >= CONSECUTIVE_TELEPORTS_TO_RESET) {
        sanitizedCoordinates.length = 0;
        sanitizedCoordinates.push(coordinate);
        consecutiveTeleports = 0;
      }
      continue;
    }

    sanitizedCoordinates.push(coordinate);
    consecutiveTeleports = 0;
  }

  return sanitizedCoordinates;
}

// Why: shared helper for both the legacy snapshot-derived breadcrumbs and the
// new persistent per-flight buffer. Sanitizes the coordinate sequence
// (dedup + teleport tolerance) and re-attaches the original timestamps.
function sanitizeBreadcrumbPoints(rawPoints: BreadcrumbPoint[]) {
  if (rawPoints.length === 0) return [];

  const sanitizedCoordinates = sanitizeCoordinateSequence(
    rawPoints.map((point) => point.coordinate)
  );

  const pointsByCoordinate = new Map<string, BreadcrumbPoint["providerTimestampSec"]>();
  for (const point of rawPoints) {
    const key = `${point.coordinate[0]},${point.coordinate[1]}`;
    if (!pointsByCoordinate.has(key)) {
      pointsByCoordinate.set(key, point.providerTimestampSec);
    }
  }

  const breadcrumbs: BreadcrumbPoint[] = [];
  for (const coordinate of sanitizedCoordinates) {
    const key = `${coordinate[0]},${coordinate[1]}`;
    const providerTimestampSec = pointsByCoordinate.get(key);
    if (providerTimestampSec !== undefined) {
      breadcrumbs.push({ coordinate, providerTimestampSec });
    }
  }
  return breadcrumbs;
}

// Why: only filter by physical id (icao24). Callsign changes mid-session
// (Mode-S transponder updates, ATC re-coding) used to drop pre-change
// breadcrumbs from the trail even though they were the same physical
// aircraft. ICAO24 is permanent per airframe; the callsign is metadata.
function getBreadcrumbPoints(snapshots: FlightSnapshot[], flightId: string) {
  const points = snapshots
    .map((snapshot) => snapshot.flightsById.get(flightId))
    .filter((flight): flight is Flight => flight != null)
    .map((flight) => ({
      coordinate: [flight.longitude, flight.latitude] as [number, number],
      providerTimestampSec: getFlightProviderTimestampSec(flight)
    }));

  return sanitizeBreadcrumbPoints(points);
}

type TrackSegment = [number, number][];

// Why: previously this function applied the `displayedProviderTimestampMs`
// (the playback aircraft's interpolated position-time) as an upper bound on
// every coordinate considered. In practice that culls AeroAPI track points
// captured between OpenSky polls — exactly the freshest segment users want
// to see — and causes the trail to flicker as animation progress crosses the
// boundary. The trail is the *historical record*; the icon is its own
// concern. They're allowed to disagree by a few seconds.
//
// Pipeline:
//   1. Sanitize provider track points (drop teleports, dedupe).
//   2. Filter breadcrumbs collected client-side (cap, lead-projection,
//      provider-overlap dedup).
//   3. Decide topology: if the provider tail is close enough to the
//      breadcrumb head, merge into one segment. Otherwise keep them as
//      two separate LineString segments (rendered as multiple features)
//      — avoids drawing a phantom 14-mi straight line through unverified
//      airspace when adsb.lol's trace is stale relative to the live icon.
//   4. Append the live (interpolated) aircraft position as the tail of the
//      LAST segment — but only when the trail's last data point is older
//      than the icon's playback time, otherwise we'd backtrack from a
//      fresh trail tip to a lagging icon position.
//
// Returns: `TrackSegment[]` — array of disjoint polylines. The renderer
// emits one LineString feature per segment.
function getSanitizedTrackCoordinates(
  track: SelectedFlightDetailsResponse["details"] | null,
  breadcrumbPoints: BreadcrumbPoint[],
  renderedPosition: { latitude: number; longitude: number } | null,
  displayedProviderTimestampMs: number | null,
  iconHeadingDegrees: number | null
): TrackSegment[] {
  const providerTrack = track?.track ?? [];
  // Why: the trail tail can be marginally fresher than the animated icon's
  // playback position because the icon coasts off OpenSky/adsb.lol position
  // snapshots (with 4s polls + 2.5s extrapolation) while the trail comes
  // from adsb.lol's full trace which is updated near-real-time. Without
  // this filter the trail visibly leads the icon by a couple seconds — at
  // 500kt that's a few hundred meters, very noticeable. Drop trail points
  // newer than the icon's playback time so the trail tail aligns with
  // (or sits just behind) the icon. The icon-tail append below then
  // closes any small remaining gap.
  const renderableProviderTrack =
    displayedProviderTimestampMs == null
      ? providerTrack
      : providerTrack.filter((point) => {
          const pointMs = Date.parse(point.timestamp);
          return !Number.isFinite(pointMs) || pointMs <= displayedProviderTimestampMs;
        });
  const sanitizedCoordinates = sanitizeCoordinateSequence(
    renderableProviderTrack.map((point) => [point.longitude, point.latitude] as [number, number])
  );
  const lastProviderTrackTimestampMs = getLastTrackTimestampMs(renderableProviderTrack);
  const firstProviderTrackTimestampMs = getFirstTrackTimestampMs(renderableProviderTrack);

  let trailEndTimestampMs = lastProviderTrackTimestampMs;

  // Why: drop breadcrumbs whose timestamp falls WITHIN the provider track's
  // time range — they're duplicates of points the trace already renders,
  // just at slightly different lat/lon (different sampling cadences /
  // sources). Drawing both produces a visible ghost line parallel to the
  // real track. Breadcrumbs OUTSIDE the trace coverage (older than its
  // head, or newer than its tail) are kept — those fill the gaps.
  //
  // This subsumes the previous "only filter when AeroAPI" heuristic. For
  // sparse OpenSky tracks (short window near the current position),
  // breadcrumbs older than the trace head pass through and still provide
  // the historical trail. For comprehensive tracks (adsb.lol / AeroAPI),
  // the duplicates that caused the ghost line are dropped.
  function breadcrumbOverlapsProviderTrack(point: BreadcrumbPoint): boolean {
    if (
      point.providerTimestampSec == null ||
      firstProviderTrackTimestampMs == null ||
      lastProviderTrackTimestampMs == null
    ) {
      return false;
    }
    const breadcrumbMs = point.providerTimestampSec * 1000;
    return (
      breadcrumbMs >= firstProviderTrackTimestampMs &&
      breadcrumbMs <= lastProviderTrackTimestampMs
    );
  }

  // Why: the time-based cap below isn't enough on its own. For slow GA
  // traffic (~60kt) a breadcrumb appended the moment a poll lands has a
  // timestamp that *just barely* slips under the time-interpolated cap, so
  // the cap doesn't filter it — but the icon hasn't lerped to that position
  // yet, so the breadcrumb sits geographically AHEAD of the dot. This
  // position-based filter rejects breadcrumbs whose forward projection on
  // the icon's heading vector exceeds BREADCRUMB_LEAD_TOLERANCE_MILES,
  // closing the visual "trail leads dot" zigzag during the lerp.
  let breadcrumbLeadFilter:
    | ((point: BreadcrumbPoint) => boolean)
    | null = null;
  if (renderedPosition && iconHeadingDegrees != null) {
    const milesPerDegLat = 69.0;
    const milesPerDegLon =
      69.0 * Math.cos((renderedPosition.latitude * Math.PI) / 180);
    const headingRad = (iconHeadingDegrees * Math.PI) / 180;
    const sinHeading = Math.sin(headingRad);
    const cosHeading = Math.cos(headingRad);
    const iconLat = renderedPosition.latitude;
    const iconLon = renderedPosition.longitude;
    breadcrumbLeadFilter = (point) => {
      const dEastMiles = (point.coordinate[0] - iconLon) * milesPerDegLon;
      const dNorthMiles = (point.coordinate[1] - iconLat) * milesPerDegLat;
      const aheadMiles = dNorthMiles * cosHeading + dEastMiles * sinHeading;
      return aheadMiles <= BREADCRUMB_LEAD_TOLERANCE_MILES;
    };
  }

  // ----- Build provider segment + filter breadcrumbs -----
  const providerSegment: TrackSegment = sanitizedCoordinates;

  let breadcrumbCoordinates: TrackSegment = [];
  if (breadcrumbPoints.length > 0) {
    const eligibleBreadcrumbs = breadcrumbPoints.filter((point) => {
      // Cap breadcrumbs at the icon's playback time too, same reason as
      // the provider-track filter above: keep the trail from leading the
      // icon. Breadcrumbs accumulate from /api/flights polls so they're
      // typically only a few seconds older than the icon's playback time
      // anyway.
      if (
        displayedProviderTimestampMs != null &&
        point.providerTimestampSec != null &&
        point.providerTimestampSec * 1000 > displayedProviderTimestampMs
      ) {
        return false;
      }
      // Position-based "ahead of icon" filter — see the comment above the
      // breadcrumbLeadFilter block.
      if (breadcrumbLeadFilter && !breadcrumbLeadFilter(point)) {
        return false;
      }
      // Temporal-overlap filter — drop breadcrumbs already covered by the
      // provider track. See breadcrumbOverlapsProviderTrack above.
      if (breadcrumbOverlapsProviderTrack(point)) {
        return false;
      }
      return true;
    });
    breadcrumbCoordinates = eligibleBreadcrumbs.map((point) => point.coordinate);

    const latestBreadcrumbTimestampSec = eligibleBreadcrumbs.reduce<number | null>(
      (latest, point) =>
        point.providerTimestampSec != null && (latest == null || point.providerTimestampSec > latest)
          ? point.providerTimestampSec
          : latest,
      null
    );
    if (latestBreadcrumbTimestampSec != null) {
      const breadcrumbMs = latestBreadcrumbTimestampSec * 1000;
      trailEndTimestampMs =
        trailEndTimestampMs == null ? breadcrumbMs : Math.max(trailEndTimestampMs, breadcrumbMs);
    }
  }

  // ----- Decide topology -----
  // Three cases:
  //   (1) Both provider segment and breadcrumbs have data.
  //       → Strip breadcrumb prefix that overlaps the provider tail.
  //         If the bridge gap is short, concatenate into one segment.
  //         If it's long, keep them as two disjoint segments.
  //   (2) Only one side has data → it's the only segment.
  //   (3) Neither has data → no segments.
  const segments: TrackSegment[] = [];
  if (providerSegment.length > 0 && breadcrumbCoordinates.length > 0) {
    const providerTail = providerSegment[providerSegment.length - 1]!;
    const trimmedBreadcrumbs: TrackSegment = [...breadcrumbCoordinates];

    // Strip breadcrumbs that overlap the provider tail (within rendering
    // tolerance) — avoids drawing a tiny zigzag at the join.
    while (trimmedBreadcrumbs.length > 0) {
      const head = trimmedBreadcrumbs[0]!;
      const dist = distanceBetweenPointsMiles({
        fromLatitude: providerTail[1],
        fromLongitude: providerTail[0],
        toLatitude: head[1],
        toLongitude: head[0]
      });
      if (dist > MAX_BREADCRUMB_OVERLAP_MILES) break;
      trimmedBreadcrumbs.shift();
    }

    const breadcrumbHead = trimmedBreadcrumbs[0];
    if (!breadcrumbHead) {
      // All breadcrumbs were overlap dupes; just use the provider segment.
      segments.push(providerSegment);
    } else {
      const connectorMiles = distanceBetweenPointsMiles({
        fromLatitude: providerTail[1],
        fromLongitude: providerTail[0],
        toLatitude: breadcrumbHead[1],
        toLongitude: breadcrumbHead[0]
      });
      if (connectorMiles <= MAX_PROVIDER_TO_BREADCRUMB_CONNECT_MILES) {
        // Bridge is short enough — merge into one continuous segment.
        segments.push([...providerSegment, ...trimmedBreadcrumbs]);
      } else {
        // Bridge is too long to draw a credible straight line. Keep them
        // as two separate polylines so the user sees both the historical
        // trail AND the live segment near the icon, without a phantom
        // line through unverified airspace.
        segments.push(providerSegment);
        segments.push(trimmedBreadcrumbs);
      }
    }
  } else if (providerSegment.length > 0) {
    segments.push(providerSegment);
  } else if (breadcrumbCoordinates.length > 0) {
    segments.push(breadcrumbCoordinates);
  }

  // ----- Append the icon as the tail of the LAST segment -----
  // Skip when the trail's last data point is fresher than the icon's
  // playback time (would draw a backwards segment from a fresh tip), or
  // when the gap is too wide (would draw a phantom long jump).
  if (renderedPosition) {
    const tailPoint: [number, number] = [
      renderedPosition.longitude,
      renderedPosition.latitude
    ];
    const trailIsAheadOfIcon =
      trailEndTimestampMs != null &&
      displayedProviderTimestampMs != null &&
      trailEndTimestampMs > displayedProviderTimestampMs;

    if (segments.length === 0) {
      // Only the icon — can't draw a line from a single point. Drop.
    } else if (!trailIsAheadOfIcon) {
      const lastSegment = segments[segments.length - 1]!;
      const lastCoordinate = lastSegment[lastSegment.length - 1]!;
      const tailSegmentMiles = distanceBetweenPointsMiles({
        fromLatitude: lastCoordinate[1],
        fromLongitude: lastCoordinate[0],
        toLatitude: tailPoint[1],
        toLongitude: tailPoint[0]
      });
      if (
        tailSegmentMiles <= MAX_TRACK_TO_AIRCRAFT_MILES &&
        (lastCoordinate[0] !== tailPoint[0] || lastCoordinate[1] !== tailPoint[1])
      ) {
        lastSegment.push(tailPoint);
      }
    }
  }

  // Drop any segments shorter than 2 points — can't render a line from one.
  return segments.filter((segment) => segment.length >= 2);
}

function hashTrackSegments(segments: TrackSegment[]) {
  // Why: shape + per-segment head/tail fingerprint. Sufficient for our
  // dedup case — if any earlier coord changes, segment length differs and
  // the hash flips.
  if (segments.length === 0) {
    return "0";
  }
  return segments
    .map((coords) => {
      if (coords.length === 0) return "e";
      const head = coords[0]!;
      const tail = coords[coords.length - 1]!;
      return `${coords.length}|${head[0]},${head[1]}|${tail[0]},${tail[1]}`;
    })
    .join("/");
}

const trackSourceLastHashBySource = new WeakMap<GeoJSONSource, string>();

// Why: track the selection that's currently drawn on the source. When the
// user clicks a NEW flight, we want to clear the previous flight's trail
// (otherwise it visually persists under the new icon). But within the SAME
// selection, we want to preserve whatever was last drawn even if a recompute
// transiently produces fewer than 2 coordinates — that's how we avoid the
// flash-and-disappear pattern between click and fetch return.
const trackSourceLastSelectionId = new WeakMap<GeoJSONSource, string | null>();

function setSelectedTrackSourceData(
  source: GeoJSONSource | undefined,
  selectionId: string | null,
  track: SelectedFlightDetailsResponse["details"] | null,
  breadcrumbPoints: BreadcrumbPoint[],
  renderedPosition: { latitude: number; longitude: number } | null,
  displayedProviderTimestampMs: number | null,
  iconHeadingDegrees: number | null
) {
  if (!source) {
    return;
  }

  const lastSelectionId = trackSourceLastSelectionId.get(source) ?? null;
  const isSelectionChange = lastSelectionId !== selectionId;

  const segments = getSanitizedTrackCoordinates(
    track,
    breadcrumbPoints,
    renderedPosition,
    displayedProviderTimestampMs,
    iconHeadingDegrees
  );

  // Within the same selection, refuse to wipe the trail: a transient empty
  // recompute (e.g., breadcrumbs collapsed to a single dedup'd point while
  // we wait for the fetch to land) shouldn't erase what was last drawn.
  if (segments.length === 0 && !isSelectionChange) {
    return;
  }

  const nextHash = hashTrackSegments(segments);
  if (
    !isSelectionChange &&
    trackSourceLastHashBySource.get(source) === nextHash
  ) {
    return;
  }
  trackSourceLastHashBySource.set(source, nextHash);
  trackSourceLastSelectionId.set(source, selectionId);

  source.setData({
    type: "FeatureCollection",
    features: segments.map((coordinates) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates
      },
      properties: {}
    }))
  });
}

function clearSelectedTrackSource(source: GeoJSONSource | undefined) {
  if (!source) return;
  trackSourceLastHashBySource.set(source, "0");
  trackSourceLastSelectionId.set(source, null);
  source.setData({ type: "FeatureCollection", features: [] });
}

function getLastTrackTimestampMs(track: SelectedTrackPoint[]) {
  const lastPoint = track[track.length - 1];

  if (!lastPoint) {
    return null;
  }

  const timestampMs = Date.parse(lastPoint.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function getFirstTrackTimestampMs(track: SelectedTrackPoint[]) {
  const firstPoint = track[0];

  if (!firstPoint) {
    return null;
  }

  const timestampMs = Date.parse(firstPoint.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function mergeSameFlightTrackHistory(
  currentTrack: SelectedTrackPoint[],
  nextTrack: SelectedTrackPoint[]
) {
  const nextFirstTimestampMs = getFirstTrackTimestampMs(nextTrack);

  if (nextFirstTimestampMs == null) {
    return nextTrack;
  }

  const historicalPrefix = currentTrack.filter((point) => {
    const timestampMs = Date.parse(point.timestamp);

    if (!Number.isFinite(timestampMs)) {
      return true;
    }

    return timestampMs < nextFirstTimestampMs;
  });

  const mergedTrack = [...historicalPrefix, ...nextTrack];
  const seenPointKeys = new Set<string>();

  return mergedTrack.filter((point) => {
    const pointKey = [
      point.timestamp,
      point.latitude.toFixed(6),
      point.longitude.toFixed(6)
    ].join("|");

    if (seenPointKeys.has(pointKey)) {
      return false;
    }

    seenPointKeys.add(pointKey);
    return true;
  });
}

function resolveSelectedTrackRefresh(
  currentDetails: SelectedFlightDetailsResponse["details"] | null,
  nextDetails: SelectedFlightDetailsResponse["details"] | null,
  currentTrackFreshAtMs: number | null,
  nowMs: number
) {
  const currentTrack = currentDetails?.track ?? [];
  const nextTrack = nextDetails?.track ?? [];
  const currentHasTrustedProviderTrack =
    currentDetails?.faFlightId != null && currentTrack.length > 0;
  const nextHasTrustedProviderTrack =
    nextDetails?.faFlightId != null && nextTrack.length > 0;
  const sameFlight =
    currentDetails?.faFlightId != null &&
    nextDetails?.faFlightId != null &&
    currentDetails.faFlightId === nextDetails.faFlightId;
  const withinGrace =
    currentTrackFreshAtMs != null && nowMs - currentTrackFreshAtMs < SELECTED_TRACK_REFRESH_GRACE_MS;

  if (currentHasTrustedProviderTrack && !nextHasTrustedProviderTrack) {
    return {
      refreshedAtMs: currentTrackFreshAtMs,
      track: currentTrack
    };
  }

  if (!sameFlight) {
    return {
      refreshedAtMs: nextTrack.length > 0 ? nowMs : currentTrackFreshAtMs,
      track: nextTrack.length > 0 ? nextTrack : currentTrack
    };
  }

  if (nextTrack.length === 0) {
    return {
      refreshedAtMs: currentTrackFreshAtMs,
      track: withinGrace ? currentTrack : []
    };
  }

  if (currentTrack.length === 0) {
    return {
      refreshedAtMs: nowMs,
      track: nextTrack
    };
  }

  const currentLastTimestampMs = getLastTrackTimestampMs(currentTrack);
  const currentFirstTimestampMs = getFirstTrackTimestampMs(currentTrack);
  const nextLastTimestampMs = getLastTrackTimestampMs(nextTrack);
  const nextFirstTimestampMs = getFirstTrackTimestampMs(nextTrack);

  if (
    nextLastTimestampMs != null &&
    currentLastTimestampMs != null &&
    nextLastTimestampMs >= currentLastTimestampMs
  ) {
    const looksLikeTruncatedTail =
      nextTrack.length < currentTrack.length &&
      nextFirstTimestampMs != null &&
      currentFirstTimestampMs != null &&
      nextFirstTimestampMs > currentFirstTimestampMs;

    return {
      refreshedAtMs: nowMs,
      track: looksLikeTruncatedTail
        ? mergeSameFlightTrackHistory(currentTrack, nextTrack)
        : nextTrack
    };
  }

  return {
    refreshedAtMs: withinGrace ? currentTrackFreshAtMs : nowMs,
    track: withinGrace ? currentTrack : nextTrack
  };
}

function mergeSelectedFlightDetailPayload(
  currentDetails: SelectedFlightDetailsResponse["details"] | null,
  nextDetails: SelectedFlightDetailsResponse["details"] | null,
  currentTrackFreshAtMs: number | null,
  nowMs: number
): {
  details: SelectedFlightDetailsResponse["details"] | null;
  trackFreshAtMs: number | null;
} {
  if (!currentDetails) {
    return {
      details: nextDetails,
      trackFreshAtMs: nextDetails?.track.length ? nowMs : currentTrackFreshAtMs
    };
  }

  if (!nextDetails) {
    return {
      details: currentDetails,
      trackFreshAtMs: currentTrackFreshAtMs
    };
  }

  const { refreshedAtMs, track } = resolveSelectedTrackRefresh(
    currentDetails,
    nextDetails,
    currentTrackFreshAtMs,
    nowMs
  );

  return {
    details: {
      aircraftType: nextDetails.aircraftType ?? currentDetails.aircraftType,
      airline: nextDetails.airline ?? currentDetails.airline,
      destination: nextDetails.destination ?? currentDetails.destination,
      faFlightId: nextDetails.faFlightId ?? currentDetails.faFlightId,
      flightNumber: nextDetails.flightNumber ?? currentDetails.flightNumber,
      origin: nextDetails.origin ?? currentDetails.origin,
      registration: nextDetails.registration ?? currentDetails.registration,
      registeredOwner: nextDetails.registeredOwner ?? currentDetails.registeredOwner,
      status: nextDetails.status ?? currentDetails.status,
      track
    },
    trackFreshAtMs: refreshedAtMs
  };
}

function areTrackPointsEquivalent(left: SelectedTrackPoint[], right: SelectedTrackPoint[]) {
  return (
    left.length === right.length &&
    left.every((point, index) => {
      const other = right[index];

      return (
        other != null &&
        point.altitudeFeet === other.altitudeFeet &&
        point.groundspeedKnots === other.groundspeedKnots &&
        point.heading === other.heading &&
        point.latitude === other.latitude &&
        point.longitude === other.longitude &&
        point.timestamp === other.timestamp
      );
    })
  );
}

function areSelectedFlightDetailsEquivalent(
  left: SelectedFlightDetailsResponse["details"] | null,
  right: SelectedFlightDetailsResponse["details"] | null
) {
  if (left === right) {
    return true;
  }

  if (left == null || right == null) {
    return false;
  }

  return (
    left.aircraftType === right.aircraftType &&
    left.airline === right.airline &&
    left.destination === right.destination &&
    left.faFlightId === right.faFlightId &&
    left.flightNumber === right.flightNumber &&
    left.origin === right.origin &&
    left.registration === right.registration &&
    left.registeredOwner === right.registeredOwner &&
    left.status === right.status &&
    areTrackPointsEquivalent(left.track, right.track)
  );
}

function getFlightPositionSnapshotKey(flight: Flight) {
  return `${flight.latitude.toFixed(5)}:${flight.longitude.toFixed(5)}`;
}

function getFlightProviderTimestampSec(flight: Flight) {
  return flight.positionTimestampSec ?? flight.lastContactTimestampSec ?? null;
}

// Why: closed-form evaluation of the critically-damped spring at frameTime.
// Between target updates, the state's (from, target, targetSetAt) fully
// determines the chase; computing pos(t) doesn't require per-frame state
// mutation. This keeps rendering stateless and makes time-warping (eg. for
// debug snapshots) trivial.
function computeSpringPosition(state: FlightAnimationState, frameTime: number) {
  const elapsedSec = Math.max(0, (frameTime - state.targetSetAt) / 1000);
  const factor = Math.exp(-elapsedSec / SPRING_TAU_SEC);
  return {
    latitude: state.targetLatitude + (state.fromLatitude - state.targetLatitude) * factor,
    longitude: state.targetLongitude + (state.fromLongitude - state.targetLongitude) * factor
  };
}

// Why: the cap timestamp chases lastProviderTimestampSec from
// fromProviderTimestampSec at the SAME τ as the position chase, so the icon
// position and the trail's time cap settle at the same lag. That invariant
// is what guarantees the trail never leads the dot.
function computeSpringProviderTimestampSec(
  state: FlightAnimationState,
  frameTime: number
): number | null {
  if (state.lastProviderTimestampSec == null) return null;
  if (state.fromProviderTimestampSec == null) return state.lastProviderTimestampSec;
  const elapsedSec = Math.max(0, (frameTime - state.targetSetAt) / 1000);
  const factor = Math.exp(-elapsedSec / SPRING_TAU_SEC);
  return (
    state.lastProviderTimestampSec +
    (state.fromProviderTimestampSec - state.lastProviderTimestampSec) * factor
  );
}

function getAnimatedPosition(
  animationState: FlightAnimationState | undefined,
  fallbackFlight: Flight,
  frameTime: number
) {
  if (!animationState) {
    return {
      latitude: fallbackFlight.latitude,
      longitude: fallbackFlight.longitude
    };
  }
  return computeSpringPosition(animationState, frameTime);
}

// Why: still useful for "is the chase essentially settled" gates (eg.
// breadcrumb-tail clipping, diagnostic logging). Returns 1 - factor so it
// reads "0 = just started chase episode, 1 = fully settled" — same
// semantic shape as the old animation progress, so call sites that gate on
// `progress >= 0.995` continue to mean "done chasing."
function getAnimationProgress(animationState: FlightAnimationState | undefined, frameTime: number) {
  if (!animationState) {
    return 1;
  }
  const elapsedSec = Math.max(0, (frameTime - animationState.targetSetAt) / 1000);
  return 1 - Math.exp(-elapsedSec / SPRING_TAU_SEC);
}

// Why: EMA over poll intervals. Retained on the state for diagnostics and
// future adaptive-τ tuning. `null` sample preserves prior estimate;
// first-ever sample seeds the average without smoothing.
function updateProviderDeltaEma(prev: number | null, sample: number | null) {
  if (sample == null) return prev;
  if (prev == null) return sample;
  return prev * PROVIDER_DELTA_EMA_DECAY + sample * (1 - PROVIDER_DELTA_EMA_DECAY);
}

function getDisplayedProviderTimestampMs(
  animationState: FlightAnimationState | undefined,
  frameTime: number
) {
  const sec = animationState
    ? computeSpringProviderTimestampSec(animationState, frameTime)
    : null;
  return sec == null ? null : sec * 1000;
}

function clipBreadcrumbCoordinatesToAnimation(
  points: BreadcrumbPoint[],
  animationState: FlightAnimationState | undefined,
  frameTime: number
) {
  if (points.length === 0 || !animationState) {
    return points;
  }

  const progress = getAnimationProgress(animationState, frameTime);

  if (progress >= 0.995) {
    return points;
  }

  const lastCoordinate = points[points.length - 1]?.coordinate;
  const targetCoordinate: [number, number] = [
    animationState.targetLongitude,
    animationState.targetLatitude
  ];

  if (!lastCoordinate) {
    return points;
  }

  if (lastCoordinate[0] === targetCoordinate[0] && lastCoordinate[1] === targetCoordinate[1]) {
    return points.slice(0, -1);
  }

  return points;
}

function stabilizeFlightsForJitter(nextFlights: Flight[], currentFlights: Flight[]) {
  if (currentFlights.length === 0) {
    return nextFlights;
  }

  const currentFlightsById = new Map(currentFlights.map((flight) => [flight.id, flight]));

  return nextFlights.map((flight) => {
    const currentFlight = currentFlightsById.get(flight.id);

    if (!currentFlight) {
      return flight;
    }

    const currentTimestamp =
      currentFlight.positionTimestampSec ?? currentFlight.lastContactTimestampSec ?? null;
    const nextTimestamp = flight.positionTimestampSec ?? flight.lastContactTimestampSec ?? null;

    if (currentTimestamp != null && nextTimestamp != null && nextTimestamp <= currentTimestamp) {
      return {
        ...flight,
        latitude: currentFlight.latitude,
        longitude: currentFlight.longitude,
        positionTimestampSec: currentFlight.positionTimestampSec,
        lastContactTimestampSec: currentFlight.lastContactTimestampSec
      };
    }

    const deltaMiles = distanceBetweenPointsMiles({
      fromLatitude: currentFlight.latitude,
      fromLongitude: currentFlight.longitude,
      toLatitude: flight.latitude,
      toLongitude: flight.longitude
    });

    const effectiveGroundspeedKnots = Math.max(
      flight.groundspeedKnots ?? 0,
      currentFlight.groundspeedKnots ?? 0
    );
    const expectedMoveMiles = effectiveGroundspeedKnots * 1.15078 * (refreshMs / 3_600_000);
    const dynamicDeadbandMiles = Math.min(
      MAX_POSITION_JITTER_DEADBAND_MILES,
      Math.max(MIN_POSITION_CHANGE_MILES, expectedMoveMiles * DEADBAND_FRACTION_OF_EXPECTED_MOVE)
    );

    if (deltaMiles < dynamicDeadbandMiles) {
      return {
        ...flight,
        latitude: currentFlight.latitude,
        longitude: currentFlight.longitude
      };
    }

    return flight;
  });
}

function updateFlightAnimationStates(
  currentStates: Map<string, FlightAnimationState>,
  flights: Flight[],
  frameTime: number
) {
  const nextStates = new Map<string, FlightAnimationState>();

  for (const flight of flights) {
    const existingState = currentStates.get(flight.id);
    const identityKey = getLiveFlightIdentityKey(flight);
    const providerTimestampSec = getFlightProviderTimestampSec(flight);

    if (!existingState || existingState.identityKey !== identityKey) {
      // Fresh chase. Naively from = target = reported leaves the spring at
      // rest until the *next* poll lands ~4 s later, so on page load the
      // icons sit static for an awkward beat. Boost: extrapolate the
      // target forward by the data lag (now − provider timestamp) along
      // the reported heading × groundspeed. The spring then has somewhere
      // to chase from frame 1, producing immediate visible motion.
      // Strictly position-only — we keep `lastProviderTimestampSec` at the
      // actual reported time so the trail's cap doesn't lie about how
      // fresh our data is, preserving the trail-can't-lead-icon invariant.
      let bootstrapTargetLat = flight.latitude;
      let bootstrapTargetLon = flight.longitude;
      if (
        flight.headingDegrees != null &&
        flight.groundspeedKnots != null &&
        flight.groundspeedKnots > 0 &&
        flight.positionTimestampSec != null
      ) {
        const dataLagSec = Math.max(
          0,
          Math.min(BOOTSTRAP_MAX_EXTRAPOLATION_SEC, Date.now() / 1000 - flight.positionTimestampSec)
        );
        if (dataLagSec > 0) {
          const distanceMiles = flight.groundspeedKnots * 1.15078 * (dataLagSec / 3600);
          const headingRad = (flight.headingDegrees * Math.PI) / 180;
          bootstrapTargetLat =
            flight.latitude + milesToLatitudeDelta(Math.cos(headingRad) * distanceMiles);
          bootstrapTargetLon =
            flight.longitude +
            milesToLongitudeDelta(Math.sin(headingRad) * distanceMiles, flight.latitude);
        }
      }

      nextStates.set(flight.id, {
        averageProviderDeltaSec: null,
        fromLatitude: flight.latitude,
        fromLongitude: flight.longitude,
        identityKey,
        fromProviderTimestampSec: providerTimestampSec,
        lastProviderTimestampSec: providerTimestampSec,
        targetSetAt: frameTime,
        targetLatitude: bootstrapTargetLat,
        targetLongitude: bootstrapTargetLon,
        targetGroundspeedKnots: flight.groundspeedKnots,
        targetHeadingDegrees: flight.headingDegrees
      });
      continue;
    }

    // Provider timestamp didn't advance — no new info, keep the chase running.
    if (
      providerTimestampSec != null &&
      existingState.lastProviderTimestampSec != null &&
      providerTimestampSec <= existingState.lastProviderTimestampSec
    ) {
      nextStates.set(flight.id, existingState);
      continue;
    }

    const providerDeltaSec =
      providerTimestampSec != null && existingState.lastProviderTimestampSec != null
        ? providerTimestampSec - existingState.lastProviderTimestampSec
        : null;
    const averageProviderDeltaSec = updateProviderDeltaEma(
      existingState.averageProviderDeltaSec,
      providerDeltaSec
    );

    const targetUnchanged =
      getFlightPositionSnapshotKey({
        ...flight,
        latitude: existingState.targetLatitude,
        longitude: existingState.targetLongitude
      }) === getFlightPositionSnapshotKey(flight);

    if (targetUnchanged) {
      // Same target — let the spring continue from wherever it is. We just
      // refresh aux fields.
      nextStates.set(flight.id, {
        ...existingState,
        averageProviderDeltaSec,
        lastProviderTimestampSec: providerTimestampSec ?? existingState.lastProviderTimestampSec,
        targetGroundspeedKnots: flight.groundspeedKnots,
        targetHeadingDegrees: flight.headingDegrees
      });
      continue;
    }

    // New target. Capture the spring's current visual position as the new
    // chase start, then update target. Because we capture *exactly* where
    // the chase is right now, the spring continues smoothly through this
    // reset — no position discontinuity even when the target jumps. Same
    // for the cap timestamp.
    const currentSpringPosition = computeSpringPosition(existingState, frameTime);
    const currentSpringProviderTimestampSec = computeSpringProviderTimestampSec(
      existingState,
      frameTime
    );

    nextStates.set(flight.id, {
      averageProviderDeltaSec,
      fromLatitude: currentSpringPosition.latitude,
      fromLongitude: currentSpringPosition.longitude,
      identityKey,
      fromProviderTimestampSec: currentSpringProviderTimestampSec,
      lastProviderTimestampSec: providerTimestampSec ?? existingState.lastProviderTimestampSec,
      targetSetAt: frameTime,
      targetLatitude: flight.latitude,
      targetLongitude: flight.longitude,
      targetGroundspeedKnots: flight.groundspeedKnots,
      targetHeadingDegrees: flight.headingDegrees
    });
  }

  return nextStates;
}

function mergeSelectedFlightDetailsIntoFlight(
  flight: Flight,
  details: SelectedFlightDetailsResponse["details"]
) {
  if (!details) {
    return flight;
  }

  return {
    ...flight,
    aircraftType: details.aircraftType ?? flight.aircraftType,
    airline: details.airline ?? flight.airline,
    destination: details.destination ?? flight.destination,
    flightNumber: details.flightNumber ?? flight.flightNumber,
    origin: details.origin ?? flight.origin,
    registration: details.registration ?? flight.registration,
    registeredOwner: details.registeredOwner ?? flight.registeredOwner
  };
}

function shouldRetrySelectedFlightEnrichment(
  flightRequest: {
    aircraftType: string | null;
    airline: string | null;
    callsign: string;
    destination: string | null;
    flightNumber: string | null;
    id: string;
    origin: string | null;
    registration: string | null;
    registeredOwner: string | null;
  },
  response: SelectedFlightDetailsResponse
) {
  if (!response.details) {
    return true;
  }

  const details = response.details;
  const requestFlightLike: Flight = {
    id: flightRequest.id,
    latitude: 0,
    longitude: 0,
    callsign: flightRequest.callsign,
    onGround: null,
    flightNumber: flightRequest.flightNumber,
    airline: flightRequest.airline,
    aircraftType: flightRequest.aircraftType,
    origin: flightRequest.origin,
    destination: flightRequest.destination,
    altitudeFeet: null,
    groundspeedKnots: null,
    headingDegrees: null,
    positionTimestampSec: null,
    lastContactTimestampSec: null,
    registration: flightRequest.registration,
    registeredOwner: flightRequest.registeredOwner
  };

  if (hasCommercialFlightIdentity(requestFlightLike)) {
    return (
      details.airline == null ||
      details.flightNumber == null ||
      details.origin == null ||
      details.destination == null ||
      details.faFlightId == null ||
      details.track.length === 0
    );
  }

  if (looksLikeGeneralAviationFlight(requestFlightLike)) {
    return (
      details.aircraftType == null ||
      details.registration == null ||
      details.registeredOwner == null ||
      details.track.length === 0
    );
  }

  return details.track.length === 0;
}

function mergeRememberedMetadataIntoFlight(
  flight: Flight,
  metadata: RememberedFlightMetadata | undefined
) {
  if (!metadata) {
    return flight;
  }

  return {
    ...flight,
    aircraftType: flight.aircraftType ?? metadata.aircraftType ?? null,
    registration: flight.registration ?? metadata.registration ?? null,
    registeredOwner: flight.registeredOwner ?? metadata.registeredOwner ?? null
  };
}

function mergeFeedMetadataIntoFlight(flight: Flight, metadata: AeroApiFeedMetadata | undefined) {
  if (!metadata) {
    return flight;
  }

  return {
    ...flight,
    airline: metadata.airline ?? flight.airline,
    destination: metadata.destination ?? flight.destination,
    flightNumber: metadata.flightNumber ?? flight.flightNumber,
    origin: metadata.origin ?? flight.origin
  };
}

function reconcileFlightOrder(currentOrder: string[], latestOrder: string[]) {
  const latestIds = new Set(latestOrder);
  const reconciled = currentOrder.filter((id) => latestIds.has(id));
  const seenIds = new Set(reconciled);

  for (const id of latestOrder) {
    if (!seenIds.has(id)) {
      reconciled.push(id);
      seenIds.add(id);
    }
  }

  return reconciled;
}

function arraysMatch(left: string[], right: string[]) {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function pinSelectedFlightOrder(currentOrder: string[], targetOrder: string[], selectedFlightId: string | null) {
  if (!selectedFlightId) {
    return targetOrder;
  }

  const currentIndex = currentOrder.indexOf(selectedFlightId);
  const targetIndex = targetOrder.indexOf(selectedFlightId);

  if (currentIndex === -1 || targetIndex === -1) {
    return targetOrder;
  }

  const nextOrder = targetOrder.filter((id) => id !== selectedFlightId);
  nextOrder.splice(Math.min(currentIndex, nextOrder.length), 0, selectedFlightId);
  return nextOrder;
}

function getRankChanges(previousOrder: string[], nextOrder: string[]) {
  const nextIndexById = new Map(nextOrder.map((id, index) => [id, index]));
  const changes: Record<string, number> = {};

  for (const [previousIndex, id] of previousOrder.entries()) {
    const nextIndex = nextIndexById.get(id);

    if (nextIndex == null || nextIndex === previousIndex) {
      continue;
    }

    changes[id] = previousIndex - nextIndex;
  }

  return changes;
}

export function FlightMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentFlightsRef = useRef<Flight[]>([]);
  const displayFlightsRef = useRef<Flight[]>([]);
  const flightAnimationStatesRef = useRef<Map<string, FlightAnimationState>>(new Map());
  const flightIdentityByIdRef = useRef<Map<string, string>>(new Map());
  const snapshotHistoryRef = useRef<FlightSnapshot[]>([]);
  // Persistent per-flight breadcrumb buffer. Outlives the 72s snapshot
  // pruning so the trailing edge of a long-watched trail doesn't shrink.
  const flightBreadcrumbsRef = useRef<Map<string, FlightBreadcrumbBuffer>>(new Map());
  const selectedTrackFreshAtByIdRef = useRef<Map<string, number>>(new Map());
  const stripElementRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousStripPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const visibleFlightIdsRef = useRef<string[]>([]);
  const visibleFlightLingerUntilRef = useRef<Map<string, number>>(new Map());
  const stableFlightOrderRef = useRef<string[]>([]);
  const previousVisibilityScoreSnapshotRef = useRef<Map<string, number>>(new Map());
  const lastStripReorderAtRef = useRef(0);
  const rankCueTimeoutRef = useRef<number | null>(null);
  const hoveredFlightIdRef = useRef<string | null>(null);
  const hoveredStripFlightIdRef = useRef<string | null>(null);
  const hoveredStripStartedAtRef = useRef<number | null>(null);
  const [homeBase, setHomeBase] = useState<HomeBaseCenter>(APP_CONFIG.center);
  const [radiusMiles, setRadiusMiles] = useState<number>(APP_CONFIG.radiusMiles);
  const [areaFlyoutOpen, setAreaFlyoutOpen] = useState(false);
  const [areaDraft, setAreaDraft] = useState({
    latitude: APP_CONFIG.center.latitude.toFixed(4),
    longitude: APP_CONFIG.center.longitude.toFixed(4),
    radiusMiles: String(APP_CONFIG.radiusMiles)
  });
  const [areaError, setAreaError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [feedWarmEnabled, setFeedWarmEnabled] = useState(false);
  const feedWarmEnabledRef = useRef(feedWarmEnabled);
  const pageVisibleRef = useRef(true);
  const [feedMetadataById, setFeedMetadataById] = useState<
    Record<string, IdentityScopedValue<AeroApiFeedMetadata>>
  >({});
  const [selectedMetadataById, setSelectedMetadataById] = useState<
    Record<string, IdentityScopedValue<SelectedFlightDetailsResponse["details"]>>
  >({});
  const [rememberedMetadataById, setRememberedMetadataById] = useState<
    Record<string, IdentityScopedValue<RememberedFlightMetadata>>
  >({});
  const [visibleFlightIds, setVisibleFlightIds] = useState<string[]>([]);
  const [stableFlightOrder, setStableFlightOrder] = useState<string[]>([]);
  const [stripRankChanges, setStripRankChanges] = useState<Record<string, number>>({});
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [hoveredFlight, setHoveredFlight] = useState<HoveredFlightState | null>(null);
  const [hoveredStripFlightId, setHoveredStripFlightId] = useState<string | null>(null);
  const [selectedFlightDetails, setSelectedFlightDetails] =
    useState<SelectedFlightDetailsResponse["details"]>(null);
  const [dataSource, setDataSource] = useState<string>("loading");
  const [mapReady, setMapReady] = useState(false);
  const selectedFlightDetailsRef = useRef<SelectedFlightDetailsResponse["details"]>(null);
  const activeSelectedFlightDetailsRef = useRef<SelectedFlightDetailsResponse["details"]>(null);
  const selectedFlightDetailsFlightIdRef = useRef<string | null>(null);
  const selectedFlightDetailsIdentityKeyRef = useRef<string | null>(null);
  // Why: the RAF runs independently of React's effect cycle. When the user
  // clicks a new flight, selectedFlightDetailsFlightIdRef can lag behind by
  // a frame or two — long enough to clear the trail to empty. Mirror the
  // metadata cache so the RAF can fall back to it when the live ref is stale.
  const selectedMetadataByIdRef = useRef<
    Record<string, IdentityScopedValue<SelectedFlightDetailsResponse["details"]>>
  >({});
  const selectedFlightIdRef = useRef<string | null>(null);
  const selectedRenderedPositionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const homeBaseFeatures = useMemo(() => buildHomeBaseFeatures(homeBase), [homeBase]);
  const openingBounds = useMemo(
    () => buildOpeningBounds(homeBase, radiusMiles),
    [homeBase, radiusMiles]
  );
  useEffect(() => {
    stableFlightOrderRef.current = stableFlightOrder;
  }, [stableFlightOrder]);

  useEffect(() => {
    visibleFlightIdsRef.current = visibleFlightIds;
  }, [visibleFlightIds]);

  useEffect(() => {
    currentFlightsRef.current = flights;
  }, [flights]);

  useEffect(() => {
    feedWarmEnabledRef.current = feedWarmEnabled;
  }, [feedWarmEnabled]);

  useEffect(() => {
    const nextIdentityById = new Map(
      flights.map((flight) => [flight.id, getLiveFlightIdentityKey(flight)])
    );
    const changedFlightIds = flights
      .filter((flight) => {
        const previousIdentity = flightIdentityByIdRef.current.get(flight.id);
        return previousIdentity != null && previousIdentity !== getLiveFlightIdentityKey(flight);
      })
      .map((flight) => flight.id);
    const removedFlightIds = [...flightIdentityByIdRef.current.keys()].filter(
      (flightId) => !nextIdentityById.has(flightId)
    );
    const invalidatedFlightIds = [...new Set([...changedFlightIds, ...removedFlightIds])];

    if (invalidatedFlightIds.length > 0) {
      const changedFlightIdSet = new Set(invalidatedFlightIds);

      setFeedMetadataById((currentMetadata) =>
        Object.fromEntries(
          Object.entries(currentMetadata).filter(([flightId]) => !changedFlightIdSet.has(flightId))
        )
      );
      setSelectedMetadataById((currentMetadata) =>
        Object.fromEntries(
          Object.entries(currentMetadata).filter(([flightId]) => !changedFlightIdSet.has(flightId))
        )
      );
      setRememberedMetadataById((currentMetadata) =>
        Object.fromEntries(
          Object.entries(currentMetadata).filter(([flightId]) => !changedFlightIdSet.has(flightId))
        )
      );

      if (selectedFlightId && changedFlightIdSet.has(selectedFlightId)) {
        selectedFlightDetailsRef.current = null;
        selectedFlightDetailsFlightIdRef.current = null;
        selectedFlightDetailsIdentityKeyRef.current = null;
        setSelectedFlightDetails(null);
      }

      for (const flightId of changedFlightIdSet) {
        selectedTrackFreshAtByIdRef.current.delete(flightId);
        // Why: identity change (new callsign on the same icao24) usually
        // means a new flight leg. The breadcrumb buffer should NOT carry
        // positions from the prior leg into the next one.
        flightBreadcrumbsRef.current.delete(flightId);
      }
    }

    flightIdentityByIdRef.current = nextIdentityById;
  }, [flights, selectedFlightId]);

  useEffect(() => {
    const latestIds = flights.map((flight) => flight.id);

    if (latestIds.length === 0) {
      visibleFlightIdsRef.current = [];
      visibleFlightLingerUntilRef.current = new Map();
      // Bail-stable empty: same-ref return prevents downstream memos
      // (visibleFlights, displayFlights, etc.) from re-computing on a
      // fresh empty array reference each call.
      setVisibleFlightIds((current) => (current.length === 0 ? current : []));
      return;
    }

    const now = Date.now();
    const latestIdSet = new Set(latestIds);
    const rankedFlights = [...flights].sort(
      (left, right) => getVisibilityScore(left, homeBase) - getVisibilityScore(right, homeBase)
    );
    const rankById = new Map(rankedFlights.map((flight, index) => [flight.id, index]));
    const currentVisibleIds = reconcileFlightOrder(visibleFlightIdsRef.current, latestIds);
    const nextVisibleIds: string[] = [];
    const nextVisibleSet = new Set<string>();
    const nextLingerUntil = new Map<string, number>();

    const retainFlight = (flightId: string, lingerUntil: number = now + VISIBLE_FLIGHT_LINGER_MS) => {
      if (nextVisibleSet.has(flightId) || !latestIdSet.has(flightId)) {
        return;
      }

      nextVisibleIds.push(flightId);
      nextVisibleSet.add(flightId);
      nextLingerUntil.set(flightId, lingerUntil);
    };

    if (selectedFlightId) {
      retainFlight(selectedFlightId);
    }

    for (const flightId of currentVisibleIds) {
      if (nextVisibleIds.length >= VISIBLE_FLIGHT_LIMIT) {
        break;
      }

      const rank = rankById.get(flightId);
      const lingerUntil = visibleFlightLingerUntilRef.current.get(flightId) ?? 0;

      if (rank != null && rank < VISIBLE_FLIGHT_EXIT_RANK) {
        retainFlight(flightId, now + VISIBLE_FLIGHT_LINGER_MS);
      } else if (lingerUntil > now) {
        retainFlight(flightId, lingerUntil);
      }
    }

    for (const flight of rankedFlights.slice(0, VISIBLE_FLIGHT_ENTRY_COUNT)) {
      if (nextVisibleIds.length >= VISIBLE_FLIGHT_LIMIT) {
        break;
      }

      retainFlight(flight.id);
    }

    for (const flight of rankedFlights) {
      if (nextVisibleIds.length >= VISIBLE_FLIGHT_LIMIT) {
        break;
      }

      retainFlight(flight.id);
    }

    const previousVisibleIds = visibleFlightIdsRef.current;
    visibleFlightIdsRef.current = nextVisibleIds;
    visibleFlightLingerUntilRef.current = nextLingerUntil;

    if (!arraysMatch(previousVisibleIds, nextVisibleIds)) {
      setVisibleFlightIds(nextVisibleIds);
    }
  }, [flights, homeBase, selectedFlightId]);

  const visibleFlights = useMemo(() => {
    const flightsById = new Map(flights.map((flight) => [flight.id, flight]));
    const orderedIds = reconcileFlightOrder(visibleFlightIds, flights.map((flight) => flight.id));

    return orderedIds
      .map((flightId) => flightsById.get(flightId))
      .filter((flight): flight is Flight => flight != null);
  }, [flights, visibleFlightIds]);

  const displayFlights = useMemo(() => {
    const flightsById = new Map(visibleFlights.map((flight) => [flight.id, flight]));
    const orderedIds = reconcileFlightOrder(
      stableFlightOrder,
      visibleFlights.map((flight) => flight.id)
    );

    return orderedIds
      .map((flightId) => flightsById.get(flightId))
      .filter((flight): flight is Flight => flight != null)
      .map((flight) =>
        mergeSelectedFlightDetailsIntoFlight(
          mergeFeedMetadataIntoFlight(
            mergeRememberedMetadataIntoFlight(
              flight,
              getIdentityScopedValue(rememberedMetadataById[flight.id], flight) ?? undefined
            ),
            getIdentityScopedValue(feedMetadataById[flight.id], flight) ?? undefined
          ),
          getIdentityScopedValue(selectedMetadataById[flight.id], flight)
        )
      );
  }, [
    feedMetadataById,
    rememberedMetadataById,
    selectedMetadataById,
    stableFlightOrder,
    visibleFlights
  ]);

  useEffect(() => {
    displayFlightsRef.current = displayFlights;
  }, [displayFlights]);
  const selectedFlightBase =
    displayFlights.find((flight) => flight.id === selectedFlightId) ?? displayFlights[0] ?? null;
  const activeSelectedFlightDetails =
    selectedFlightBase != null &&
    selectedFlightDetailsFlightIdRef.current === selectedFlightBase.id &&
    selectedFlightDetailsIdentityKeyRef.current === getLiveFlightIdentityKey(selectedFlightBase)
      ? selectedFlightDetails
      : selectedFlightBase == null
        ? null
        : getIdentityScopedValue(selectedMetadataById[selectedFlightBase.id], selectedFlightBase);
  const selectedFlightDisplay =
    selectedFlightBase == null
      ? null
      : mergeSelectedFlightDetailsIntoFlight(
          selectedFlightBase,
          activeSelectedFlightDetails
        );
  const altitudeTrend = selectedFlightDisplay
    ? getMetricTrend(
        getFlightMetricHistory(
          snapshotHistoryRef.current,
          selectedFlightDisplay,
          (flight) => flight.altitudeFeet
        ),
        ALTITUDE_TREND_THRESHOLD_FEET
      )
    : null;
  const airspeedTrend = selectedFlightDisplay
    ? getMetricTrend(
        getFlightMetricHistory(
          snapshotHistoryRef.current,
          selectedFlightDisplay,
          (flight) => flight.groundspeedKnots
        ),
        AIRSPEED_TREND_THRESHOLD_KNOTS
      )
    : null;
  const selectedFlightRequestKey = selectedFlightDisplay
    ? [
        getLiveFlightIdentityKey(selectedFlightDisplay),
        selectedFlightDisplay.registration?.trim().toUpperCase() ?? "unknown"
      ].join("|")
    : null;
  const selectedFlightRequest = useMemo(
    () =>
      selectedFlightDisplay == null
        ? null
        : {
            id: selectedFlightDisplay.id,
            callsign: selectedFlightDisplay.callsign,
            flightNumber: selectedFlightDisplay.flightNumber,
            airline: selectedFlightDisplay.airline,
            aircraftType: selectedFlightDisplay.aircraftType,
            origin: selectedFlightDisplay.origin,
            destination: selectedFlightDisplay.destination,
            registration: selectedFlightDisplay.registration,
            registeredOwner: selectedFlightDisplay.registeredOwner
          },
    [selectedFlightRequestKey]
  );

  useEffect(() => {
    const storedSettings = window.localStorage.getItem(HOME_BASE_STORAGE_KEY);

    if (!storedSettings) {
      return;
    }

    try {
      const parsed = JSON.parse(storedSettings) as {
        center?: HomeBaseCenter;
        radiusMiles?: number;
      };

      if (
        parsed.center &&
        Number.isFinite(parsed.center.latitude) &&
        Number.isFinite(parsed.center.longitude)
      ) {
        setHomeBase(parsed.center);
      }

      if (typeof parsed.radiusMiles === "number" && Number.isFinite(parsed.radiusMiles)) {
        setRadiusMiles(parsed.radiusMiles);
      }
    } catch (error) {
      console.error("Failed to restore saved home base settings", error);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      HOME_BASE_STORAGE_KEY,
      JSON.stringify({
        center: homeBase,
        radiusMiles
      })
    );
  }, [homeBase, radiusMiles]);

  useEffect(() => {
    feedWarmEnabledRef.current = false;
    setFeedWarmEnabled(false);
  }, [homeBase, radiusMiles]);

  useEffect(() => {
    // Why: when the tab is hidden the user can't see the map, so polling at
    // 4s and warming AeroAPI metadata for ~10 flights every poll just burns
    // upstream rate-limit budget for nothing. Pause warming and slow polling
    // until they come back.
    if (typeof document === "undefined") {
      return;
    }
    const onVisibilityChange = () => {
      pageVisibleRef.current = !document.hidden;
    };
    pageVisibleRef.current = !document.hidden;
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      bounds: openingBounds,
      fitBoundsOptions: {
        padding: 40
      },
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.on("load", () => {
      setMapReady(true);

      map.addSource("home-base", {
        type: "geojson",
        data: homeBaseFeatures
      });

      map.addSource("flights", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });

      map.addSource("selected-track", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });

      map.addLayer({
        id: "home-rings",
        type: "line",
        source: "home-base",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "rgba(38, 84, 124, 0.25)",
          "line-width": [
            "match",
            ["get", "radiusMiles"],
            3,
            1.4,
            8,
            1.1,
            1
          ],
          "line-dasharray": [2, 3]
        }
      });

      map.addLayer({
        id: "home-base-point",
        type: "circle",
        source: "home-base",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 6,
          "circle-color": "#f4efe6",
          "circle-stroke-color": "#0f4c81",
          "circle-stroke-width": 3
        }
      });

      map.addLayer({
        id: "flight-points",
        type: "circle",
        source: "flights",
        paint: {
          "circle-radius": [
            "case",
            ["<=", ["get", "distanceMiles"], 3],
            8,
            ["<=", ["get", "distanceMiles"], 8],
            6.5,
            4.75
          ],
          "circle-color": [
            "case",
            ["<=", ["get", "distanceMiles"], 3],
            "#0f4c81",
            ["<=", ["get", "distanceMiles"], 8],
            "#3a6f98",
            "#7895ad"
          ],
          "circle-opacity": [
            "case",
            ["<=", ["get", "distanceMiles"], 3],
            0.95,
            ["<=", ["get", "distanceMiles"], 8],
            0.82,
            0.62
          ],
          "circle-stroke-color": "#f4efe6",
          "circle-stroke-width": [
            "case",
            ["get", "isPriority"],
            2.6,
            1.8
          ]
        }
      });

      map.addLayer({
        id: "selected-flight-halo",
        type: "circle",
        source: "flights",
        filter: ["==", ["get", "isSelected"], true],
        paint: {
          "circle-radius": 18,
          "circle-color": "rgba(15, 76, 129, 0.12)",
          "circle-stroke-color": "rgba(15, 76, 129, 0.38)",
          "circle-stroke-width": 2.5
        }
      });

      map.addLayer({
        id: "hovered-flight-halo",
        type: "circle",
        source: "flights",
        filter: ["==", ["get", "isHovered"], true],
        paint: {
          "circle-radius": 13,
          "circle-color": "rgba(240, 127, 79, 0.1)",
          "circle-stroke-color": "rgba(240, 127, 79, 0.46)",
          "circle-stroke-width": 2
        }
      });

      map.addLayer({
        id: "strip-hover-echo",
        type: "circle",
        source: "flights",
        filter: ["==", ["get", "isStripHovered"], true],
        paint: {
          "circle-radius": ["get", "stripHoverRadius"],
          "circle-color": "rgba(240, 127, 79, 0.04)",
          "circle-opacity": ["get", "stripHoverOpacity"],
          "circle-stroke-color": "rgba(240, 127, 79, 0.92)",
          "circle-stroke-opacity": ["get", "stripHoverStrokeOpacity"],
          "circle-stroke-width": 2
        }
      });

      map.addLayer({
        id: "selected-flight-marker",
        type: "circle",
        source: "flights",
        filter: ["==", ["get", "isSelected"], true],
        paint: {
          "circle-radius": 9.5,
          "circle-color": "#f07f4f",
          "circle-opacity": 1,
          "circle-stroke-color": "#fff9f2",
          "circle-stroke-width": 3
        }
      });

      map.addLayer({
        id: "selected-track-line",
        type: "line",
        source: "selected-track",
        paint: {
          "line-color": "rgba(15, 76, 129, 0.5)",
          "line-width": 2.5
        }
      }, "selected-flight-marker");

      map.addLayer({
        id: "flight-labels",
        type: "symbol",
        source: "flights",
        layout: {
          "text-field": ["case", ["get", "showLabel"], ["get", "label"], ""],
          "text-size": [
            "case",
            ["get", "isSelected"],
            12,
            ["get", "isPriority"],
            11,
            10
          ],
          "text-font": ["Noto Sans Regular"],
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": false
        },
        paint: {
          "text-color": [
            "case",
            ["get", "isSelected"],
            "#9f4316",
            "#17324d"
          ],
          "text-halo-color": "rgba(255,255,255,0.92)",
          "text-halo-width": [
            "case",
            ["get", "isSelected"],
            1.8,
            1.2
          ]
        }
      });

      map.on("click", "flight-points", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;

        if (typeof id === "string") {
          setSelectedFlightId(id);
        }
      });

      map.on("mousemove", "flight-points", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;

        if (typeof id !== "string") {
          return;
        }

        hoveredFlightIdRef.current = id;
        setHoveredFlight({
          flightId: id,
          left: event.point.x,
          top: event.point.y
        });
      });

      map.on("mouseenter", "flight-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "flight-points", () => {
        map.getCanvas().style.cursor = "";
        hoveredFlightIdRef.current = null;
        setHoveredFlight(null);
      });
    });

    mapRef.current = map;

    return () => {
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [homeBaseFeatures, openingBounds]);

  useEffect(() => {
    const homeBaseSource = mapRef.current?.getSource("home-base") as GeoJSONSource | undefined;

    homeBaseSource?.setData(homeBaseFeatures);
    mapRef.current?.fitBounds(openingBounds, {
      padding: 40,
      duration: 700
    });
  }, [homeBaseFeatures, mapReady, openingBounds]);

  useEffect(() => {
    let cancelled = false;
    let nextPollTimeoutId: number | null = null;
    let requestSequence = 0;
    let inFlightAbortController: AbortController | null = null;

    snapshotHistoryRef.current = [];
    flightAnimationStatesRef.current = new Map();
    flightBreadcrumbsRef.current = new Map();

    async function loadFlights() {
      const requestId = requestSequence + 1;
      requestSequence = requestId;
      const query = new URLSearchParams({
        latitude: String(homeBase.latitude),
        longitude: String(homeBase.longitude),
        radiusMiles: String(radiusMiles)
      });
      const shouldWarmFeed = feedWarmEnabledRef.current && pageVisibleRef.current;
      query.set("warmFeed", shouldWarmFeed ? "1" : "0");
      inFlightAbortController?.abort();
      inFlightAbortController = new AbortController();
      const response = await fetch(`/api/flights?${query.toString()}`, {
        cache: "no-store",
        signal: inFlightAbortController.signal
      });

      // Why: 4xx (bad input) — bail. 5xx still carries a JSON body with a
      // `source` like "opensky-unavailable" and an empty flights array; we
      // need to process it so the UI marks the feed unavailable instead of
      // silently rendering the previous positions under the old "opensky"
      // label.
      if (response.status >= 400 && response.status < 500) {
        return;
      }

      let data: FlightApiResponse;
      try {
        data = (await response.json()) as FlightApiResponse;
      } catch {
        return;
      }

      if (cancelled || requestId !== requestSequence) {
        return;
      }

      const isFallbackSnapshot =
        data.source === "opensky-stale" ||
        data.source === "aeroapi-stale" ||
        data.source === "adsblol-stale" ||
        data.source === "mock-fallback" ||
        data.source === "opensky-unavailable" ||
        data.source === "aeroapi-unavailable" ||
        data.source === "adsblol-unavailable";

      const sortedFlights = [...data.flights].sort(
        (left, right) =>
          getDistanceFromHomeBaseMiles(left, homeBase) -
          getDistanceFromHomeBaseMiles(right, homeBase)
      );
      const currentFlights = currentFlightsRef.current;
      const stabilizedFlights = stabilizeFlightsForJitter(sortedFlights, currentFlights);
      const capturedAt = performance.now();

      setFlights((currentFlights) => {
        if (isFallbackSnapshot && currentFlights.length > 0) {
          return currentFlights;
        }

        return stabilizedFlights;
      });
      setDataSource((currentSource) =>
        (data.source === "mock-fallback" || data.source === "opensky-unavailable") &&
        (currentSource === "opensky" || currentSource === "opensky-stale")
          ? currentSource
          : data.source
      );
      setSelectedFlightId((currentId) => {
        if (currentId && sortedFlights.some((flight) => flight.id === currentId)) {
          return currentId;
        }

        return sortedFlights[0]?.id ?? null;
      });

      if (!isFallbackSnapshot) {
        flightAnimationStatesRef.current = updateFlightAnimationStates(
          flightAnimationStatesRef.current,
          stabilizedFlights,
          capturedAt
        );
        snapshotHistoryRef.current = [
          ...snapshotHistoryRef.current,
          {
            capturedAt,
            flights: stabilizedFlights,
            flightsById: new Map(stabilizedFlights.map((flight) => [flight.id, flight]))
          }
        ].filter((snapshot) => capturedAt - snapshot.capturedAt <= SNAPSHOT_HISTORY_RETENTION_MS);

        // Append to the persistent per-flight breadcrumb buffer so the
        // selected flight's trail can outlive the 72s snapshot pruning.
        const wallNow = Date.now();
        const seenIds = new Set<string>();
        for (const flight of stabilizedFlights) {
          seenIds.add(flight.id);
          let buffer = flightBreadcrumbsRef.current.get(flight.id);
          if (!buffer) {
            buffer = { points: [], lastSeenAt: wallNow };
            flightBreadcrumbsRef.current.set(flight.id, buffer);
          }
          buffer.points.push({
            coordinate: [flight.longitude, flight.latitude],
            providerTimestampSec: getFlightProviderTimestampSec(flight)
          });
          if (buffer.points.length > FLIGHT_BREADCRUMB_BUFFER_MAX_POINTS) {
            buffer.points.splice(0, buffer.points.length - FLIGHT_BREADCRUMB_BUFFER_MAX_POINTS);
          }
          buffer.lastSeenAt = wallNow;
        }
        for (const [id, buffer] of flightBreadcrumbsRef.current) {
          if (!seenIds.has(id) && wallNow - buffer.lastSeenAt > FLIGHT_BREADCRUMB_BUFFER_RETENTION_MS) {
            flightBreadcrumbsRef.current.delete(id);
          }
        }
      }
    }

    async function pollFlights() {
      const startedAt = performance.now();

      try {
        await loadFlights();
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "AbortError") {
          console.error("Failed to poll flights", error);
        }
      } finally {
        if (!cancelled) {
          const elapsedMs = performance.now() - startedAt;
          const targetMs = pageVisibleRef.current ? refreshMs : HIDDEN_TAB_REFRESH_MS;
          const nextDelayMs = Math.max(250, targetMs - elapsedMs);

          nextPollTimeoutId = window.setTimeout(() => {
            void pollFlights();
          }, nextDelayMs);
        }
      }
    }

    void pollFlights();

    return () => {
      cancelled = true;
      if (nextPollTimeoutId != null) {
        window.clearTimeout(nextPollTimeoutId);
      }
      inFlightAbortController?.abort();
    };
  }, [homeBase, radiusMiles]);

  useEffect(() => {
    if (!selectedFlightRequest) {
      selectedFlightDetailsRef.current = null;
      selectedFlightDetailsFlightIdRef.current = null;
      selectedFlightDetailsIdentityKeyRef.current = null;
      setSelectedFlightDetails(null);
      return;
    }

    let cancelled = false;
    let retryTimeoutId: number | null = null;
    let inFlightAbortController: AbortController | null = null;
    const requestForSelection = selectedFlightRequest;
    const selectedFlightIdentityKey = getLiveFlightIdentityKey(requestForSelection);
    const selectedFlightRequestId = selectedFlightRequest.id;
    const cachedSelectedDetails =
      getIdentityScopedValue(
        selectedMetadataById[selectedFlightRequestId],
        requestForSelection
      ) ?? null;

    if (cachedSelectedDetails) {
      selectedFlightDetailsRef.current = cachedSelectedDetails;
      selectedFlightDetailsFlightIdRef.current = selectedFlightRequestId;
      selectedFlightDetailsIdentityKeyRef.current = selectedFlightIdentityKey;
      setSelectedFlightDetails(cachedSelectedDetails);
    } else {
      selectedFlightDetailsRef.current = null;
      selectedFlightDetailsFlightIdRef.current = selectedFlightRequestId;
      selectedFlightDetailsIdentityKeyRef.current = selectedFlightIdentityKey;
      setSelectedFlightDetails(null);
    }
    const searchParams = new URLSearchParams({
      id: selectedFlightRequestId,
      callsign: selectedFlightRequest.callsign
    });

    if (selectedFlightRequest.flightNumber) {
      searchParams.set("flightNumber", selectedFlightRequest.flightNumber);
    }

    if (selectedFlightRequest.airline) {
      searchParams.set("airline", selectedFlightRequest.airline);
    }

    if (selectedFlightRequest.aircraftType) {
      searchParams.set("aircraftType", selectedFlightRequest.aircraftType);
    }

    if (selectedFlightRequest.origin) {
      searchParams.set("origin", selectedFlightRequest.origin);
    }

    if (selectedFlightRequest.destination) {
      searchParams.set("destination", selectedFlightRequest.destination);
    }

    if (selectedFlightRequest.registration) {
      searchParams.set("registration", selectedFlightRequest.registration);
    }

    if (selectedFlightRequest.registeredOwner) {
      searchParams.set("registeredOwner", selectedFlightRequest.registeredOwner);
    }

    async function loadSelectedFlightDetails(bypassCache = false) {
      const requestSearchParams = new URLSearchParams(searchParams);

      if (bypassCache) {
        requestSearchParams.set("refresh", "1");
      }

      inFlightAbortController?.abort();
      inFlightAbortController = new AbortController();
      const response = await fetch(`/api/flights/selected?${requestSearchParams.toString()}`, {
        cache: "no-store",
        signal: inFlightAbortController.signal
      });

      if (!response.ok) {
        console.warn(
          `Selected flight details request returned ${response.status}; preserving existing details`
        );
        return null;
      }

      const data = (await response.json()) as SelectedFlightDetailsResponse;

      if (!cancelled) {
        const currentSelectedDetails =
          selectedFlightDetailsFlightIdRef.current === selectedFlightRequestId &&
            selectedFlightDetailsIdentityKeyRef.current === selectedFlightIdentityKey
            ? selectedFlightDetailsRef.current
            : cachedSelectedDetails;
        const mergeResult = mergeSelectedFlightDetailPayload(
          currentSelectedDetails,
          data.details,
          selectedTrackFreshAtByIdRef.current.get(selectedFlightRequestId) ?? null,
          Date.now()
        );
        const mergedDetails = mergeResult.details;

        if (mergeResult.trackFreshAtMs != null) {
          selectedTrackFreshAtByIdRef.current.set(
            selectedFlightRequestId,
            mergeResult.trackFreshAtMs
          );
        } else {
          selectedTrackFreshAtByIdRef.current.delete(selectedFlightRequestId);
        }

        selectedFlightDetailsRef.current = mergedDetails;
        selectedFlightDetailsFlightIdRef.current = selectedFlightRequestId;
        selectedFlightDetailsIdentityKeyRef.current = selectedFlightIdentityKey;
        setSelectedFlightDetails(mergedDetails);

        if (mergedDetails) {
          setSelectedMetadataById((currentMetadata) => {
            const currentDetails =
              getIdentityScopedValue(
                currentMetadata[selectedFlightRequestId],
                requestForSelection
              ) ?? null;

            if (areSelectedFlightDetailsEquivalent(currentDetails, mergedDetails)) {
              return currentMetadata;
            }

            return {
              ...currentMetadata,
              [selectedFlightRequestId]: {
                identityKey: selectedFlightIdentityKey,
                value: mergedDetails
              }
            };
          });
        }

        return data;
      }

      return null;
    }

    async function attemptSelectedFlightEnrichment(attemptIndex: number, bypassCache: boolean) {
      let data: SelectedFlightDetailsResponse | null = null;
      try {
        data = await loadSelectedFlightDetails(bypassCache);
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "AbortError") {
          return;
        }
        console.error("Failed to load selected flight details", error);
      }

      if (cancelled || data == null) {
        return;
      }

      setFeedWarmEnabled(true);

      if (
        attemptIndex < SELECTED_ENRICHMENT_RETRY_DELAYS_MS.length &&
        shouldRetrySelectedFlightEnrichment(requestForSelection, data)
      ) {
        // Why: only force `bypassCache` after the cache has had a real chance
        // to refresh on its own (~the AeroAPI DETAIL_TTL of 2min). Earlier
        // retries should let the server-side cache do its job — bypassing it
        // burns AeroAPI quota without giving the upstream time to update.
        const shouldBypassCache = attemptIndex >= 2;
        retryTimeoutId = window.setTimeout(() => {
          void attemptSelectedFlightEnrichment(attemptIndex + 1, shouldBypassCache);
        }, SELECTED_ENRICHMENT_RETRY_DELAYS_MS[attemptIndex]);
      }
    }

    void attemptSelectedFlightEnrichment(0, false);

    return () => {
      cancelled = true;
      if (retryTimeoutId != null) {
        window.clearTimeout(retryTimeoutId);
      }
      inFlightAbortController?.abort();
    };
  }, [selectedFlightRequest, selectedFlightRequestKey]);

  useEffect(() => {
    setRememberedMetadataById((currentMetadata) => {
      let changed = false;
      const nextMetadata = { ...currentMetadata };

      function mergeRememberedMetadata(
        flight: Pick<Flight, "id" | "callsign">,
        metadata: RememberedFlightMetadata | SelectedFlightDetailsResponse["details"] | undefined | null
      ) {
        if (!metadata) {
          return;
        }

        const currentEntry =
          getIdentityScopedValue(nextMetadata[flight.id], flight) ?? {};
        const nextEntry: RememberedFlightMetadata = { ...currentEntry };

        if (metadata.aircraftType && metadata.aircraftType !== currentEntry.aircraftType) {
          nextEntry.aircraftType = metadata.aircraftType;
        }

        if (metadata.registration && metadata.registration !== currentEntry.registration) {
          nextEntry.registration = metadata.registration;
        }

        if ("registeredOwner" in metadata && metadata.registeredOwner && metadata.registeredOwner !== currentEntry.registeredOwner) {
          nextEntry.registeredOwner = metadata.registeredOwner;
        }

        if (
          nextEntry.aircraftType !== currentEntry.aircraftType ||
          nextEntry.registration !== currentEntry.registration ||
          nextEntry.registeredOwner !== currentEntry.registeredOwner
        ) {
          nextMetadata[flight.id] = {
            identityKey: getLiveFlightIdentityKey(flight),
            value: nextEntry
          };
          changed = true;
        }
      }

      for (const flight of flights) {
        mergeRememberedMetadata(flight, flight);
      }

      for (const flight of flights) {
        mergeRememberedMetadata(
          flight,
          getIdentityScopedValue(selectedMetadataById[flight.id], flight)
        );
      }

      return changed ? nextMetadata : currentMetadata;
    });
  }, [flights, selectedMetadataById]);

  useEffect(() => {
    if (
      selectedFlightBase == null ||
      activeSelectedFlightDetails == null ||
      !hasCommercialFlightIdentity(selectedFlightBase)
    ) {
      return;
    }

    const metadata = getFeedMetadataMerge(selectedFlightBase, {
      airline: activeSelectedFlightDetails.airline,
      destination: activeSelectedFlightDetails.destination,
      flightNumber: activeSelectedFlightDetails.flightNumber,
      origin: activeSelectedFlightDetails.origin
    });

    if (!metadata) {
      return;
    }

    setFeedMetadataById((currentMetadata) => {
      const currentFlightMetadata =
        getIdentityScopedValue(currentMetadata[selectedFlightBase.id], selectedFlightBase);

      if (
        currentFlightMetadata?.airline === metadata.airline &&
        currentFlightMetadata?.destination === metadata.destination &&
        currentFlightMetadata?.flightNumber === metadata.flightNumber &&
        currentFlightMetadata?.origin === metadata.origin
      ) {
        return currentMetadata;
      }

      return {
        ...currentMetadata,
        [selectedFlightBase.id]: {
          identityKey: getLiveFlightIdentityKey(selectedFlightBase),
          value: metadata
        }
      };
    });
  }, [activeSelectedFlightDetails, selectedFlightBase]);

  useEffect(() => {
    selectedFlightDetailsRef.current = selectedFlightDetails;
  }, [selectedFlightDetails]);

  useEffect(() => {
    activeSelectedFlightDetailsRef.current = activeSelectedFlightDetails;
  }, [activeSelectedFlightDetails]);

  useEffect(() => {
    selectedFlightIdRef.current = selectedFlightId;
  }, [selectedFlightId]);

  useEffect(() => {
    selectedMetadataByIdRef.current = selectedMetadataById;
  }, [selectedMetadataById]);

  useEffect(() => {
    hoveredStripFlightIdRef.current = hoveredStripFlightId;
  }, [hoveredStripFlightId]);

  useEffect(() => {
    const latestOrder = visibleFlights.map((flight) => flight.id);
    const latestVisibilityScoreSnapshot = new Map(
      visibleFlights.map((flight) => [flight.id, getVisibilityScore(flight, homeBase)])
    );

    if (latestOrder.length === 0) {
      stableFlightOrderRef.current = [];
      previousVisibilityScoreSnapshotRef.current = new Map();
      // Why: pass an updater that returns the same reference when state
      // is already empty. Without this guard, every call ships a NEW
      // empty array, React detects a state change, the effect re-fires
      // (stableFlightOrder is a dep), and we loop forever.
      setStableFlightOrder((current) => (current.length === 0 ? current : []));
      return;
    }

    const currentOrder = reconcileFlightOrder(stableFlightOrderRef.current, latestOrder);

    if (currentOrder.length === 0) {
      stableFlightOrderRef.current = latestOrder;
      previousVisibilityScoreSnapshotRef.current = latestVisibilityScoreSnapshot;
      lastStripReorderAtRef.current = Date.now();
      setStableFlightOrder((current) => (arraysMatch(current, latestOrder) ? current : latestOrder));
      return;
    }

    const now = Date.now();
    const canReorder = now - lastStripReorderAtRef.current >= STRIP_REORDER_INTERVAL_MS;
    const previousVisibilityScoreSnapshot = previousVisibilityScoreSnapshotRef.current;
    const hasMeaningfulChange = latestOrder.some((flightId, targetIndex) => {
      const currentIndex = currentOrder.indexOf(flightId);

      if (currentIndex === -1) {
        return true;
      }

      const previousScore =
        previousVisibilityScoreSnapshot.get(flightId) ??
        latestVisibilityScoreSnapshot.get(flightId) ??
        0;
      const latestScore = latestVisibilityScoreSnapshot.get(flightId) ?? previousScore;

      return (
        Math.abs(currentIndex - targetIndex) >= STRIP_REORDER_RANK_THRESHOLD ||
        Math.abs(previousScore - latestScore) >= STRIP_REORDER_SCORE_THRESHOLD
      );
    });

    let nextOrder = currentOrder;

    if (canReorder && hasMeaningfulChange) {
      nextOrder = pinSelectedFlightOrder(currentOrder, latestOrder, selectedFlightId);

      if (!arraysMatch(currentOrder, nextOrder)) {
        const nextRankChanges = getRankChanges(currentOrder, nextOrder);

        if (rankCueTimeoutRef.current != null) {
          window.clearTimeout(rankCueTimeoutRef.current);
        }

        setStripRankChanges(nextRankChanges);
        rankCueTimeoutRef.current = window.setTimeout(() => {
          setStripRankChanges({});
          rankCueTimeoutRef.current = null;
        }, STRIP_RANK_CUE_MS);
      }

      lastStripReorderAtRef.current = now;
    }

    stableFlightOrderRef.current = nextOrder;
    previousVisibilityScoreSnapshotRef.current = latestVisibilityScoreSnapshot;

    if (!arraysMatch(stableFlightOrderRef.current, stableFlightOrder)) {
      setStableFlightOrder((current) => (arraysMatch(current, nextOrder) ? current : nextOrder));
    }
  }, [homeBase, selectedFlightId, stableFlightOrder, visibleFlights]);

  useEffect(() => {
    return () => {
      if (rankCueTimeoutRef.current != null) {
        window.clearTimeout(rankCueTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const nextPositions = new Map<string, DOMRect>();

    for (const [flightId, element] of stripElementRefs.current.entries()) {
      const nextRect = element.getBoundingClientRect();
      nextPositions.set(flightId, nextRect);

      const previousRect = previousStripPositionsRef.current.get(flightId);

      if (!previousRect) {
        continue;
      }

      const deltaY = previousRect.top - nextRect.top;

      if (Math.abs(deltaY) < 1) {
        continue;
      }

      element.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: "translateY(0px)" }
        ],
        {
          duration: 420,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        }
      );
    }

    previousStripPositionsRef.current = nextPositions;
  }, [stableFlightOrder]);

  useEffect(() => {
    const source = mapRef.current?.getSource("flights") as GeoJSONSource | undefined;

    if (!source) {
      return;
    }

    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const flightSource = source;
    const trackSource = mapRef.current?.getSource("selected-track") as GeoJSONSource | undefined;

    // [trail-debug] Throttle for the optional in-frame diagnostic. Toggle with
    // `window.__TRAIL_DEBUG = true` in DevTools to surface the icon vs trail-tip
    // relationship for the selected flight at ~1 Hz.
    let trailDebugLastLogAtMs = 0;

    function renderFrame(frameTime: number) {
      const playbackSnapshots = snapshotHistoryRef.current;
      const animationStates = flightAnimationStatesRef.current;
      const stripHoverElapsedMs =
        hoveredStripStartedAtRef.current == null ? STRIP_HOVER_ECHO_DURATION_MS : frameTime - hoveredStripStartedAtRef.current;
      const stripHoverEchoPhase = Math.min(
        Math.max(stripHoverElapsedMs / STRIP_HOVER_ECHO_DURATION_MS, 0),
        1
      );
      const stripHoverRadius =
        STRIP_HOVER_ECHO_BASE_RADIUS + stripHoverEchoPhase * STRIP_HOVER_ECHO_GROWTH;
      const stripHoverOpacity = 0.12 * (1 - stripHoverEchoPhase);
      const stripHoverStrokeOpacity = 0.72 * (1 - stripHoverEchoPhase);
      let selectedRenderedPosition: { latitude: number; longitude: number } | null = null;
      const playbackFlights = displayFlightsRef.current;
      const selectedId = selectedFlightIdRef.current;
      // Why: trail logic depends on the SELECTION (id), not whether the flight
      // is currently in displayFlights. A poll can momentarily drop a flight
      // we have selected; we still want to keep showing its cached track and
      // breadcrumbs. The icon position falls back to undefined and is handled
      // by getSanitizedTrackCoordinates (which simply skips the live tail).
      const activeSelectedTrack =
        selectedId == null
          ? null
          : selectedFlightDetailsFlightIdRef.current === selectedId
            ? activeSelectedFlightDetailsRef.current
            : selectedMetadataByIdRef.current[selectedId]?.value ?? null;
      const selectedAnimationState =
        selectedId == null ? undefined : animationStates.get(selectedId);
      const selectedDisplayedProviderTimestampMs = getDisplayedProviderTimestampMs(
        selectedAnimationState,
        frameTime
      );
      const activeBreadcrumbPoints =
        selectedId == null
          ? []
          : clipBreadcrumbCoordinatesToAnimation(
              sanitizeBreadcrumbPoints(
                flightBreadcrumbsRef.current.get(selectedId)?.points ?? []
              ),
              selectedAnimationState,
              frameTime
            );

      flightSource.setData({
        type: "FeatureCollection",
        features: playbackFlights.map((flight, index) => {
          const renderedPosition = getAnimatedPosition(
            animationStates.get(flight.id),
            flight,
            frameTime
          );
          const distanceMiles = getDistanceFromHomeBaseCoordinates(
            renderedPosition.latitude,
            renderedPosition.longitude,
            homeBase
          );

          if (flight.id === selectedFlightIdRef.current) {
            selectedRenderedPosition = renderedPosition;
          }

          return {
            type: "Feature" as const,
            geometry: {
              type: "Point" as const,
              coordinates: [renderedPosition.longitude, renderedPosition.latitude]
            },
            properties: {
              id: flight.id,
              distanceMiles,
              isHovered: flight.id === hoveredFlightIdRef.current,
              isStripHovered: flight.id === hoveredStripFlightIdRef.current,
              isPriority: index < 3,
              isSelected: flight.id === selectedFlightIdRef.current,
              label: flight.flightNumber ?? flight.callsign,
              showLabel: index < 3 || flight.id === selectedFlightIdRef.current,
              stripHoverOpacity,
              stripHoverRadius,
              stripHoverStrokeOpacity
            }
          };
        })
      });

      if (selectedId == null) {
        clearSelectedTrackSource(trackSource);
      } else {
        setSelectedTrackSourceData(
          trackSource,
          selectedId,
          activeSelectedTrack,
          activeBreadcrumbPoints,
          selectedRenderedPosition,
          selectedDisplayedProviderTimestampMs,
          selectedAnimationState?.targetHeadingDegrees ?? null
        );
      }

      // [trail-debug] Optional diagnostic. Enable in DevTools console:
      //   window.__TRAIL_DEBUG = true
      // Logs the selected flight's icon position, the cap timestamp, the
      // cap-filtered provider trail tip, and a signed "ahead" projection of
      // (trailTip - icon) onto the icon's heading vector. Positive aheadMiles
      // means the trail tip is geographically ahead of the icon along its
      // direction of travel — that's the "trail leading the dot" signature.
      // Cast to widen the union — TS narrows `selectedRenderedPosition` to
      // the `null` literal because the only assignment site is inside a `.map`
      // callback, which control-flow analysis can't track. The cast restores
      // the declared union so the `!= null` check below narrows correctly.
      const debugIconPosition = selectedRenderedPosition as
        | { latitude: number; longitude: number }
        | null;
      if (
        typeof window !== "undefined" &&
        (window as unknown as { __TRAIL_DEBUG?: boolean }).__TRAIL_DEBUG === true &&
        selectedId != null &&
        debugIconPosition != null &&
        frameTime - trailDebugLastLogAtMs > 1000
      ) {
        trailDebugLastLogAtMs = frameTime;

        const animState = selectedAnimationState;
        const cap = selectedDisplayedProviderTimestampMs;
        const providerTrack = activeSelectedTrack?.track ?? [];

        // Walk from the end to find the latest provider point still allowed by
        // the cap — that's the trail's actual visible tip.
        let trailTip: { lat: number; lon: number; tMs: number } | null = null;
        for (let i = providerTrack.length - 1; i >= 0; i -= 1) {
          const point = providerTrack[i]!;
          const tMs = Date.parse(point.timestamp);
          if (!Number.isFinite(tMs)) continue;
          if (cap == null || tMs <= cap) {
            trailTip = { lat: point.latitude, lon: point.longitude, tMs };
            break;
          }
        }

        // Spring "settledness" — 0 = chase episode just started, 1 = chase
        // has fully converged on target. > 0.995 means lag is < 0.5% of the
        // jump (effectively at target).
        const progress = animState ? getAnimationProgress(animState, frameTime) : null;
        const phase =
          progress == null
            ? "no-animation"
            : progress >= 0.995
              ? "settled"
              : "chasing";
        const chaseElapsedSec =
          animState ? (frameTime - animState.targetSetAt) / 1000 : null;

        // Helper: project a (lat, lon) point onto the icon's heading vector.
        // Returns signed miles ahead of the icon (positive = beyond the dot).
        // Snapshot the icon coords here so TS narrowing isn't lost inside the
        // nested function.
        const iconLat = debugIconPosition.latitude;
        const iconLon = debugIconPosition.longitude;
        const heading = animState?.targetHeadingDegrees;
        const milesPerDegLat = 69.0;
        const milesPerDegLon = 69.0 * Math.cos((iconLat * Math.PI) / 180);
        const headingRad = heading != null ? (heading * Math.PI) / 180 : null;
        function aheadOfIconMiles(lat: number, lon: number): number | null {
          if (headingRad == null) return null;
          const dEastMiles = (lon - iconLon) * milesPerDegLon;
          const dNorthMiles = (lat - iconLat) * milesPerDegLat;
          return (
            dNorthMiles * Math.cos(headingRad) + dEastMiles * Math.sin(headingRad)
          );
        }

        let trailToIconMiles: number | null = null;
        let aheadMiles: number | null = null;
        if (trailTip) {
          trailToIconMiles = distanceBetweenPointsMiles({
            fromLatitude: debugIconPosition.latitude,
            fromLongitude: debugIconPosition.longitude,
            toLatitude: trailTip.lat,
            toLongitude: trailTip.lon
          });
          aheadMiles = aheadOfIconMiles(trailTip.lat, trailTip.lon);
        }

        // Breadcrumb tip: client-accumulated points (one per /api/flights poll
        // for as long as we've been watching this flight). These stitch the
        // gap between a stale provider track tip and the live icon.
        const breadcrumbs = activeBreadcrumbPoints;
        const breadcrumbTip =
          breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1]! : null;
        const breadcrumbTipAheadMiles = breadcrumbTip
          ? aheadOfIconMiles(breadcrumbTip.coordinate[1], breadcrumbTip.coordinate[0])
          : null;

        // Actually run the same pipeline that paints the line, then inspect
        // its last few coordinates. The very last one should be the icon
        // (live-tail append). The second-to-last is the relevant "is the
        // line zigzagging forward past the dot and back?" signal.
        const paintedSegments = getSanitizedTrackCoordinates(
          activeSelectedTrack,
          breadcrumbs,
          debugIconPosition,
          cap,
          animState?.targetHeadingDegrees ?? null
        );
        // The icon-tail-append (when it fires) goes onto the last segment,
        // so the last segment's tip + prev are the diagnostic-relevant ones.
        const paintedLastSegment =
          paintedSegments.length > 0
            ? paintedSegments[paintedSegments.length - 1]!
            : null;
        const paintedTip =
          paintedLastSegment && paintedLastSegment.length > 0
            ? paintedLastSegment[paintedLastSegment.length - 1]!
            : null;
        const paintedPrev =
          paintedLastSegment && paintedLastSegment.length > 1
            ? paintedLastSegment[paintedLastSegment.length - 2]!
            : null;
        const paintedTipAheadMiles = paintedTip
          ? aheadOfIconMiles(paintedTip[1], paintedTip[0])
          : null;
        const paintedPrevAheadMiles = paintedPrev
          ? aheadOfIconMiles(paintedPrev[1], paintedPrev[0])
          : null;
        const paintedTotalCoordCount = paintedSegments.reduce(
          (sum, seg) => sum + seg.length,
          0
        );

        // Format as a single flat string so the relevant fields are visible
        // without expanding objects in DevTools — easier to copy/paste back.
        const fmt = (v: number | null, digits = 4) =>
          v == null ? "null" : v.toFixed(digits);
        // Spring chase summary. avgProviderDelta is the EMA of poll
        // intervals (steady-state ~4 s); capLagSec is how far the cap
        // chase trails the latest provider time at this frame (positive
        // = trail tip is BEHIND latest provider, which is the desired
        // condition — equal to the position chase's lag and ≈ τ in
        // steady state).
        const avgProviderDelta = animState?.averageProviderDeltaSec ?? null;
        const capLagSec =
          cap != null && animState?.lastProviderTimestampSec != null
            ? animState.lastProviderTimestampSec - cap / 1000
            : null;

        const trailTipStr = trailTip
          ? `(${fmt(trailTip.lat, 5)},${fmt(trailTip.lon, 5)}) capMinusTip=${
              cap != null ? fmt((cap - trailTip.tMs) / 1000, 1) : "null"
            }s ahead=${fmt(aheadMiles, 3)}mi`
          : "null";

        const bcTipStr = breadcrumbTip
          ? `(${fmt(breadcrumbTip.coordinate[1], 5)},${fmt(
              breadcrumbTip.coordinate[0],
              5
            )}) capMinusTip=${
              cap != null && breadcrumbTip.providerTimestampSec != null
                ? fmt(
                    cap / 1000 - breadcrumbTip.providerTimestampSec,
                    1
                  )
                : "null"
            }s ahead=${fmt(breadcrumbTipAheadMiles, 3)}mi`
          : "null";

        const paintedTipStr = paintedTip
          ? `(${fmt(paintedTip[1], 5)},${fmt(paintedTip[0], 5)}) ahead=${fmt(
              paintedTipAheadMiles,
              3
            )}mi`
          : "null";

        const paintedPrevStr = paintedPrev
          ? `(${fmt(paintedPrev[1], 5)},${fmt(paintedPrev[0], 5)}) ahead=${fmt(
              paintedPrevAheadMiles,
              3
            )}mi`
          : "null";

        const summary =
          `[trail-debug] sel=${selectedId} phase=${phase} prog=${fmt(progress, 3)} chaseElapsed=${fmt(chaseElapsedSec, 2)}s τ=${SPRING_TAU_SEC}s ` +
          `icon=(${fmt(iconLat, 5)},${fmt(iconLon, 5)}) ` +
          `heading=${fmt(animState?.targetHeadingDegrees ?? null, 1)}° ` +
          `gs=${fmt(animState?.targetGroundspeedKnots ?? null, 0)}kt ` +
          `capLag=${fmt(capLagSec, 2)}s avgProviderDelta=${fmt(avgProviderDelta, 1)}s | ` +
          `provTrack(n=${providerTrack.length}) tip=${trailTipStr} | ` +
          `breadcrumbs(n=${breadcrumbs.length}) tip=${bcTipStr} | ` +
          `painted(segs=${paintedSegments.length}, coords=${paintedTotalCoordCount}) tip=${paintedTipStr} prev=${paintedPrevStr}`;

        // eslint-disable-next-line no-console
        console.log(summary);
      }

      selectedRenderedPositionRef.current = selectedRenderedPosition;

      animationFrameRef.current = requestAnimationFrame(renderFrame);
    }

    animationFrameRef.current = requestAnimationFrame(renderFrame);

    return () => {
      if (animationFrameRef.current != null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [homeBase, mapReady]);

  useEffect(() => {
    const source = mapRef.current?.getSource("selected-track") as GeoJSONSource | undefined;
    const selectedId = selectedFlightIdRef.current;

    if (selectedId == null) {
      clearSelectedTrackSource(source);
      return;
    }

    // Why: gate on the selection itself, not on whether the flight is in the
    // current poll. A just-clicked flight may not be in `currentFlightsRef`
    // (it could be a remembered/lingering flight, or the latest poll dropped
    // it), and a poll could swap `currentFlightsRef` between click and this
    // effect — both used to clear the trail to empty. Trust the cached track
    // for the selected id and let breadcrumbs persist independently.
    const activeSelectedTrack =
      activeSelectedFlightDetails ??
      (selectedMetadataByIdRef.current[selectedId]?.value ?? null);
    const selectedAnimationState = flightAnimationStatesRef.current.get(selectedId);
    const selectedDisplayedProviderTimestampMs = getDisplayedProviderTimestampMs(
      selectedAnimationState,
      performance.now()
    );

    setSelectedTrackSourceData(
      source,
      selectedId,
      activeSelectedTrack,
      clipBreadcrumbCoordinatesToAnimation(
        sanitizeBreadcrumbPoints(
          flightBreadcrumbsRef.current.get(selectedId)?.points ?? []
        ),
        selectedAnimationState,
        performance.now()
      ),
      selectedRenderedPositionRef.current,
      selectedDisplayedProviderTimestampMs,
      selectedAnimationState?.targetHeadingDegrees ?? null
    );
  }, [activeSelectedFlightDetails, mapReady, selectedFlightId]);

  useEffect(() => {
    if (hoveredFlight == null) {
      return;
    }

    if (!displayFlights.some((flight) => flight.id === hoveredFlight.flightId)) {
      hoveredFlightIdRef.current = null;
      setHoveredFlight(null);
    }
  }, [displayFlights, hoveredFlight]);

  useEffect(() => {
    if (hoveredStripFlightId == null) {
      return;
    }

    if (!displayFlights.some((flight) => flight.id === hoveredStripFlightId)) {
      hoveredStripFlightIdRef.current = null;
      hoveredStripStartedAtRef.current = null;
      setHoveredStripFlightId(null);
    }
  }, [displayFlights, hoveredStripFlightId]);

  const nearestFlight = useMemo(
    () =>
      displayFlights.reduce<Flight | null>((nearest, flight) => {
        if (!nearest) {
          return flight;
        }

        return getDistanceFromHomeBaseMiles(flight, homeBase) <
          getDistanceFromHomeBaseMiles(nearest, homeBase)
          ? flight
          : nearest;
      }, null),
    [displayFlights, homeBase]
  );
  const hoveredFlightDisplay =
    hoveredFlight == null
      ? null
      : displayFlights.find((flight) => flight.id === hoveredFlight.flightId) ?? null;

  function openAreaFlyout() {
    setAreaError(null);
    setAreaDraft({
      latitude: homeBase.latitude.toFixed(4),
      longitude: homeBase.longitude.toFixed(4),
      radiusMiles: String(radiusMiles)
    });
    setAreaFlyoutOpen((open) => !open);
  }

  function applyAreaDraft() {
    const latitude = Number(areaDraft.latitude);
    const longitude = Number(areaDraft.longitude);
    const nextRadiusMiles = Number(areaDraft.radiusMiles);

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setAreaError("Latitude must be between -90 and 90.");
      return;
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setAreaError("Longitude must be between -180 and 180.");
      return;
    }

    if (!Number.isFinite(nextRadiusMiles) || nextRadiusMiles < 3 || nextRadiusMiles > 100) {
      setAreaError("Radius must be between 3 and 100 miles.");
      return;
    }

    setAreaError(null);
    setHomeBase({
      latitude,
      longitude
    });
    setRadiusMiles(nextRadiusMiles);
    setAreaFlyoutOpen(false);
  }

  function setDraftFromMapCenter() {
    const center = mapRef.current?.getCenter();

    if (!center) {
      return;
    }

    setAreaDraft((currentDraft) => ({
      ...currentDraft,
      latitude: center.lat.toFixed(4),
      longitude: center.lng.toFixed(4)
    }));
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setAreaError("Current location is not supported in this browser.");
      return;
    }

    setIsLocating(true);
    setAreaError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        setAreaDraft((currentDraft) => ({
          ...currentDraft,
          latitude: position.coords.latitude.toFixed(4),
          longitude: position.coords.longitude.toFixed(4)
        }));
      },
      () => {
        setIsLocating(false);
        setAreaError("Could not access your current location.");
      }
    );
  }

  function handleStripHoverStart(flightId: string) {
    if (hoveredStripFlightIdRef.current === flightId) {
      return;
    }

    hoveredStripFlightIdRef.current = flightId;
    hoveredStripStartedAtRef.current = performance.now();
    setHoveredStripFlightId(flightId);
  }

  function handleStripHoverEnd(flightId: string) {
    if (hoveredStripFlightIdRef.current !== flightId) {
      return;
    }

    hoveredStripFlightIdRef.current = null;
    hoveredStripStartedAtRef.current = null;
    setHoveredStripFlightId((currentId) => (currentId === flightId ? null : currentId));
  }

  return (
    <section className="tracker-panel">
      <div className="map-panel">
        <div className="map-frame" ref={containerRef} />
        {hoveredFlightDisplay && hoveredFlight ? (
          <div
            className="map-hover-card"
            style={{
              left: hoveredFlight.left,
              top: hoveredFlight.top
            }}
          >
            <div className="map-hover-row">
              <strong>{getPrimaryIdentifier(hoveredFlightDisplay)}</strong>
              {hoveredFlightDisplay.aircraftType ? (
                <span
                  className={`strip-category equipment-tag family-${getAircraftTypeFamily(hoveredFlightDisplay)}`}
                >
                  {hoveredFlightDisplay.aircraftType}
                </span>
              ) : null}
            </div>
            <span>{getHoverSubtitle(hoveredFlightDisplay)}</span>
          </div>
        ) : null}
        <div className="area-flyout">
          <button className="area-flyout-toggle" onClick={openAreaFlyout} type="button">
            <span className="map-overlay-label">Area</span>
            <strong>{radiusMiles} mi</strong>
          </button>
          {areaFlyoutOpen ? (
            <div className="area-flyout-panel">
              <div className="area-flyout-grid">
                <label className="area-field">
                  <span>Latitude</span>
                  <input
                    onChange={(event) =>
                      setAreaDraft((currentDraft) => ({
                        ...currentDraft,
                        latitude: event.target.value
                      }))
                    }
                    type="text"
                    value={areaDraft.latitude}
                  />
                </label>
                <label className="area-field">
                  <span>Longitude</span>
                  <input
                    onChange={(event) =>
                      setAreaDraft((currentDraft) => ({
                        ...currentDraft,
                        longitude: event.target.value
                      }))
                    }
                    type="text"
                    value={areaDraft.longitude}
                  />
                </label>
                <label className="area-field span-2">
                  <span>Radius (miles)</span>
                  <input
                    onChange={(event) =>
                      setAreaDraft((currentDraft) => ({
                        ...currentDraft,
                        radiusMiles: event.target.value
                      }))
                    }
                    type="text"
                    value={areaDraft.radiusMiles}
                  />
                </label>
              </div>
              <div className="area-actions">
                <button onClick={setDraftFromMapCenter} type="button">
                  Use map center
                </button>
                <button onClick={useCurrentLocation} type="button">
                  {isLocating ? "Locating..." : "Use my location"}
                </button>
                <button className="primary" onClick={applyAreaDraft} type="button">
                  Apply
                </button>
              </div>
              {areaError ? <p className="area-error">{areaError}</p> : null}
            </div>
          ) : null}
        </div>
        <div className="map-overlay bottom-left compact">
          <div className="map-overlay-row">
            <span className="map-overlay-label">Focus</span>
            <strong>{radiusMiles} mi</strong>
          </div>
          <div className="map-overlay-row">
            <span className="map-overlay-label">Source</span>
            <strong>{dataSource}</strong>
          </div>
        </div>
      </div>

      <aside className="flight-card-stack">
        <div className="stack-header">
          <p className="eyebrow">Current Aircraft</p>
          <h2>{displayFlights.length} flights in view</h2>
          {nearestFlight ? (
            <button
              className="nearest-chip"
              onClick={() => setSelectedFlightId(nearestFlight.id)}
              type="button"
            >
              <span className="nearest-chip-label">Nearest now</span>
              <strong>{getPrimaryIdentifier(nearestFlight)}</strong>
              <small>{formatDistanceMiles(getDistanceFromHomeBaseMiles(nearestFlight, homeBase))}</small>
            </button>
          ) : null}
        </div>

        {selectedFlightDisplay ? (
          <article className="featured-card atc-card">
            <div className="featured-header atc-header">
              <div>
                <p className="feature-label">{getIdentifierLabel(selectedFlightDisplay)}</p>
                <h3>{getPrimaryIdentifier(selectedFlightDisplay)}</h3>
                {getSecondaryIdentifier(selectedFlightDisplay) ? (
                  <p className="secondary-identifier">
                    {getSecondaryIdentifier(selectedFlightDisplay)}
                  </p>
                ) : null}
              </div>
              <div className="atc-badges">
                <span className="badge">
                  {selectedFlightDisplay.aircraftType ?? "Unknown type"}
                </span>
                {activeSelectedFlightDetails?.status ? (
                  <span className="badge badge-live">{activeSelectedFlightDetails.status}</span>
                ) : null}
              </div>
            </div>
            <dl className="flight-details atc-grid">
              {getOperatorLabel(selectedFlightDisplay) ? (
                <div className="atc-cell span-2">
                  <dt>{getOperatorLabelTitle(selectedFlightDisplay)}</dt>
                  <dd>{getOperatorLabel(selectedFlightDisplay)}</dd>
                </div>
              ) : null}
              {selectedFlightDisplay.registration &&
              getPrimaryIdentifier(selectedFlightDisplay) !== selectedFlightDisplay.registration ? (
                <div className="atc-cell">
                  <dt>Registration</dt>
                  <dd>{selectedFlightDisplay.registration}</dd>
                </div>
              ) : null}
              {getRouteLabel(selectedFlightDisplay) ? (
                <div className="atc-cell span-2">
                  <dt>Route</dt>
                  <dd>{getRouteLabel(selectedFlightDisplay)}</dd>
                </div>
              ) : null}
              {normalizeRegisteredOwnerLabel(selectedFlightDisplay.registeredOwner) &&
              normalizeRegisteredOwnerLabel(selectedFlightDisplay.registeredOwner) !== getOperatorLabel(selectedFlightDisplay) ? (
                <div className="atc-cell span-2">
                  <dt>Owner</dt>
                  <dd>{normalizeRegisteredOwnerLabel(selectedFlightDisplay.registeredOwner)}</dd>
                </div>
              ) : null}
              <div className="atc-stats span-2">
                <div className="atc-stat">
                  <dt>Distance</dt>
                  <dd>
                    {formatDistanceMiles(getDistanceFromHomeBaseMiles(selectedFlightDisplay, homeBase))}
                  </dd>
                </div>
                <div className="atc-stat">
                  <dt>Altitude</dt>
                  <dd>
                    {formatAltitude(
                      selectedFlightDisplay.altitudeFeet,
                      activeSelectedFlightDetails?.status
                    )}
                    {altitudeTrend ? (
                      <span className={`trend-indicator ${altitudeTrend}`} aria-hidden="true">
                        {altitudeTrend === "up" ? "↑" : "↓"}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="atc-stat">
                  <dt>Airspeed</dt>
                  <dd>
                    {formatAirspeed(selectedFlightDisplay.groundspeedKnots)}
                    {airspeedTrend ? (
                      <span className={`trend-indicator ${airspeedTrend}`} aria-hidden="true">
                        {airspeedTrend === "up" ? "↑" : "↓"}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </div>
            </dl>
          </article>
        ) : null}

        <div className="flight-list">
          {displayFlights.map((flight) => (
            <button
              className={`flight-list-item atc-strip ${
                flight.id === selectedFlightDisplay?.id ? "active" : ""
              } ${flight.id === hoveredStripFlightId ? "map-linked" : ""}`}
              key={flight.id}
              onBlur={() => handleStripHoverEnd(flight.id)}
              onClick={() => setSelectedFlightId(flight.id)}
              onFocus={() => handleStripHoverStart(flight.id)}
              onMouseEnter={() => handleStripHoverStart(flight.id)}
              onMouseLeave={() => handleStripHoverEnd(flight.id)}
              ref={(node) => {
                if (node) {
                  stripElementRefs.current.set(flight.id, node);
                } else {
                  stripElementRefs.current.delete(flight.id);
                }
              }}
              type="button"
            >
              <div className="strip-topline">
                <strong className="strip-identifier">{getPrimaryIdentifier(flight)}</strong>
                <span className="strip-meta">
                  {(() => {
                    const rankChange = stripRankChanges[flight.id];
                    return rankChange ? (
                      <span
                        aria-label={rankChange > 0 ? "Moved closer" : "Moved farther"}
                        className={`strip-rank-cue ${rankChange > 0 ? "closer" : "farther"}`}
                        title={rankChange > 0 ? "Moved closer" : "Moved farther"}
                      >
                        {rankChange > 0 ? "↑" : "↓"}
                      </span>
                    ) : null;
                  })()}
                  <span
                    className={`strip-category equipment-tag family-${getAircraftTypeFamily(flight)}`}
                  >
                    {flight.aircraftType ?? "UNK"}
                  </span>
                </span>
              </div>
              <div className="strip-grid">
                <span className="strip-field">
                  <small>Operator</small>
                  <strong>{getListSecondaryLeft(flight)}</strong>
                </span>
                <span className="strip-field">
                  <small>Route</small>
                  <strong>{getStripRouteLabel(flight)}</strong>
                </span>
              </div>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}
