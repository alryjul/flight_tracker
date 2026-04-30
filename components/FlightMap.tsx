"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { APP_CONFIG } from "@/lib/config";
import {
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
  getAircraftTypeFamily,
  getCompactRouteLabel,
  getPrimaryIdentifier,
  isFlightVfrForLabel,
  looksLikeAgencyLabel,
  looksLikeGeneralAviationFlight,
  looksLikeManufacturerName
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
  computeSpringProviderTimestampSec,
  updateFlightAnimationStates,
  updateProviderDeltaEma
} from "@/lib/map/animation";
import {
  buildHomeBaseFeatures,
  buildOpeningBounds,
  buildRingCoordinates,
  dedupeCoordinates,
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles,
  isValidTrackCoordinate,
  sanitizeCoordinateSequence
} from "@/lib/map/geo-helpers";
import {
  areSelectedFlightDetailsEquivalent,
  areTrackPointsEquivalent,
  getBreadcrumbPoints,
  getFirstTrackTimestampMs,
  getLastTrackTimestampMs,
  hashTrackSegments,
  mergeSameFlightTrackHistory,
  mergeSelectedFlightDetailPayload,
  resolveSelectedTrackRefresh
} from "@/lib/map/trails";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { AreaConfigPopover } from "@/components/flight-tracker/AreaConfigPopover";
import { FlightList } from "@/components/flight-tracker/FlightList";
import { MapCanvas } from "@/components/flight-tracker/MapCanvas";
import { MapHoverCard } from "@/components/flight-tracker/MapHoverCard";
import { SelectedFlightCard } from "@/components/flight-tracker/SelectedFlightCard";
import { SourceStatusFooter } from "@/components/flight-tracker/SourceStatusFooter";

import type {
  BreadcrumbPoint,
  FlightAnimationState,
  FlightApiResponse,
  FlightBreadcrumbBuffer,
  FlightSnapshot,
  HomeBaseCenter,
  HoveredFlightState,
  IdentityScopedValue,
  RememberedFlightMetadata,
  SelectedFlightDetailsResponse,
  SelectedTrackPoint,
  TrendDirection
} from "@/lib/types/flight-map";
import {
  AIRSPEED_TREND_THRESHOLD_KNOTS,
  ALTITUDE_TREND_THRESHOLD_FEET,
  BOOTSTRAP_MAX_EXTRAPOLATION_SEC,
  BREADCRUMB_LEAD_TOLERANCE_MILES,
  BREADCRUMB_LEG_BREAK_GAP_MS,
  DEADBAND_FRACTION_OF_EXPECTED_MOVE,
  FLIGHT_BREADCRUMB_BUFFER_MAX_POINTS,
  FLIGHT_BREADCRUMB_BUFFER_RETENTION_MS,
  HIDDEN_TAB_REFRESH_MS,
  HOME_BASE_STORAGE_KEY,
  MAX_BREADCRUMB_OVERLAP_MILES,
  MAX_POSITION_JITTER_DEADBAND_MILES,
  MAX_PROVIDER_TO_BREADCRUMB_CONNECT_MILES,
  MAX_TRACK_SEGMENT_MILES,
  MAX_TRACK_TO_AIRCRAFT_MILES,
  METRIC_TREND_LOOKBACK_MS,
  MIN_METRIC_TREND_POINTS,
  MIN_POSITION_CHANGE_MILES,
  PROVIDER_DELTA_EMA_DECAY,
  PROXIMITY_RING_MILES,
  SELECTED_ENRICHMENT_RETRY_DELAYS_MS,
  SELECTED_TRACK_REFRESH_GRACE_MS,
  SNAPSHOT_HISTORY_RETENTION_MS,
  SPRING_TAU_SEC,
  STRIP_HOVER_ECHO_BASE_RADIUS,
  STRIP_HOVER_ECHO_DURATION_MS,
  STRIP_HOVER_ECHO_GROWTH,
  STRIP_RANK_CUE_MS,
  STRIP_REORDER_INTERVAL_MS,
  STRIP_REORDER_RANK_THRESHOLD,
  STRIP_REORDER_SCORE_THRESHOLD,
  VISIBLE_FLIGHT_ENTRY_COUNT,
  VISIBLE_FLIGHT_EXIT_RANK,
  VISIBLE_FLIGHT_LIMIT,
  VISIBLE_FLIGHT_LINGER_MS,
  refreshMs
} from "@/lib/config/flight-map-constants";

export function FlightMap() {
  const mapRef = useRef<MapLibreMap | null>(null);
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
          The MapCanvas owns the maplibre instance, RAF render loop, and
          selected-track effects; FlightMap is the orchestrator that owns the
          shared mutable refs the RAF reads from. */}
      <MapCanvas
        homeBase={homeBase}
        homeBaseFeatures={homeBaseFeatures}
        openingBounds={openingBounds}
        selectedFlightId={selectedFlightId}
        activeSelectedFlightDetails={activeSelectedFlightDetails}
        mapRef={mapRef}
        displayFlightsRef={displayFlightsRef}
        flightAnimationStatesRef={flightAnimationStatesRef}
        snapshotHistoryRef={snapshotHistoryRef}
        flightBreadcrumbsRef={flightBreadcrumbsRef}
        selectedFlightIdRef={selectedFlightIdRef}
        hoveredFlightIdRef={hoveredFlightIdRef}
        hoveredStripFlightIdRef={hoveredStripFlightIdRef}
        hoveredStripStartedAtRef={hoveredStripStartedAtRef}
        activeSelectedFlightDetailsRef={activeSelectedFlightDetailsRef}
        selectedFlightDetailsFlightIdRef={selectedFlightDetailsFlightIdRef}
        selectedMetadataByIdRef={selectedMetadataByIdRef}
        selectedRenderedPositionRef={selectedRenderedPositionRef}
        onSelectFlight={setSelectedFlightId}
        onHoverFlight={setHoveredFlight}
      />

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
            <SelectedFlightCard
              flight={selectedFlightDisplay}
              details={activeSelectedFlightDetails}
              homeBase={homeBase}
              altitudeTrend={altitudeTrend}
              airspeedTrend={airspeedTrend}
            />
          ) : null}
          <FlightList
            flights={displayFlights}
            selectedFlightId={selectedFlightDisplay?.id ?? null}
            hoveredStripFlightId={hoveredStripFlightId}
            stripRankChanges={stripRankChanges}
            onSelectFlight={setSelectedFlightId}
            onHoverStart={handleStripHoverStart}
            onHoverEnd={handleStripHoverEnd}
            registerStripRef={(id, node) => {
              if (node) stripElementRefs.current.set(id, node);
              else stripElementRefs.current.delete(id);
            }}
          />
        </SidebarContent>

        <SidebarFooter className="gap-2 px-3 py-2">
          <AreaConfigPopover
            open={areaFlyoutOpen}
            onOpenChange={setAreaFlyoutOpen}
            radiusMiles={radiusMiles}
            areaDraft={areaDraft}
            areaError={areaError}
            isLocating={isLocating}
            onDraftChange={setAreaDraft}
            onUseMapCenter={setDraftFromMapCenter}
            onUseLocation={useCurrentLocation}
            onApply={applyAreaDraft}
          />
          <SourceStatusFooter dataSource={dataSource} />
        </SidebarFooter>
      </Sidebar>

      <MapHoverCard hoveredFlight={hoveredFlight} hoveredFlightDisplay={hoveredFlightDisplay} />
      <SidebarTrigger className="fixed top-4 left-4 z-20 md:hidden" />
    </>
  );
}
