"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { AeroApiFeedMetadata } from "@/lib/flights/aeroapi";
import { getPrimaryIdentifier } from "@/lib/flights/display";
import { getFlightMetricHistory, getMetricTrend } from "@/lib/flights/metrics";
import { pickPredictedNearestFlights } from "@/lib/flights/predictedNearest";
import {
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
import { updateFlightAnimationStates } from "@/lib/map/animation";
import {
  buildHomeBaseFeatures,
  buildOpeningBounds,
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles
} from "@/lib/map/geo-helpers";
import {
  areSelectedFlightDetailsEquivalent,
  mergeSelectedFlightDetailPayload
} from "@/lib/map/trails";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
  useSidebar
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { AreaConfigPopover } from "@/components/flight-tracker/AreaConfigPopover";
import { FlightList } from "@/components/flight-tracker/FlightList";
import { useAutoHideCursor } from "@/hooks/use-auto-hide-cursor";
import { MapCanvas } from "@/components/flight-tracker/MapCanvas";
import { AmbientView } from "@/components/flight-tracker/AmbientView";
import {
  DEFAULT_MAP_LABEL_VISIBILITY,
  MapLayersPopover,
  type MapLabelVisibility
} from "@/components/flight-tracker/MapLayersPopover";
import { Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MapHoverCard } from "@/components/flight-tracker/MapHoverCard";
import { SelectedFlightCard } from "@/components/flight-tracker/SelectedFlightCard";
import { SourceStatusFooter } from "@/components/flight-tracker/SourceStatusFooter";

import type {
  FlightAnimationState,
  FlightApiResponse,
  FlightBreadcrumbBuffer,
  FlightSnapshot,
  HomeBaseCenter,
  HoveredFlightState,
  IdentityScopedValue,
  RememberedFlightMetadata,
  SelectedFlightDetailsResponse,
  ViewportBounds
} from "@/lib/types/flight-map";
import {
  AIRSPEED_TREND_THRESHOLD_KNOTS,
  ALTITUDE_TREND_THRESHOLD_FEET,
  BREADCRUMB_LEG_BREAK_GAP_MS,
  FLIGHT_BREADCRUMB_BUFFER_MAX_POINTS,
  FLIGHT_BREADCRUMB_BUFFER_RETENTION_MS,
  AMBIENT_MODE_STORAGE_KEY,
  HIDDEN_TAB_REFRESH_MS,
  HOME_BASE_STORAGE_KEY,
  MAP_LABEL_VISIBILITY_STORAGE_KEY,
  SELECTED_ENRICHMENT_RETRY_DELAYS_MS,
  SNAPSHOT_HISTORY_RETENTION_MS,
  NEAREST_FORCE_SWITCH_MARGIN_MILES,
  NEAREST_HYSTERESIS_MARGIN_MILES,
  NEAREST_MIN_HOLD_MS,
  NEAREST_TRACE_PREFETCH_COUNT,
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
  const [mapLabelVisibility, setMapLabelVisibility] = useState<MapLabelVisibility>(
    DEFAULT_MAP_LABEL_VISIBILITY
  );
  // Why: ambient mode = floating "look at this" widget over the map
  // showing the nearest aircraft via large split-flap displays.
  // Toggleable; the map keeps polling underneath so re-entering
  // returns to the live session immediately.
  const [ambientMode, setAmbientMode] = useState(false);

  // Why: hide the cursor after a short idle period so it doesn't sit
  // on the screen as a permanent distraction in ambient / kiosk
  // viewing. Tighter timeout in ambient mode (cursor is essentially
  // useless there) than in normal interactive mode (where the user
  // is more likely to want it back quickly when they reach for the
  // mouse). See hooks/use-auto-hide-cursor.ts.
  useAutoHideCursor(ambientMode ? 5000 : 10000);

  // Why: drive the sidebar's open state from ambient mode — when the
  // user enters ambient, collapse the sidebar so the chrome gets out
  // of the way. When they exit, restore it. Uses the SidebarProvider
  // context exposed at app/page.tsx; setOpen handles desktop, and
  // setOpenMobile handles the mobile sheet variant.
  const { setOpen: setSidebarOpen, setOpenMobile: setSidebarOpenMobile } =
    useSidebar();
  useEffect(() => {
    setSidebarOpen(!ambientMode);
    if (ambientMode) {
      setSidebarOpenMobile(false);
    }
  }, [ambientMode, setSidebarOpen, setSidebarOpenMobile]);
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
  // Why: ID of the auto-tracked nearest flight, mirrored to a ref so
  // the RAF map-render loop can read it without re-establishing on
  // every re-render. Stays null whenever a flight is selected (we
  // don't double-highlight); otherwise tracks the closest flight
  // to home base. The map paints this flight with the orange marker
  // (no halo) so the user can see at a glance which plane the
  // sidebar's "Nearest now" button or the ambient widget refers to.
  const nearestFlightIdRef = useRef<string | null>(null);
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
    // Why: the effect at ~line 285 maintains `visibleFlightIds` capped
    // at VISIBLE_FLIGHT_LIMIT (curating by rank + linger + selected).
    // We keep the reconcile here so first-load doesn't flash empty —
    // when visibleFlightIds is `[]`, reconcile populates ordered IDs
    // from the latest poll (already distance-sorted by the BE). But
    // we MUST slice to VISIBLE_FLIGHT_LIMIT, otherwise the reconcile
    // appends every uncapped ID from `flights` (up to the BE's
    // DISCOVERY_FLIGHT_CANDIDATE_LIMIT of 80) and silently bypasses
    // the cap. Without this slice, "{N} flights in view" would happily
    // climb past 50 even though the constant says it shouldn't.
    const orderedIds = reconcileFlightOrder(
      visibleFlightIds,
      flights.map((flight) => flight.id)
    ).slice(0, VISIBLE_FLIGHT_LIMIT);

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

  // Why: track the actual map viewport bounds so the "{N} flights in
  // view" count reflects what's literally on screen, not just what
  // /api/flights returned for the configured polling area. The
  // polling area is a fixed radius around home base; the map can be
  // panned / zoomed independently. Before this, the count read "61"
  // even when the user had zoomed in to 5 visible markers — confusing
  // and dishonest. Bounds are reported by MapCanvas on map load and
  // every `moveend`. Null until the map mounts; we fall back to
  // displayFlights.length so first paint isn't blank.
  const [viewportBounds, setViewportBounds] = useState<ViewportBounds | null>(null);
  const flightsInViewportCount = useMemo(() => {
    if (!viewportBounds) return displayFlights.length;
    return displayFlights.filter(
      (flight) =>
        flight.latitude >= viewportBounds.south &&
        flight.latitude <= viewportBounds.north &&
        flight.longitude >= viewportBounds.west &&
        flight.longitude <= viewportBounds.east
    ).length;
  }, [displayFlights, viewportBounds]);

  // Why: only resolve a selected flight when there's an explicit
  // selectedFlightId state. Previously this fell back to
  // displayFlights[0] when no selection existed — which meant
  // calling setSelectedFlightId(null) (e.g., from the map-background
  // click deselect handler) silently re-bound the UI to whatever
  // flight happened to be first in the visible list. The "deselect"
  // state was unreachable: clicking off a flight just shifted the
  // selection sideways instead of clearing it.
  const selectedFlightBase =
    selectedFlightId != null
      ? (displayFlights.find((flight) => flight.id === selectedFlightId) ?? null)
      : null;
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

  // Why: hydrate the map label/overlay/road-dim toggles from
  // localStorage on first mount. Same shape as the home-base
  // hydration above. We can't use a lazy useState initializer
  // because that runs during SSR where window.localStorage doesn't
  // exist; this effect-based hydration accepts a one-frame flash of
  // defaults but avoids hydration mismatch and SSR explosion.
  //
  // Each key is validated independently so:
  //   - corrupt JSON falls back to defaults (catch)
  //   - missing keys (older saves before a field was added) keep
  //     their default value
  //   - wrong-type values (e.g. someone hand-edited localStorage to
  //     stuff a string in roadDimDark) get rejected per-field
  // The merge is field-by-field rather than spread because we want
  // to ignore garbage rather than blindly accept it.
  useEffect(() => {
    const stored = window.localStorage.getItem(
      MAP_LABEL_VISIBILITY_STORAGE_KEY
    );
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Partial<
        Record<keyof MapLabelVisibility, unknown>
      >;
      setMapLabelVisibility((prev) => {
        const next: MapLabelVisibility = { ...prev };
        const booleanKeys: Array<keyof MapLabelVisibility> = [
          "placeLabels",
          "roadLabels",
          "poiLabels",
          "homeBaseIcon",
          "homeBaseRings",
          "flightTrail"
        ];
        for (const key of booleanKeys) {
          if (typeof parsed[key] === "boolean") {
            (next[key] as boolean) = parsed[key] as boolean;
          }
        }
        if (
          typeof parsed.roadDimDark === "number" &&
          Number.isFinite(parsed.roadDimDark) &&
          parsed.roadDimDark >= 0 &&
          parsed.roadDimDark <= 1
        ) {
          next.roadDimDark = parsed.roadDimDark;
        }
        return next;
      });
    } catch (error) {
      console.error("Failed to restore saved map label visibility", error);
    }
  }, []);

  // Why: persist on every change. Same eager-write pattern as the
  // home-base block — JSON.stringify on every keystroke of the
  // slider is fine (the object is tiny and writes are synchronous,
  // single-digit μs).
  useEffect(() => {
    window.localStorage.setItem(
      MAP_LABEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify(mapLabelVisibility)
    );
  }, [mapLabelVisibility]);

  // Why: hydrate ambient/kiosk mode from localStorage on first mount.
  // Same effect-after-mount pattern as the other persisted view
  // settings (no lazy useState initializer because window.localStorage
  // doesn't exist during SSR). One-frame flash of `false` before the
  // hydration lands is acceptable — the ambient view is fullscreen
  // chrome, not interactive map state, so the brief flicker is no
  // worse than the cold-start theme detection.
  useEffect(() => {
    const stored = window.localStorage.getItem(AMBIENT_MODE_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (typeof parsed === "boolean") {
        setAmbientMode(parsed);
      }
    } catch (error) {
      console.error("Failed to restore saved ambient mode", error);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      AMBIENT_MODE_STORAGE_KEY,
      JSON.stringify(ambientMode)
    );
  }, [ambientMode]);

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
        // Keep an existing valid selection across polls; otherwise
        // return null. The previous behavior fell back to
        // sortedFlights[0]?.id when no selection existed, which made
        // an explicit deselect (setSelectedFlightId(null) from the
        // map-background click handler) un-stick on the very next
        // poll. The user reported "takes two click-outs" — that's
        // because click 2 had to land before the next poll could
        // re-auto-select. With this change, null stays null until
        // the user picks something explicitly.
        if (currentId && sortedFlights.some((flight) => flight.id === currentId)) {
          return currentId;
        }
        return null;
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

  // Why: opportunistic prefetch — fire /api/flights/selected for the
  // top-N predicted-nearest flights so their full enrichment (status,
  // schedule times, IATA flight number, route, full provider track)
  // is already in `selectedMetadataById` by the time the nearest
  // pointer transitions to any of them. Same call, same cache, same
  // storage as the user-selected fetch. The only "nearest"-specific
  // logic is the heuristic that picks WHICH flights to prefetch —
  // everything downstream (merge pipeline, hero card, map trail) is
  // shared with the selected case.
  //
  // Reads `selectedMetadataByIdRef.current` (not the state) so the
  // effect doesn't re-run on every state update — only when the
  // top-N candidate set could have meaningfully changed
  // (displayFlights or selectedFlightId). Filters out the selected
  // flight (its dedicated effect handles it) and any candidate that
  // already has a cached entry. Server-side cache (DETAIL_TTL_MS =
  // 2 min) absorbs intra-window calls; cross-window we re-fire on
  // the next candidate-set change.
  useEffect(() => {
    if (displayFlights.length === 0) return;

    const candidates = pickPredictedNearestFlights(
      displayFlights,
      homeBase,
      NEAREST_TRACE_PREFETCH_COUNT
    ).filter((candidate) => {
      if (candidate.id === selectedFlightId) return false;
      const existing = getIdentityScopedValue(
        selectedMetadataByIdRef.current[candidate.id],
        candidate
      );
      return existing == null;
    });

    if (candidates.length === 0) return;

    let cancelled = false;
    const controllers: AbortController[] = [];

    for (const candidate of candidates) {
      const controller = new AbortController();
      controllers.push(controller);

      const params = new URLSearchParams({
        id: candidate.id,
        callsign: candidate.callsign
      });
      // Why: pass through every metadata field the server route
      // accepts via getFlightFromSearchParams — the route builds a
      // synthetic Flight from these for AeroAPI matching, and the
      // more it knows the better the match. Mirrors what the
      // selected-flight effect builds.
      if (candidate.flightNumber)
        params.set("flightNumber", candidate.flightNumber);
      if (candidate.airline) params.set("airline", candidate.airline);
      if (candidate.aircraftType)
        params.set("aircraftType", candidate.aircraftType);
      if (candidate.origin) params.set("origin", candidate.origin);
      if (candidate.destination)
        params.set("destination", candidate.destination);
      if (candidate.registration)
        params.set("registration", candidate.registration);
      if (candidate.registeredOwner)
        params.set("registeredOwner", candidate.registeredOwner);

      fetch(`/api/flights/selected?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal
      })
        .then((response) =>
          response.ok ? (response.json() as Promise<SelectedFlightDetailsResponse>) : null
        )
        .then((data) => {
          if (cancelled || !data?.details) return;
          setSelectedMetadataById((current) => ({
            ...current,
            [candidate.id]: {
              identityKey: getLiveFlightIdentityKey(candidate),
              value: data.details
            }
          }));
        })
        .catch(() => {
          // Silent — opportunistic enrichment. Next candidate-set
          // change re-runs us; abort cleanup is the cancelled path.
        });
    }

    return () => {
      cancelled = true;
      for (const controller of controllers) controller.abort();
    };
  }, [displayFlights, selectedFlightId, homeBase]);

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

  // Why: hysteresis on the auto-tracked nearest. Naive "always pick
  // the current closest" thrashes — orange-dot, trail, hero card,
  // ambient widget all flip every time two flights' distances cross,
  // which happens often when planes are approaching and departing
  // simultaneously. We sticky-keep the current pick for at least
  // NEAREST_MIN_HOLD_MS, and after that require a new candidate to
  // be NEAREST_HYSTERESIS_MARGIN_MILES closer than the sticky pick
  // before swapping. The force-switch override fires immediately
  // when something is dramatically closer (NEAREST_FORCE_SWITCH_-
  // MARGIN_MILES) — a plane RIGHT OVER home base shouldn't have to
  // wait its turn just because another plane was closest a second
  // ago. The current sticky decision is held in a ref, mutated
  // during the memo (acceptable: refs don't trigger re-renders).
  const stickyNearestRef = useRef<{ id: string; selectedAt: number } | null>(
    null
  );
  const nearestFlight = useMemo<Flight | null>(() => {
    if (displayFlights.length === 0) {
      stickyNearestRef.current = null;
      return null;
    }

    let rawClosest: Flight | null = null;
    let rawClosestDistance = Number.POSITIVE_INFINITY;
    for (const flight of displayFlights) {
      const dist = getDistanceFromHomeBaseMiles(flight, homeBase);
      if (dist < rawClosestDistance) {
        rawClosest = flight;
        rawClosestDistance = dist;
      }
    }
    if (!rawClosest) {
      stickyNearestRef.current = null;
      return null;
    }

    const now = Date.now();
    const sticky = stickyNearestRef.current;
    const stickyFlight =
      sticky != null
        ? displayFlights.find((flight) => flight.id === sticky.id) ?? null
        : null;

    // No prior sticky, or it's no longer in displayFlights — adopt
    // the raw closest immediately.
    if (sticky == null || stickyFlight == null) {
      stickyNearestRef.current = { id: rawClosest.id, selectedAt: now };
      return rawClosest;
    }

    // Same flight is still the raw closest — keep going.
    if (sticky.id === rawClosest.id) {
      return stickyFlight;
    }

    const stickyDistance = getDistanceFromHomeBaseMiles(stickyFlight, homeBase);
    const margin = stickyDistance - rawClosestDistance;
    const heldFor = now - sticky.selectedAt;

    // Force-switch: new candidate is dramatically closer (e.g., a
    // plane just appeared right over home base). Override the hold.
    if (margin >= NEAREST_FORCE_SWITCH_MARGIN_MILES) {
      stickyNearestRef.current = { id: rawClosest.id, selectedAt: now };
      return rawClosest;
    }

    // Within the minimum hold window — keep the sticky pick.
    if (heldFor < NEAREST_MIN_HOLD_MS) {
      return stickyFlight;
    }

    // Hold elapsed — switch only if the new candidate is meaningfully
    // closer than the sticky pick. The margin filter prevents
    // oscillation when two planes are essentially equidistant.
    if (margin < NEAREST_HYSTERESIS_MARGIN_MILES) {
      return stickyFlight;
    }

    stickyNearestRef.current = { id: rawClosest.id, selectedAt: now };
    return rawClosest;
  }, [displayFlights, homeBase]);

  // Why: only paint the nearest highlight when there's no explicit
  // selection. With a selection, the selected halo + dot already
  // signals "this is what we're focused on" — adding a second orange
  // dot for nearest would be visual noise. Mirroring to a ref keeps
  // the high-frequency RAF map-render loop reading from a stable
  // location without re-establishing on every poll.
  useEffect(() => {
    nearestFlightIdRef.current = selectedFlightId ? null : nearestFlight?.id ?? null;
  }, [nearestFlight, selectedFlightId]);

  // Why: ambient view subject — prefer the user-selected flight when one
  // is selected, fall back to the auto-tracked nearest. AmbientView's
  // dt label adapts ("SELECTED" vs "NEAREST") so the user can tell
  // which mode they're in. When the selected flight is no longer in
  // the visible flight set (drifted out of range, lost ADS-B), the
  // lookup returns undefined and we fall through to nearest.
  const ambientFlight = useMemo<Flight | null>(() => {
    if (selectedFlightId) {
      const found = displayFlights.find((f) => f.id === selectedFlightId);
      if (found) return found;
    }
    return nearestFlight;
  }, [selectedFlightId, displayFlights, nearestFlight]);
  const ambientFlightIsSelected =
    selectedFlightId != null &&
    ambientFlight != null &&
    ambientFlight.id === selectedFlightId;

  // Why: trend arrows (↑/↓) for altitude and airspeed are computed
  // from the snapshot history for whichever flight is being shown.
  // The existing altitude/airspeedTrend above are scoped to the
  // selected flight; we compute a separate pair for the ambient
  // flight here so trends still render when ambient is auto-tracking
  // the nearest aircraft (no selection). When ambientFlight ===
  // selected, both pairs converge on the same values.
  const ambientAltitudeTrend = ambientFlight
    ? getMetricTrend(
        getFlightMetricHistory(
          snapshotHistoryRef.current,
          ambientFlight,
          (f) => f.altitudeFeet
        ),
        ALTITUDE_TREND_THRESHOLD_FEET
      )
    : null;
  const ambientAirspeedTrend = ambientFlight
    ? getMetricTrend(
        getFlightMetricHistory(
          snapshotHistoryRef.current,
          ambientFlight,
          (f) => f.groundspeedKnots
        ),
        AIRSPEED_TREND_THRESHOLD_KNOTS
      )
    : null;

  // Why: stable callback for the map background-click handler in
  // MapCanvas. Wrapping in useCallback keeps MapCanvas's effect deps
  // happy and avoids re-registering the click listener on every
  // FlightMap render.
  const handleDeselectFlight = useCallback(() => {
    setSelectedFlightId(null);
  }, []);

  const hoveredFlightDisplay =
    hoveredFlight == null
      ? null
      : displayFlights.find((flight) => flight.id === hoveredFlight.flightId) ?? null;

  function handleAreaPopoverOpenChange(open: boolean) {
    if (open) {
      // Reset draft to the current applied area so reopening shows fresh values
      // rather than the stale, half-edited draft from a previous session.
      setAreaError(null);
      setAreaDraft({
        latitude: homeBase.latitude.toFixed(4),
        longitude: homeBase.longitude.toFixed(4),
        radiusMiles: String(radiusMiles)
      });
    }
    setAreaFlyoutOpen(open);
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

  // Why: snap the map view back to the home base + radius without
  // touching any state. Reuses the same `openingBounds` calculation
  // that drives the initial fit on map load — fitBounds keeps the
  // home base visually centered and the search radius rings fully in
  // view at the standard padding.
  function recenterMap() {
    if (!mapRef.current) return;
    mapRef.current.fitBounds(openingBounds, { padding: 40, duration: 400 });
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

  // Why: stable callback identity so memoized FlightListItem children don't
  // re-render every poll. The function only touches refs + stable setters.
  const handleStripHoverStart = useCallback((flightId: string) => {
    if (hoveredStripFlightIdRef.current === flightId) {
      return;
    }

    hoveredStripFlightIdRef.current = flightId;
    hoveredStripStartedAtRef.current = performance.now();
    setHoveredStripFlightId(flightId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStripHoverEnd = useCallback((flightId: string) => {
    if (hoveredStripFlightIdRef.current !== flightId) {
      return;
    }

    hoveredStripFlightIdRef.current = null;
    hoveredStripStartedAtRef.current = null;
    setHoveredStripFlightId((currentId) => (currentId === flightId ? null : currentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registerStripRef = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) {
      stripElementRefs.current.set(id, node);
    } else {
      stripElementRefs.current.delete(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        nearestFlightIdRef={nearestFlightIdRef}
        hoveredFlightIdRef={hoveredFlightIdRef}
        hoveredStripFlightIdRef={hoveredStripFlightIdRef}
        hoveredStripStartedAtRef={hoveredStripStartedAtRef}
        activeSelectedFlightDetailsRef={activeSelectedFlightDetailsRef}
        selectedFlightDetailsFlightIdRef={selectedFlightDetailsFlightIdRef}
        selectedMetadataByIdRef={selectedMetadataByIdRef}
        selectedRenderedPositionRef={selectedRenderedPositionRef}
        onSelectFlight={setSelectedFlightId}
        onDeselectFlight={handleDeselectFlight}
        onHoverFlight={setHoveredFlight}
        onViewportChange={setViewportBounds}
        mapLabelVisibility={mapLabelVisibility}
      />

      <Sidebar variant="floating" side="left" collapsible="offcanvas">
        <SidebarHeader className="gap-2 px-3 pt-3 pb-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 flex-1 text-base leading-tight">
              <span className="font-semibold tabular-nums">
                {flightsInViewportCount} flights
              </span>
              <span className="ml-1 font-normal text-sidebar-foreground/60">
                in view
              </span>
            </h2>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Show ambient view"
                aria-pressed={ambientMode}
                onClick={() => setAmbientMode(true)}
              >
                <Tv aria-hidden="true" />
              </Button>
              <ThemeToggle />
            </div>
          </div>
          {/* Why: "Nearest now" pill — always visible (when a nearest
              exists) so the user can see what plane is currently
              closest to home base regardless of whether they have
              another flight selected. Click to promote the nearest
              to the user's selection (swaps the orange-no-halo
              treatment for the full selected halo + dot, brings up
              its full details in the hero card). When nothing is
              selected, the hero card already shows this same plane —
              the pill stays for consistent placement and continues
              to indicate "this is the auto-tracked nearest." */}
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

        <SidebarContent className="gap-0 overflow-hidden px-2">
          {/* Why: hero card shows the user's selection when they've
              picked one, otherwise auto-tracks the nearest flight —
              same selected-or-nearest pattern used by the ambient
              widget. The "this is the nearest" signal lives in the
              pill above (in SidebarHeader) and in the orange-no-halo
              marker on the map; the card itself stays clean and
              uniform across the two states. AeroAPI-derived
              `details` are passed only for the selected case (we
              don't burn a per-poll /api/flights/selected call on the
              nearest); the card tolerates `details=null` and just
              hides the status / schedule lines in that case. Trends
              for the nearest case use ambientAltitudeTrend /
              ambientAirspeedTrend, which are computed against
              ambientFlight === nearestFlight when no selection. */}
          {selectedFlightDisplay ? (
            <SelectedFlightCard
              flight={selectedFlightDisplay}
              details={activeSelectedFlightDetails}
              homeBase={homeBase}
              altitudeTrend={altitudeTrend}
              airspeedTrend={airspeedTrend}
            />
          ) : nearestFlight ? (
            <SelectedFlightCard
              flight={nearestFlight}
              details={
                getIdentityScopedValue(
                  selectedMetadataById[nearestFlight.id],
                  nearestFlight
                ) ?? null
              }
              homeBase={homeBase}
              altitudeTrend={ambientAltitudeTrend}
              airspeedTrend={ambientAirspeedTrend}
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
            registerStripRef={registerStripRef}
          />
        </SidebarContent>

        <SidebarFooter className="gap-2 px-3 py-2">
          <SourceStatusFooter dataSource={dataSource} />
        </SidebarFooter>
      </Sidebar>

      <MapHoverCard
        hoveredFlight={hoveredFlight}
        hoveredFlightDisplay={hoveredFlightDisplay}
        homeBase={homeBase}
      />
      <SidebarTrigger className="fixed top-4 left-4 z-20 md:hidden" />

      {ambientMode ? (
        <AmbientView
          flight={ambientFlight}
          isSelected={ambientFlightIsSelected}
          flightsInViewCount={flightsInViewportCount}
          homeBase={homeBase}
          altitudeTrend={ambientAltitudeTrend}
          airspeedTrend={ambientAirspeedTrend}
          onExitAmbient={() => setAmbientMode(false)}
        />
      ) : null}

      {/* Why: floating map toolbar — layer-toggle + area-config
          buttons. MapLibre's zoom buttons sit separately to the
          right at the viewport corner. right-12 anchors the
          toolbar's right edge 48px from the viewport right,
          clearing the ~30px-wide zoom-control stack at right:10.
          The ambient-mode toggle lives in the card headers (sidebar
          + ambient view) instead of here so it's accessible from
          either context. */}
      <div className="fixed right-12 bottom-2.5 z-20 flex items-center gap-2">
        <MapLayersPopover
          visibility={mapLabelVisibility}
          onVisibilityChange={setMapLabelVisibility}
        />
        <AreaConfigPopover
          open={areaFlyoutOpen}
          onOpenChange={handleAreaPopoverOpenChange}
          radiusMiles={radiusMiles}
          areaDraft={areaDraft}
          areaError={areaError}
          isLocating={isLocating}
          onDraftChange={setAreaDraft}
          onUseMapCenter={setDraftFromMapCenter}
          onUseLocation={useCurrentLocation}
          onApply={applyAreaDraft}
          onRecenterMap={recenterMap}
        />
      </div>
    </>
  );
}
