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
import {
  getVisibilityScore,
  hasCommercialFlightIdentity
} from "@/lib/flights/scoring";
import { isOperatingVfr } from "@/lib/flights/squawk";
import type { AeroApiFeedMetadata } from "@/lib/flights/aeroapi";
import {
  formatAirspeed,
  formatAltitude,
  getAircraftTypeFamily,
  getCompactRouteLabel,
  getHoverSubtitle,
  getIdentifierLabel,
  getListSecondaryLeft,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getRouteLabel,
  getSecondaryIdentifier,
  getStripRouteLabel,
  isFlightVfrForLabel,
  looksLikeAgencyLabel,
  looksLikeGeneralAviationFlight,
  looksLikeManufacturerName,
  normalizeRegisteredOwnerLabel,
  refreshVfrLatchIfApplicable
} from "@/lib/flights/display";
import { getFlightMetricHistory, getMetricTrend } from "@/lib/flights/metrics";
import {
  getFlightPositionSnapshotKey,
  getFlightProviderTimestampSec,
  getIdentityScopedValue,
  getLiveFlightIdentityKey
} from "@/lib/flights/identity";
import {
  arraysMatch,
  getRankChanges,
  pinSelectedFlightOrder,
  reconcileFlightOrder
} from "@/lib/flights/ordering";
import {
  getFeedMetadataMerge,
  mergeFeedMetadataIntoFlight,
  mergeRememberedMetadataIntoFlight,
  mergeSelectedFlightDetailsIntoFlight,
  shouldRetrySelectedFlightEnrichment,
  stabilizeFlightsForJitter
} from "@/lib/flights/merging";
import {
  clipBreadcrumbCoordinatesToAnimation,
  computeSpringPosition,
  computeSpringProviderTimestampSec,
  getAnimatedPosition,
  getAnimationProgress,
  getDisplayedProviderTimestampMs,
  updateFlightAnimationStates,
  updateProviderDeltaEma
} from "@/lib/map/animation";
import {
  buildHomeBaseFeatures,
  buildOpeningBounds,
  buildRingCoordinates,
  dedupeCoordinates,
  formatDistanceMiles,
  getDistanceFromHomeBaseCoordinates,
  getDistanceFromHomeBaseMiles,
  isValidTrackCoordinate,
  sanitizeCoordinateSequence
} from "@/lib/map/geo-helpers";
import {
  areSelectedFlightDetailsEquivalent,
  areTrackPointsEquivalent,
  clearSelectedTrackSource,
  getBreadcrumbPoints,
  getFirstTrackTimestampMs,
  getLastTrackTimestampMs,
  getSanitizedTrackCoordinates,
  hashTrackSegments,
  mergeSameFlightTrackHistory,
  mergeSelectedFlightDetailPayload,
  resolveSelectedTrackRefresh,
  sanitizeBreadcrumbPoints,
  setSelectedTrackSourceData
} from "@/lib/map/trails";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";

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

// Why: ranking tier model lives in lib/flights/scoring.ts so the server
// (discovery slice) and client (visible-flight rank) never drift apart.
// See that module for the full tier semantics + tuning rationale.
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
// Why: a gap larger than this in a per-flight breadcrumb buffer is a
// strong signal of a landing → ramp time → takeoff sequence (the aircraft
// stops transmitting on the ground for many minutes). When that happens
// the prior leg's breadcrumbs would otherwise paint a connecting line
// from the old leg's last position to the new leg's start. Wipe the
// buffer so each leg's breadcrumbs are independent. Mirrors adsb.lol's
// isolateCurrentLeg threshold.
const BREADCRUMB_LEG_BREAK_GAP_MS = 1000 * 60 * 15;
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
// which for our P ≈ 4s polls gives ~10 s of icon-lag at τ = 8 s. The cap
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
  // Why: tracks the wall-clock time of the most recent successful poll.
  // Used to suppress the breadcrumb-wipe false-positive when polling
  // resumes after a long hidden-tab throttle: a "15-min gap since
  // lastSeenAt" might just mean "the browser stopped firing setTimeout."
  // If we just resumed polling, the gap isn't a real landing event.
  const lastPollAtRef = useRef<number>(Date.now());
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
        // Fallback snapshots (mock-fallback / opensky-unavailable) are
        // followed by an explicit `setFlights` carve-out that *keeps* the
        // existing fleet. Mirror that here — derive selection only from
        // the snapshot's own flight list when we're committing to it.
        // Otherwise the selected card/trail blanks out during transient
        // outages even though the visible list is intact.
        if (isFallbackSnapshot) {
          return currentId;
        }
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
        // Why: if we haven't polled successfully recently (browser
        // throttled hidden-tab setTimeout, network outage, etc.), an
        // apparent "15-min gap since lastSeenAt" might just be polling
        // silence, not an actual landing. Skip the wipe on the first
        // poll back from such a gap. 60 s threshold is well above the
        // 30 s hidden-tab refresh interval and the 4 s visible interval,
        // so normal cadence never triggers it.
        const justResumedFromPollSilence =
          wallNow - lastPollAtRef.current > 60_000;
        lastPollAtRef.current = wallNow;
        const seenIds = new Set<string>();
        for (const flight of stabilizedFlights) {
          seenIds.add(flight.id);
          let buffer = flightBreadcrumbsRef.current.get(flight.id);
          if (!buffer) {
            buffer = { points: [], lastSeenAt: wallNow };
            flightBreadcrumbsRef.current.set(flight.id, buffer);
          } else if (
            !justResumedFromPollSilence &&
            wallNow - buffer.lastSeenAt > BREADCRUMB_LEG_BREAK_GAP_MS
          ) {
            // Gap > 15 min during normal polling — almost certainly a
            // landing → ramp → takeoff sequence. Wipe the previous
            // leg's breadcrumbs so we don't paint a connecting line
            // across legs.
            buffer.points = [];
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

          // Why: refresh the per-identity VFR latch so a transient null
          // squawk doesn't flip the strip-card label from "VFR" away.
          // See VFR_LATCH_DURATION_MS / isFlightVfrForLabel.
          refreshVfrLatchIfApplicable(flight);

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
        // Why: when the selected flight is being rendered via cached
        // metadata + breadcrumbs (linger fallback — the selected id isn't
        // in displayFlightsRef this frame), the .map() loop above didn't
        // assign selectedRenderedPosition. Without a fallback the
        // trail-leads-dot defenses (ahead-of-icon breadcrumb filter +
        // icon-tail-append) silently disable themselves in exactly the
        // mode the linger logic was added for. Compute a fallback
        // position from the animation state if we have one.
        const lingerRenderedPosition =
          selectedRenderedPosition ??
          (selectedAnimationState
            ? computeSpringPosition(selectedAnimationState, frameTime)
            : null);
        setSelectedTrackSourceData(
          trackSource,
          selectedId,
          activeSelectedTrack,
          activeBreadcrumbPoints,
          lingerRenderedPosition,
          selectedDisplayedProviderTimestampMs,
          selectedAnimationState?.targetHeadingDegrees ?? null
        );
        if (selectedRenderedPosition == null && lingerRenderedPosition != null) {
          // Cache for the diagnostic block + cross-effect uses.
          selectedRenderedPosition = lingerRenderedPosition;
        }
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
    <>
      {/* Full-viewport map sits behind the floating sidebar.
          Wrapper is positioned because maplibre forces `position: relative` on the
          ref'd container, which would otherwise neutralize `fixed inset-0`. */}
      <div className="fixed inset-0 z-0">
        <div className="h-full w-full" ref={containerRef} />
      </div>

      <Sidebar variant="floating" side="left" collapsible="offcanvas">
        <SidebarHeader className="gap-2 px-3 pt-3 pb-1">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">
                In view
              </p>
              <h2 className="text-base font-semibold tabular-nums leading-tight">
                {displayFlights.length} flights
              </h2>
            </div>
            <ThemeToggle />
          </div>
          {nearestFlight ? (
            <button
              className="flex items-center justify-between gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-accent"
              onClick={() => setSelectedFlightId(nearestFlight.id)}
              type="button"
            >
              <span className="text-sidebar-foreground/60">Nearest now</span>
              <strong className="font-medium tabular-nums">
                {getPrimaryIdentifier(nearestFlight)}
              </strong>
              <small className="tabular-nums text-sidebar-foreground/60">
                {formatDistanceMiles(getDistanceFromHomeBaseMiles(nearestFlight, homeBase))}
              </small>
            </button>
          ) : null}
        </SidebarHeader>

        <SidebarContent className="gap-0 px-2">
          {selectedFlightDisplay ? (
            <Card className="mx-1 mt-2 mb-2 gap-3 py-3">
              <CardHeader className="gap-1 px-3">
                <CardDescription className="text-[10px] uppercase tracking-wider">
                  {getIdentifierLabel(selectedFlightDisplay)}
                </CardDescription>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg leading-tight tabular-nums">
                    {getPrimaryIdentifier(selectedFlightDisplay)}
                  </CardTitle>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Badge variant="secondary" className="text-[10px]">
                      {selectedFlightDisplay.aircraftType ?? "Unknown type"}
                    </Badge>
                    {activeSelectedFlightDetails?.status ? (
                      <Badge className="text-[10px]">
                        {activeSelectedFlightDetails.status}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {getSecondaryIdentifier(selectedFlightDisplay) ? (
                  <p className="text-xs text-muted-foreground">
                    {getSecondaryIdentifier(selectedFlightDisplay)}
                  </p>
                ) : null}
              </CardHeader>
              <CardContent className="px-3">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  {getOperatorLabel(selectedFlightDisplay) ? (
                    <div className="col-span-2 min-w-0">
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {getOperatorLabelTitle(selectedFlightDisplay)}
                      </dt>
                      <dd className="truncate font-medium">
                        {getOperatorLabel(selectedFlightDisplay)}
                      </dd>
                    </div>
                  ) : null}
                  {selectedFlightDisplay.registration &&
                  getPrimaryIdentifier(selectedFlightDisplay) !== selectedFlightDisplay.registration ? (
                    <div className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Registration
                      </dt>
                      <dd className="truncate font-medium tabular-nums">
                        {selectedFlightDisplay.registration}
                      </dd>
                    </div>
                  ) : null}
                  {getRouteLabel(selectedFlightDisplay) ? (
                    <div className="col-span-2 min-w-0">
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Route
                      </dt>
                      <dd className="truncate font-medium tabular-nums">
                        {getRouteLabel(selectedFlightDisplay)}
                      </dd>
                    </div>
                  ) : null}
                  {normalizeRegisteredOwnerLabel(selectedFlightDisplay.registeredOwner) &&
                  normalizeRegisteredOwnerLabel(selectedFlightDisplay.registeredOwner) !==
                    getOperatorLabel(selectedFlightDisplay) ? (
                    <div className="col-span-2 min-w-0">
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Owner
                      </dt>
                      <dd className="truncate font-medium">
                        {normalizeRegisteredOwnerLabel(selectedFlightDisplay.registeredOwner)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <Separator className="my-2" />
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Distance
                    </dt>
                    <dd className="font-medium tabular-nums">
                      {formatDistanceMiles(
                        getDistanceFromHomeBaseMiles(selectedFlightDisplay, homeBase)
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Altitude
                    </dt>
                    <dd className="flex items-baseline gap-1 font-medium tabular-nums">
                      {formatAltitude(
                        selectedFlightDisplay.altitudeFeet,
                        activeSelectedFlightDetails?.status
                      )}
                      {altitudeTrend ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            "text-[10px]",
                            altitudeTrend === "up" ? "text-emerald-500" : "text-red-500"
                          )}
                        >
                          {altitudeTrend === "up" ? "↑" : "↓"}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Airspeed
                    </dt>
                    <dd className="flex items-baseline gap-1 font-medium tabular-nums">
                      {formatAirspeed(selectedFlightDisplay.groundspeedKnots)}
                      {airspeedTrend ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            "text-[10px]",
                            airspeedTrend === "up" ? "text-emerald-500" : "text-red-500"
                          )}
                        >
                          {airspeedTrend === "up" ? "↑" : "↓"}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <ScrollArea className="flex-1 px-1">
            <div className="flex flex-col gap-1 pb-2">
              {displayFlights.map((flight) => {
                const isSelected = flight.id === selectedFlightDisplay?.id;
                const isStripHovered = flight.id === hoveredStripFlightId;
                const rankChange = stripRankChanges[flight.id];
                return (
                  <button
                    className={cn(
                      "group flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                      "border-sidebar-border bg-sidebar/40 hover:bg-sidebar-accent/60",
                      isSelected &&
                        "border-sidebar-primary bg-sidebar-accent text-sidebar-accent-foreground",
                      isStripHovered && !isSelected && "border-sidebar-primary/40"
                    )}
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
                    <div className="flex items-center justify-between gap-2">
                      <strong className="truncate text-sm font-semibold tabular-nums">
                        {getPrimaryIdentifier(flight)}
                      </strong>
                      <span className="flex items-center gap-1.5">
                        {rankChange ? (
                          <span
                            aria-label={rankChange > 0 ? "Moved closer" : "Moved farther"}
                            className={cn(
                              "text-[10px] font-medium",
                              rankChange > 0 ? "text-emerald-500" : "text-muted-foreground"
                            )}
                            title={rankChange > 0 ? "Moved closer" : "Moved farther"}
                          >
                            {rankChange > 0 ? "↑" : "↓"}
                          </span>
                        ) : null}
                        <Badge
                          variant="outline"
                          className="px-1.5 py-0 text-[9px] font-normal tabular-nums"
                        >
                          {flight.aircraftType ?? "UNK"}
                        </Badge>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <span className="flex min-w-0 flex-col">
                        <small className="text-[9px] uppercase tracking-wider text-muted-foreground">
                          Operator
                        </small>
                        <strong className="truncate font-medium">
                          {getListSecondaryLeft(flight)}
                        </strong>
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <small className="text-[9px] uppercase tracking-wider text-muted-foreground">
                          Route
                        </small>
                        <strong className="truncate font-medium tabular-nums">
                          {getStripRouteLabel(flight)}
                        </strong>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </SidebarContent>

        <SidebarFooter className="gap-2 px-3 py-2">
          <Popover open={areaFlyoutOpen} onOpenChange={setAreaFlyoutOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-between">
                <span className="text-xs text-muted-foreground">Area</span>
                <strong className="text-xs tabular-nums">{radiusMiles} mi</strong>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-72">
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor="area-lat" className="text-[10px] uppercase tracking-wider">
                      Latitude
                    </Label>
                    <Input
                      className="h-8 tabular-nums"
                      id="area-lat"
                      onChange={(event) =>
                        setAreaDraft((currentDraft) => ({
                          ...currentDraft,
                          latitude: event.target.value
                        }))
                      }
                      type="text"
                      value={areaDraft.latitude}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="area-lon" className="text-[10px] uppercase tracking-wider">
                      Longitude
                    </Label>
                    <Input
                      className="h-8 tabular-nums"
                      id="area-lon"
                      onChange={(event) =>
                        setAreaDraft((currentDraft) => ({
                          ...currentDraft,
                          longitude: event.target.value
                        }))
                      }
                      type="text"
                      value={areaDraft.longitude}
                    />
                  </div>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="area-rad" className="text-[10px] uppercase tracking-wider">
                    Radius (miles)
                  </Label>
                  <Input
                    className="h-8 tabular-nums"
                    id="area-rad"
                    onChange={(event) =>
                      setAreaDraft((currentDraft) => ({
                        ...currentDraft,
                        radiusMiles: event.target.value
                      }))
                    }
                    type="text"
                    value={areaDraft.radiusMiles}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button onClick={setDraftFromMapCenter} size="sm" type="button" variant="outline">
                    Use map center
                  </Button>
                  <Button onClick={useCurrentLocation} size="sm" type="button" variant="outline">
                    {isLocating ? "Locating..." : "My location"}
                  </Button>
                  <Button className="ml-auto" onClick={applyAreaDraft} size="sm" type="button">
                    Apply
                  </Button>
                </div>
                {areaError ? <p className="text-xs text-destructive">{areaError}</p> : null}
              </div>
            </PopoverContent>
          </Popover>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="uppercase tracking-wider">Source</span>
            <span className="truncate tabular-nums">{dataSource}</span>
          </div>
        </SidebarFooter>
      </Sidebar>

      {hoveredFlightDisplay && hoveredFlight ? (
        <div
          className="pointer-events-none fixed z-20 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: hoveredFlight.left,
            top: hoveredFlight.top,
            transform: "translate(8px, 8px)"
          }}
        >
          <div className="flex items-center gap-2">
            <strong className="tabular-nums">{getPrimaryIdentifier(hoveredFlightDisplay)}</strong>
            {hoveredFlightDisplay.aircraftType ? (
              <Badge
                variant="outline"
                className="px-1 py-0 text-[9px] font-normal tabular-nums"
              >
                {hoveredFlightDisplay.aircraftType}
              </Badge>
            ) : null}
          </div>
          <span className="text-muted-foreground">{getHoverSubtitle(hoveredFlightDisplay)}</span>
        </div>
      ) : null}
      <SidebarTrigger className="fixed top-4 left-4 z-20 md:hidden" />
    </>
  );
}
