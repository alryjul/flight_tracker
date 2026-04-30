"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap } from "maplibre-gl";
import { useTheme } from "next-themes";
import { distanceBetweenPointsMiles } from "@/lib/geo";
import type { Flight } from "@/lib/flights/types";
import { refreshVfrLatchIfApplicable } from "@/lib/flights/display";
import {
  clipBreadcrumbCoordinatesToAnimation,
  computeSpringPosition,
  getAnimatedPosition,
  getAnimationProgress,
  getDisplayedProviderTimestampMs
} from "@/lib/map/animation";
import {
  buildHomeBaseFeatures,
  getDistanceFromHomeBaseCoordinates
} from "@/lib/map/geo-helpers";
import {
  clearSelectedTrackSource,
  getSanitizedTrackCoordinates,
  sanitizeBreadcrumbPoints,
  setSelectedTrackSourceData
} from "@/lib/map/trails";
import type {
  FlightAnimationState,
  FlightBreadcrumbBuffer,
  FlightSnapshot,
  HomeBaseCenter,
  HoveredFlightState,
  IdentityScopedValue,
  SelectedFlightDetailsResponse
} from "@/lib/types/flight-map";
import {
  SPRING_TAU_SEC,
  STRIP_HOVER_ECHO_BASE_RADIUS,
  STRIP_HOVER_ECHO_DURATION_MS,
  STRIP_HOVER_ECHO_GROWTH
} from "@/lib/config/flight-map-constants";
import type { MapLabelVisibility } from "@/components/flight-tracker/MapLayersPopover";

type MapMode = "light" | "dark";

// Why: classify a basemap layer (Carto Positron / Dark Matter) into one
// of our user-toggleable categories — placeLabels (cities, towns,
// suburbs), roadLabels (street/highway names + house numbers),
// poiLabels (stadiums, parks, businesses). Returns null for layers
// that don't fit a category (water labels, boundaries, base geometry,
// our own custom flight layers) — those keep their default
// visibility regardless of toggle state.
//
// Carto's actual layer ID conventions (verified against
// positron-gl-style/style.json and dark-matter-gl-style/style.json):
//   place:    place_hamlet / _suburbs / _villages / _town / _city_*
//             / _country_* / _state / _continent / _capital_dot_*
//   road:     roadname_minor / _sec / _pri / _major  (NOT
//             "road_label_*" as I'd assumed in v1 — that miss is why
//             toggling road labels appeared to do nothing)
//             housenumber
//   poi:      poi_stadium / poi_park  (Positron only exposes a
//             handful — most "POIs" aren't actually labeled in this
//             style, so toggling has limited visible effect at the
//             city-scale zooms the app uses)
//
// Substring matching is intentional — survives small style version
// changes and accommodates the "roadname" / "road_label" / similar
// patterns other Carto styles use.
function getLabelLayerCategory(
  layerId: string,
  layerType: string
): keyof MapLabelVisibility | null {
  if (layerType !== "symbol") return null;
  const id = layerId.toLowerCase();
  if (id.includes("place")) return "placeLabels";
  if (id.includes("roadname")) return "roadLabels";
  if (id.includes("road") && id.includes("label")) return "roadLabels";
  if (id.includes("housenum")) return "roadLabels";
  if (id.includes("poi")) return "poiLabels";
  if (id.includes("airport") && id.includes("label")) return "poiLabels";
  if (id.includes("transit") && id.includes("label")) return "poiLabels";
  return null;
}

// Why: layer IDs of our custom home-base / focus-indicator layers,
// added in setupCustomLayers. Toggled together by the homeBaseIndicator
// switch — both the center point and the concentric radius rings hide
// or show as a unit (you'd never want one without the other).
const HOME_BASE_LAYER_IDS = ["home-base-point", "home-rings"] as const;

// Why: the line layer for the trail behind the selected flight,
// driven by the selected-track GeoJSON source. Toggling this off
// keeps the selected flight's marker visible but hides the path
// behind it. Single layer ID so a tiny array isn't strictly needed,
// but using the same shape as HOME_BASE_LAYER_IDS keeps the apply
// loop uniform.
const FLIGHT_TRAIL_LAYER_IDS = ["selected-track-line"] as const;

// Why: walk every layer in the current basemap style and toggle its
// visibility based on the user's category preferences. Called on
// initial map load, after every setStyle (theme switch wipes layer
// properties), and whenever the visibility prop changes.
function applyMapLabelVisibility(
  map: MapLibreMap,
  visibility: MapLabelVisibility
) {
  const style = map.getStyle();
  if (!style.layers) return;
  for (const layer of style.layers) {
    const category = getLabelLayerCategory(layer.id, layer.type);
    if (!category) continue;
    const target = visibility[category] ? "visible" : "none";
    // setLayoutProperty no-ops if the value is unchanged, so safe to
    // call eagerly without diffing.
    map.setLayoutProperty(layer.id, "visibility", target);
  }
  // Custom layers are ours (not the basemap's) — apply visibility by
  // ID directly. They're re-added on every setStyle (theme switch),
  // so this needs to run post-style-load like the label visibility
  // above.
  const customLayerGroups: Array<{
    layerIds: readonly string[];
    visible: boolean;
  }> = [
    {
      layerIds: HOME_BASE_LAYER_IDS,
      visible: visibility.homeBaseIndicator
    },
    {
      layerIds: FLIGHT_TRAIL_LAYER_IDS,
      visible: visibility.flightTrail
    }
  ];
  for (const group of customLayerGroups) {
    const target = group.visible ? "visible" : "none";
    for (const layerId of group.layerIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", target);
      }
    }
  }
}

// Why: avoid a cold-start double-style-load for dark-mode users. The
// next-themes hook returns undefined on first render; if we default to
// "light" the map paints Positron, then hydration completes, mapMode
// flips to "dark", and setStyle wipes our custom layers and reloads
// the basemap as Dark Matter — the user sees an obvious flash and
// animation doesn't smooth out for several seconds. Read the user's
// saved theme (or the OS preference) synchronously so the *first*
// render already has the right mode.
function detectInitialMapMode(): MapMode {
  if (typeof window === "undefined") return "light";
  // next-themes stores its current selection here; default key is "theme"
  // (matches our ThemeProvider config in app/layout.tsx).
  const saved = window.localStorage.getItem("theme");
  if (saved === "dark") return "dark";
  if (saved === "light") return "light";
  // "system" or unset → consult the OS preference.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const BASEMAP_URLS: Record<MapMode, string> = {
  // CartoDB Positron + Dark Matter — same layer/source structure, just inverted
  // tones, so map.setStyle() preserves the camera and we only re-add custom
  // sources/layers.
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
};

type MapPalette = {
  homeRingColor: string;
  homeBaseFill: string;
  homeBaseStroke: string;
  flightCloseColor: string;
  flightMidColor: string;
  flightFarColor: string;
  flightStroke: string;
  selectedHaloFill: string;
  selectedHaloStroke: string;
  selectedMarkerStroke: string;
  trackLineColor: string;
  labelColor: string;
  labelSelectedColor: string;
  labelHaloColor: string;
};

const PALETTES: Record<MapMode, MapPalette> = {
  light: {
    homeRingColor: "rgba(38, 84, 124, 0.25)",
    homeBaseFill: "#f4efe6",
    homeBaseStroke: "#0f4c81",
    flightCloseColor: "#0f4c81",
    flightMidColor: "#3a6f98",
    flightFarColor: "#7895ad",
    flightStroke: "#f4efe6",
    selectedHaloFill: "rgba(15, 76, 129, 0.12)",
    selectedHaloStroke: "rgba(15, 76, 129, 0.38)",
    selectedMarkerStroke: "#fff9f2",
    trackLineColor: "rgba(15, 76, 129, 0.5)",
    labelColor: "#17324d",
    labelSelectedColor: "#9f4316",
    labelHaloColor: "rgba(255,255,255,0.92)"
  },
  dark: {
    // Why: bright sky-tinted blues against the near-black Dark Matter basemap.
    // Stroke darkens (instead of cream) so dots stay legible without ringing.
    homeRingColor: "rgba(125, 174, 230, 0.32)",
    homeBaseFill: "#0f172a",
    homeBaseStroke: "#7daee6",
    flightCloseColor: "#bfdbfe",
    flightMidColor: "#7daee6",
    flightFarColor: "#5d8db8",
    flightStroke: "#0a1422",
    selectedHaloFill: "rgba(125, 174, 230, 0.18)",
    selectedHaloStroke: "rgba(125, 174, 230, 0.55)",
    selectedMarkerStroke: "#0a1422",
    trackLineColor: "rgba(125, 174, 230, 0.62)",
    labelColor: "#cbd5e1",
    labelSelectedColor: "#fdba74",
    labelHaloColor: "rgba(2,6,23,0.88)"
  }
};

type SetupArgs = {
  map: MapLibreMap;
  palette: MapPalette;
  homeBaseFeatures: ReturnType<typeof buildHomeBaseFeatures>;
  hoveredFlightIdRef: React.MutableRefObject<string | null>;
  onSelectFlight: (id: string) => void;
  onDeselectFlight: () => void;
  onHoverFlight: (state: HoveredFlightState | null) => void;
};

// Why: extracted so it can run on initial map load AND after a theme-driven
// setStyle() — maplibre wipes custom sources/layers when the basemap style
// is replaced, so we re-add them with the new palette.
function setupCustomLayers({
  map,
  palette,
  homeBaseFeatures,
  hoveredFlightIdRef,
  onSelectFlight,
  onDeselectFlight,
  onHoverFlight
}: SetupArgs) {
  map.addSource("home-base", {
    type: "geojson",
    data: homeBaseFeatures
  });

  map.addSource("flights", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });

  map.addSource("selected-track", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });

  map.addLayer({
    id: "home-rings",
    type: "line",
    source: "home-base",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": palette.homeRingColor,
      "line-width": ["match", ["get", "radiusMiles"], 3, 1.4, 8, 1.1, 1],
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
      "circle-color": palette.homeBaseFill,
      "circle-stroke-color": palette.homeBaseStroke,
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
        palette.flightCloseColor,
        ["<=", ["get", "distanceMiles"], 8],
        palette.flightMidColor,
        palette.flightFarColor
      ],
      "circle-opacity": [
        "case",
        ["<=", ["get", "distanceMiles"], 3],
        0.95,
        ["<=", ["get", "distanceMiles"], 8],
        0.82,
        0.62
      ],
      "circle-stroke-color": palette.flightStroke,
      "circle-stroke-width": ["case", ["get", "isPriority"], 2.6, 1.8]
    }
  });

  map.addLayer({
    id: "selected-flight-halo",
    type: "circle",
    source: "flights",
    filter: ["==", ["get", "isSelected"], true],
    paint: {
      "circle-radius": 18,
      "circle-color": palette.selectedHaloFill,
      "circle-stroke-color": palette.selectedHaloStroke,
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
      "circle-stroke-color": palette.selectedMarkerStroke,
      "circle-stroke-width": 3
    }
  });

  map.addLayer(
    {
      id: "selected-track-line",
      type: "line",
      source: "selected-track",
      paint: {
        "line-color": palette.trackLineColor,
        "line-width": 2.5
      }
    },
    "selected-flight-marker"
  );

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
        palette.labelSelectedColor,
        palette.labelColor
      ],
      "text-halo-color": palette.labelHaloColor,
      "text-halo-width": ["case", ["get", "isSelected"], 1.8, 1.2]
    }
  });

  map.on("click", "flight-points", (event) => {
    const feature = event.features?.[0];
    const id = feature?.properties?.id;

    if (typeof id === "string") {
      onSelectFlight(id);
    }
  });

  // Why: clicking the map background (anywhere not on a flight point)
  // deselects the currently selected flight. Without this, once the
  // user selects a flight there's no easy way to back out — the
  // selected card stays glued to the sidebar until a new flight is
  // clicked. queryRenderedFeatures filters to flight-points so we
  // don't deselect when the click DID land on a point (the
  // layer-specific handler above handles that path).
  map.on("click", (event) => {
    const features = map.queryRenderedFeatures(event.point, {
      layers: ["flight-points"]
    });
    if (features.length === 0) {
      onDeselectFlight();
    }
  });

  map.on("mousemove", "flight-points", (event) => {
    const feature = event.features?.[0];
    const id = feature?.properties?.id;

    if (typeof id !== "string") {
      return;
    }

    hoveredFlightIdRef.current = id;
    onHoverFlight({
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
    onHoverFlight(null);
  });
}

type MapCanvasProps = {
  homeBase: HomeBaseCenter;
  homeBaseFeatures: ReturnType<typeof buildHomeBaseFeatures>;
  openingBounds: LngLatBoundsLike;
  selectedFlightId: string | null;
  activeSelectedFlightDetails: SelectedFlightDetailsResponse["details"] | null;
  // Why: the orchestrator owns these refs (high-frequency mutable state read by
  // the RAF loop). MapCanvas reads via .current. We pass the ref objects rather
  // than snapshot values so the RAF loop sees the latest data without
  // re-establishing itself every poll.
  mapRef: React.MutableRefObject<MapLibreMap | null>;
  displayFlightsRef: React.MutableRefObject<Flight[]>;
  flightAnimationStatesRef: React.MutableRefObject<Map<string, FlightAnimationState>>;
  snapshotHistoryRef: React.MutableRefObject<FlightSnapshot[]>;
  flightBreadcrumbsRef: React.MutableRefObject<Map<string, FlightBreadcrumbBuffer>>;
  selectedFlightIdRef: React.MutableRefObject<string | null>;
  hoveredFlightIdRef: React.MutableRefObject<string | null>;
  hoveredStripFlightIdRef: React.MutableRefObject<string | null>;
  hoveredStripStartedAtRef: React.MutableRefObject<number | null>;
  activeSelectedFlightDetailsRef: React.MutableRefObject<SelectedFlightDetailsResponse["details"]>;
  selectedFlightDetailsFlightIdRef: React.MutableRefObject<string | null>;
  selectedMetadataByIdRef: React.MutableRefObject<
    Record<string, IdentityScopedValue<SelectedFlightDetailsResponse["details"]>>
  >;
  selectedRenderedPositionRef: React.MutableRefObject<{ latitude: number; longitude: number } | null>;
  onSelectFlight: (id: string) => void;
  onDeselectFlight: () => void;
  onHoverFlight: (state: HoveredFlightState | null) => void;
  mapLabelVisibility: MapLabelVisibility;
};

export function MapCanvas({
  homeBase,
  homeBaseFeatures,
  openingBounds,
  selectedFlightId,
  activeSelectedFlightDetails,
  mapRef,
  displayFlightsRef,
  flightAnimationStatesRef,
  snapshotHistoryRef,
  flightBreadcrumbsRef,
  selectedFlightIdRef,
  hoveredFlightIdRef,
  hoveredStripFlightIdRef,
  hoveredStripStartedAtRef,
  activeSelectedFlightDetailsRef,
  selectedFlightDetailsFlightIdRef,
  selectedMetadataByIdRef,
  selectedRenderedPositionRef,
  onSelectFlight,
  onDeselectFlight,
  onHoverFlight,
  mapLabelVisibility
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const { resolvedTheme } = useTheme();
  // Why: next-themes returns undefined on first render (theme isn't resolved
  // until after hydration). If we just default to "light" here, dark-mode
  // users get a visible double-style-load on every cold start: map paints
  // Positron, hydration finishes, mapMode flips to "dark", setStyle wipes
  // the sources we just added, then Dark Matter paints. Several seconds
  // wasted before animation looks smooth. Read the system preference +
  // any saved next-themes choice synchronously from the document so the
  // very first render already knows the right mode.
  const mapMode: MapMode =
    resolvedTheme === "dark"
      ? "dark"
      : resolvedTheme === "light"
        ? "light"
        : detectInitialMapMode();
  // Mirror to a ref so the init useEffect (which only runs once) can read
  // the latest mode without re-triggering itself on every theme change.
  const mapModeRef = useRef<MapMode>(mapMode);
  mapModeRef.current = mapMode;
  // Why: tracks the basemap mode actually applied to the map. The map is
  // created with BASEMAP_URLS[initial mode], so the first applied value
  // matches the initial render. Without this guard, the theme-change
  // useEffect calls setStyle() on its first run (when mapReady flips to
  // true), wiping the just-added flight/track sources for no reason.
  const appliedMapModeRef = useRef<MapMode>(mapMode);
  // Why: ref-mirror so the map-creation effect (which doesn't re-run on
  // visibility changes) can read the latest visibility values inside
  // its load + style.load callbacks. The dedicated effect below
  // handles eager re-application when the prop actually changes.
  const mapLabelVisibilityRef = useRef<MapLabelVisibility>(mapLabelVisibility);
  mapLabelVisibilityRef.current = mapLabelVisibility;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_URLS[mapModeRef.current],
      bounds: openingBounds,
      fitBoundsOptions: {
        padding: 40
      },
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.on("load", () => {
      setupCustomLayers({
        map,
        palette: PALETTES[mapModeRef.current],
        homeBaseFeatures,
        hoveredFlightIdRef,
        onSelectFlight,
        onDeselectFlight,
        onHoverFlight
      });
      // Why: apply current label visibility on initial load. Without
      // this the user toggling labels off, then refreshing, would see
      // them all flash on briefly before the prop-driven effect
      // below catches up.
      applyMapLabelVisibility(map, mapLabelVisibilityRef.current);
      setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
    // Why: matches the original FlightMap dep array. The early-return on
    // `mapRef.current` prevents re-runs from rebuilding the map; the
    // home-base-source update effect below keeps geometry in sync. Refs
    // (mapRef, hoveredFlightIdRef) and stable React setters (onSelect,
    // onHover) are intentionally excluded — the closure captures their
    // current values, and they don't change after first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeBaseFeatures, openingBounds]);

  // Why: when the user toggles the theme, swap the basemap and re-add our
  // custom sources/layers. setStyle() preserves the camera but wipes any
  // sources/layers we added, so we redo them with the new palette inside
  // the next style.load tick. The next RAF frame repopulates the flights
  // and selected-track sources from refs.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    // Why: skip the no-op call on first run after mapReady flips. The map
    // was already created with BASEMAP_URLS[initial mode], so calling
    // setStyle with the same URL would needlessly wipe the flights /
    // selected-track sources we just added in the load handler.
    if (appliedMapModeRef.current === mapMode) return;
    appliedMapModeRef.current = mapMode;
    const map = mapRef.current;
    map.setStyle(BASEMAP_URLS[mapMode]);
    const handleStyleLoad = () => {
      setupCustomLayers({
        map,
        palette: PALETTES[mapMode],
        homeBaseFeatures,
        hoveredFlightIdRef,
        onSelectFlight,
        onDeselectFlight,
        onHoverFlight
      });
      // Why: setStyle wipes per-layer visibility along with our custom
      // sources/layers. Re-apply user toggles after the new basemap
      // style finishes loading so dark-mode users keep their hidden
      // labels hidden across theme switches.
      applyMapLabelVisibility(map, mapLabelVisibilityRef.current);
    };
    map.once("style.load", handleStyleLoad);
    return () => {
      map.off("style.load", handleStyleLoad);
    };
    // Why: refs and stable React setters are intentionally excluded — the
    // setupCustomLayers closure captures their current values. mapRef is a
    // stable ref object owned by the orchestrator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapMode, mapReady]);

  // Why: re-apply label visibility whenever the user toggles a category.
  // The setLayoutProperty calls inside applyMapLabelVisibility are
  // no-ops when the value is unchanged, so this is cheap to run on
  // every prop change.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    applyMapLabelVisibility(mapRef.current, mapLabelVisibility);
  }, [mapLabelVisibility, mapReady]);

  useEffect(() => {
    const homeBaseSource = mapRef.current?.getSource("home-base") as GeoJSONSource | undefined;

    homeBaseSource?.setData(homeBaseFeatures);
    mapRef.current?.fitBounds(openingBounds, {
      padding: 40,
      duration: 700
    });
    // mapRef is intentionally excluded — it's a stable ref object owned by
    // the orchestrator and never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeBaseFeatures, mapReady, openingBounds]);

  useEffect(() => {
    const source = mapRef.current?.getSource("flights") as GeoJSONSource | undefined;

    if (!source) {
      return;
    }

    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    // [trail-debug] Throttle for the optional in-frame diagnostic. Toggle with
    // `window.__TRAIL_DEBUG = true` in DevTools to surface the icon vs trail-tip
    // relationship for the selected flight at ~1 Hz.
    let trailDebugLastLogAtMs = 0;

    function renderFrame(frameTime: number) {
      // Why: re-fetch the GeoJSON sources every frame instead of capturing
      // them in this closure. map.setStyle() (theme switch) wipes and
      // recreates the sources — a captured reference becomes a dead handle
      // whose setData() silently no-ops, freezing the flight dots
      // mid-animation. The lookup is a Map.get; cost is negligible.
      const flightSource = mapRef.current?.getSource("flights") as
        | GeoJSONSource
        | undefined;
      const trackSource = mapRef.current?.getSource("selected-track") as
        | GeoJSONSource
        | undefined;
      if (!flightSource) {
        // Sources not (yet) re-added after a setStyle; skip this frame.
        animationFrameRef.current = requestAnimationFrame(renderFrame);
        return;
      }
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

        let aheadMiles: number | null = null;
        if (trailTip) {
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
    // Why: matches the original FlightMap dep array. The closure captures
    // `homeBase` (re-runs the effect when home-base moves so the per-frame
    // distance ring math uses the new center) and `mapReady` (waits for
    // sources to exist). All other refs are stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    homeBase,
    mapReady
  ]);

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
    // Why: matches the original FlightMap dep array. Refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSelectedFlightDetails, mapReady, selectedFlightId]);

  return (
    <main aria-label="Live air-traffic map" className="fixed inset-0 z-0">
      <div className="h-full w-full" ref={containerRef} />
    </main>
  );
}
