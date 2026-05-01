"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap } from "maplibre-gl";
import { useTheme } from "next-themes";
import { distanceBetweenPointsMiles } from "@/lib/geo";
import { isHelicopterType } from "@/lib/flights/aircraftTypes";
import type { Flight } from "@/lib/flights/types";
import { refreshVfrLatchIfApplicable } from "@/lib/flights/display";
import {
  clipBreadcrumbCoordinatesToAnimation,
  computeSpringHeading,
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
  SelectedFlightDetailsResponse,
  ViewportBounds
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
//   water:    watername_ocean / _sea / _lake / _lake_line
//             waterway_label  (rivers, streams)
//             Grouped under POI because water names are "named
//             features" rather than place/road labels — same mental
//             bucket as stadiums/parks for users wanting to declutter
//             the map. ("Pacific Ocean" hovering over the LA basin
//             is not useful at our zooms; same for "Lake Hollywood".)
//
// Substring matching is intentional — survives small style version
// changes and accommodates the "roadname" / "road_label" / similar
// patterns other Carto styles use.
//
// Underscore suffixes (`place_`, `poi_`) are critical: bare `poi`
// would match our own `flight-points` symbol layer (the substring
// "poi" appears in "points"), and a careless `place` substring could
// match unrelated layer IDs like `placeholder` or `marketplace`.
// Carto styles consistently use `poi_<thing>` and `place_<thing>`,
// so the underscore is a safe word-boundary stand-in. Water layers
// use `watername_*` and `waterway_label` — narrow enough that the
// matchers below avoid false positives without an underscore guard.
function getLabelLayerCategory(
  layerId: string,
  layerType: string
): keyof MapLabelVisibility | null {
  if (layerType !== "symbol") return null;
  const id = layerId.toLowerCase();
  if (id.includes("place_")) return "placeLabels";
  if (id.includes("roadname")) return "roadLabels";
  if (id.includes("road") && id.includes("label")) return "roadLabels";
  if (id.includes("housenum")) return "roadLabels";
  if (id.includes("poi_")) return "poiLabels";
  if (id.includes("watername")) return "poiLabels";
  if (id.includes("waterway") && id.includes("label")) return "poiLabels";
  if (id.includes("airport") && id.includes("label")) return "poiLabels";
  if (id.includes("transit") && id.includes("label")) return "poiLabels";
  return null;
}

// Why: registered ID for the home-base House icon image. Loaded
// asynchronously into maplibre's image registry on map load and on
// theme change (the icon is re-baked per palette so colors match the
// active theme; SDF tinting would need a single-channel SDF source
// asset which lucide icons aren't shipped as, so we just bake the
// stroke + fill into the SVG and re-add on theme change).
const HOME_ICON_IMAGE_ID = "home-base-icon";

// Why: layer IDs of our custom home-base / focus-indicator layers,
// added in setupCustomLayers. Toggled together by the homeBaseIndicator
// switch — both the center point and the concentric radius rings hide
// or show as a unit (you'd never want one without the other).
// Why: split into two groups so the icon and the rings can be toggled
// independently from the popover. The order they're added in
// setupCustomLayers is also independent — the rings layer renders
// underneath the icon either way.
const HOME_BASE_ICON_LAYER_IDS = ["home-base-point"] as const;
const HOME_BASE_RING_LAYER_IDS = ["home-rings"] as const;

// Why: the line layers for the trails behind the focused flight —
// `selected-track-line` follows the user-selected flight (with full
// AeroAPI provider track + breadcrumbs), `nearest-track-line` follows
// the auto-tracked nearest flight (breadcrumbs only — the nearest
// changes too often to burn AeroAPI quota on it). Toggling
// `flightTrail` off hides both, since they share the same mental
// model: "show the trail behind whichever flight is the focus."
const FLIGHT_TRAIL_LAYER_IDS = [
  "selected-track-line",
  "nearest-track-line"
] as const;

// Why: classify a basemap layer as a road / highway / street line.
// We dim these in dark mode based on the user-controlled
// `roadDimDark` slider. Substring match is intentional: Carto Dark
// Matter uses prefixes like `road_`, `highway_`, `tunnel_`, `bridge_`
// (where tunnel/bridge layers are road geometry rendered with
// bridge/tunnel-specific styling).
function isBasemapRoadLine(layerId: string, layerType: string): boolean {
  if (layerType !== "line") return false;
  const id = layerId.toLowerCase();
  return (
    id.includes("road") ||
    id.includes("highway") ||
    id.includes("street") ||
    id.includes("motorway") ||
    id.includes("tunnel") ||
    id.includes("bridge")
  );
}

// Why: legacy zoom-stops format that several Carto layers ship with
// for line-opacity, e.g. `{stops: [[5, 0.5], [7, 1]]}`. Predates the
// modern expression syntax (`["interpolate", ["linear"], ["zoom"],
// ...]`) but maplibre still honors it. We have to handle this form
// explicitly because wrapping a stops object in an `["*", ...]`
// expression produces an INVALID expression (maplibre silently drops
// the paint update, leaving the slider's lower bound unable to dim
// those layers). Detecting and deep-cloning with each stop value
// multiplied is the only way to apply the dim factor while preserving
// the per-zoom ramp the basemap intended.
type LegacyStops = { stops: Array<[number, number]> };

function isLegacyStops(value: unknown): value is LegacyStops {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "stops" in value &&
    Array.isArray((value as { stops: unknown }).stops)
  );
}

// Why: per-layer cached "original" line-opacity (whatever the basemap
// shipped with) so the dim factor can be re-applied at runtime
// without compounding. Without this, calling `dimBasemapRoadLines`
// twice with factors 0.5 then 0.3 would produce 0.5 × 0.3 = 0.15
// instead of the expected 0.3.
//
// Sentinel `undefined` (Map has no entry) means "not yet cached";
// sentinel `null` (Map entry exists, value null) means "the basemap
// had no explicit line-opacity (default 1)" — we have to distinguish
// these so we don't re-fetch on every call.
type CachedOpacity =
  | number
  | LegacyStops
  | maplibregl.ExpressionSpecification
  | null;
type RoadOpacityCache = Map<string, CachedOpacity>;

// Why: dim all road-line layers to `original × factor`. First call
// after a setStyle populates the cache from the freshly-loaded basemap
// values; subsequent calls (slider drag, theme toggle while staying
// in dark) re-apply against the cached originals — no compounding.
//
// Three branches handle the three forms `getPaintProperty` can return
// for line-opacity: plain number, legacy stops object, or modern
// expression array. See LegacyStops comment above for why stops need
// special handling (can't be wrapped in `["*"]`).
//
// Caller is responsible for clearing the cache after `setStyle` so a
// new style's layer set + opacities replace the previous cache.
function dimBasemapRoadLines(
  map: MapLibreMap,
  factor: number,
  cache: RoadOpacityCache
) {
  const style = map.getStyle();
  if (!style.layers) return;
  for (const layer of style.layers) {
    if (!isBasemapRoadLine(layer.id, layer.type)) continue;

    let original = cache.get(layer.id);
    if (original === undefined) {
      const fromStyle = map.getPaintProperty(layer.id, "line-opacity") as
        | CachedOpacity
        | undefined;
      original = fromStyle ?? null;
      cache.set(layer.id, original);
    }

    let next: unknown;
    if (original === null) {
      // Basemap default (line-opacity = 1) → dimmed = factor directly.
      next = factor;
    } else if (typeof original === "number") {
      next = original * factor;
    } else if (isLegacyStops(original)) {
      // Deep-clone the stops with each value scaled by factor — keeps
      // the per-zoom ramp shape, just scaled down.
      next = {
        stops: original.stops.map(
          ([zoom, value]) => [zoom, value * factor] as [number, number]
        )
      };
    } else {
      // Modern expression — wrap in multiplication so each zoom step
      // gets the factor applied.
      next = ["*", original, factor];
    }
    map.setPaintProperty(
      layer.id,
      "line-opacity",
      next as maplibregl.ExpressionSpecification
    );
  }
}

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
      layerIds: HOME_BASE_ICON_LAYER_IDS,
      visible: visibility.homeBaseIcon
    },
    {
      layerIds: HOME_BASE_RING_LAYER_IDS,
      visible: visibility.homeBaseRings
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

// Why: build an SVG data URL for the home-base House icon, baked
// with theme-appropriate stroke + fill colors. We re-bake on theme
// change rather than using SDF tinting because lucide icons aren't
// shipped as single-channel SDF assets, and converting them on the
// fly is more code than just regenerating the bitmap. Path data is
// the same shape lucide-react uses for `<House />` (kept identical
// to the lucide design language so it harmonizes with other icons
// in the app).
function buildHomeIconDataUrl(strokeColor: string, fillColor: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Why: load (or reload, on theme change) the home icon image into
// maplibre's image registry. Async because Image() decoding is
// async — the symbol layer that references this image renders
// nothing until addImage lands, then maplibre auto-redraws. On
// theme change, we removeImage first so the new colors take effect.
function loadHomeIconImage(map: MapLibreMap, palette: MapPalette) {
  const dataUrl = buildHomeIconDataUrl(
    palette.homeBaseStroke,
    palette.homeBaseFill
  );
  const img = new Image();
  img.onload = () => {
    if (map.hasImage(HOME_ICON_IMAGE_ID)) {
      map.removeImage(HOME_ICON_IMAGE_ID);
    }
    map.addImage(HOME_ICON_IMAGE_ID, img, { pixelRatio: 2 });
  };
  img.src = dataUrl;
}

// Why: SVG strokes are CENTERED on the path (no stroke-alignment
// support across browsers), so a naive `<shape stroke="..."/>`
// would put half the stroke INSIDE the shape, eating into the fill
// color. The original MapLibre circle layer used outside-aligned
// strokes (radius defines fill, stroke is added outside), so to
// match it we emulate "outside stroke" with two stacked shapes:
//   1. Outer shape painted in the stroke color, sized to extend
//      `strokeWidth` past the fill edge.
//   2. Inner shape (same as the original fill geometry) painted in
//      the fill color, drawn on top.
// The inner shape covers the body of the outer shape, leaving only
// a `strokeWidth`-thick ring of stroke color visible — equivalent
// to an outside-aligned stroke.
//
// viewBox is 28 (not 24) to give the outermost shape room — the
// largest variant (dotFar with strokeWidth 3.8) extends to r=13.8
// from center, needing diameter 27.6.
//
// Pointer is the Navigation2-family polygon (paper-plane silhouette
// pointing up by default) — vertices recentered to (14,14) inside
// the 28-box so the fill spans x:4–24, y:4–24 (= 20 source px,
// matching the dot's fill diameter so a single icon-size produces
// matching on-screen sizes for both shapes). For the outer-shape
// trick on a polygon we use `stroke="strokeColor" stroke-width="2W"
// fill="strokeColor"`: the centered stroke extends W outside, the
// fill makes the inner half of the stroke continuous with the body,
// and the inner polygon on top covers everything except the outer
// ring.
function buildFlightPointerDataUrl(
  fillColor: string,
  strokeColor: string,
  strokeWidth: number
) {
  const points = "14 4 24 24 14 20 4 24";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><polygon points="${points}" fill="${strokeColor}" stroke="${strokeColor}" stroke-width="${strokeWidth * 2}" stroke-linejoin="round"/><polygon points="${points}" fill="${fillColor}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Why: dot fallback for stationary aircraft (groundspeed below the
// reliable-heading threshold) and helicopters (whose nose direction
// often disagrees with track). Two stacked circles emulate outside-
// aligned stroke (see pointer comment for the why): outer circle
// in stroke color at r=10+strokeWidth, inner circle in fill color
// at r=10. The visible result is a fill diameter of 20 source px
// (matching the pointer) wrapped in a strokeWidth-thick ring.
function buildFlightDotDataUrl(
  fillColor: string,
  strokeColor: string,
  strokeWidth: number
) {
  const innerR = 10;
  const outerR = innerR + strokeWidth;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><circle cx="14" cy="14" r="${outerR}" fill="${strokeColor}"/><circle cx="14" cy="14" r="${innerR}" fill="${fillColor}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Why: orange used for the user-selected and auto-nearest markers.
// Hardcoded (not on the palette) because it's the universal "this
// is the focus flight" accent and stays the same across themes —
// only the stroke color shifts per theme via palette.selectedMarker-
// Stroke.
const FOCUS_FILL_COLOR = "#f07f4f";

// Why: image variants — three distance tiers × two shapes (pointer /
// dot fallback) for the regular flight-points layer, plus an
// orange-fill variant of each shape for the selected + nearest
// focus markers. Each variant bakes its color so we don't need SDF
// tinting (which would require generating distance-field bitmaps at
// runtime). Image IDs are referenced by case expressions on the
// flight-points / selected-flight-marker / nearest-flight-marker
// symbol layers.
const FLIGHT_ICON_IMAGE_IDS = {
  pointerClose: "flight-pointer-close",
  pointerMid: "flight-pointer-mid",
  pointerFar: "flight-pointer-far",
  dotClose: "flight-dot-close",
  dotMid: "flight-dot-mid",
  dotFar: "flight-dot-far",
  pointerFocus: "flight-pointer-focus",
  dotFocus: "flight-dot-focus"
} as const;

// Why: per-variant source stroke widths so that on-screen stroke stays
// consistent across tiers despite per-tier icon-size scaling. Each
// stroke = target_on_screen_px / icon_size. Tier targets = 1.8
// (matches original circle-stroke-width); focus targets = 3 (matches
// original selected-flight-marker circle-stroke-width).
//
// Source `strokeWidth` here represents the OUTSIDE-stroke ring width
// in source units (the icon builders use the dual-shape trick to
// emulate outside alignment, since SVG strokes are centered-only).
// The outer shape extends `strokeWidth` past the fill edge, giving
// an on-screen stroke of `strokeWidth × icon_size`.
//
// Pointer is bumped 15% larger than dot at every tier (see icon-size
// case in flight-points layer comments), so pointer source stroke
// is correspondingly smaller than dot source stroke at the same
// tier — both end up at 1.8 / 3 px on screen.
//
// Math (rounded to 1 decimal):
//   dotClose  : 1.8 / 0.80 = 2.3
//   dotMid    : 1.8 / 0.65 = 2.8
//   dotFar    : 1.8 / 0.475 = 3.8
//   dotFocus  : 3   / 0.95 = 3.2
//   pointerClose  : 1.8 / 0.92 = 2.0
//   pointerMid    : 1.8 / 0.75 = 2.4
//   pointerFar    : 1.8 / 0.55 = 3.3
//   pointerFocus  : 3   / 1.09 = 2.8
function loadFlightIconImages(map: MapLibreMap, palette: MapPalette) {
  const variants: Array<{
    id: string;
    builder: (fill: string, stroke: string, strokeWidth: number) => string;
    fill: string;
    stroke: string;
    strokeWidth: number;
  }> = [
    { id: FLIGHT_ICON_IMAGE_IDS.pointerClose, builder: buildFlightPointerDataUrl, fill: palette.flightCloseColor, stroke: palette.flightStroke, strokeWidth: 2.0 },
    { id: FLIGHT_ICON_IMAGE_IDS.pointerMid,   builder: buildFlightPointerDataUrl, fill: palette.flightMidColor,   stroke: palette.flightStroke, strokeWidth: 2.4 },
    { id: FLIGHT_ICON_IMAGE_IDS.pointerFar,   builder: buildFlightPointerDataUrl, fill: palette.flightFarColor,   stroke: palette.flightStroke, strokeWidth: 3.3 },
    { id: FLIGHT_ICON_IMAGE_IDS.dotClose,     builder: buildFlightDotDataUrl,     fill: palette.flightCloseColor, stroke: palette.flightStroke, strokeWidth: 2.3 },
    { id: FLIGHT_ICON_IMAGE_IDS.dotMid,       builder: buildFlightDotDataUrl,     fill: palette.flightMidColor,   stroke: palette.flightStroke, strokeWidth: 2.8 },
    { id: FLIGHT_ICON_IMAGE_IDS.dotFar,       builder: buildFlightDotDataUrl,     fill: palette.flightFarColor,   stroke: palette.flightStroke, strokeWidth: 3.8 },
    { id: FLIGHT_ICON_IMAGE_IDS.pointerFocus, builder: buildFlightPointerDataUrl, fill: FOCUS_FILL_COLOR, stroke: palette.selectedMarkerStroke, strokeWidth: 2.8 },
    { id: FLIGHT_ICON_IMAGE_IDS.dotFocus,     builder: buildFlightDotDataUrl,     fill: FOCUS_FILL_COLOR, stroke: palette.selectedMarkerStroke, strokeWidth: 3.2 }
  ];
  for (const variant of variants) {
    const dataUrl = variant.builder(variant.fill, variant.stroke, variant.strokeWidth);
    const img = new Image();
    img.onload = () => {
      if (map.hasImage(variant.id)) {
        map.removeImage(variant.id);
      }
      // Why: pixelRatio 1 (vs 2 on the home icon) so the 28×28
      // source SVG renders at 28 CSS px before icon-size scaling.
      // pixelRatio 2 would tell maplibre this image is retina —
      // halving the CSS display size, which combined with our
      // per-tier icon-size produced sub-10 px icons. The flight
      // icons are vector source and rasterized at render time, so
      // the "retina sharpness" benefit is moot here.
      map.addImage(variant.id, img, { pixelRatio: 1 });
    };
    img.src = dataUrl;
  }
}

// Why: speed threshold below which heading is too noisy to trust
// for icon rotation. Hovering helicopters, parked-but-broadcasting
// GA, slow holding patterns can all produce wildly varying heading
// values that would make a directional pointer spin nonsensically.
// Below this threshold we render the dot fallback instead.
const MIN_HEADING_RELIABLE_KNOTS = 5;

// Why: avoid a cold-start double-style-load for dark-mode users. The
// Why: convert maplibre's LngLatBounds (a class with getter methods)
// to the plain ViewportBounds object the rest of the app uses for
// filtering. Centralized here so callers don't all repeat the
// getNorth/getSouth/getEast/getWest extraction.
function emitViewportBounds(
  map: MapLibreMap,
  callback: ((bounds: ViewportBounds) => void) | undefined
) {
  if (!callback) return;
  const bounds = map.getBounds();
  callback({
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest()
  });
}

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
  // Why: tail end of the trail's progress-based gradient — the older
  // (oldest data) endpoint of the line. Sits at line-progress 0.
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
    trackLineColor: "rgba(15, 76, 129, 0.35)",
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
    trackLineColor: "rgba(125, 174, 230, 0.4)",
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

  // Why: parallel source for the nearest flight's trail. Uses only
  // client-side breadcrumbs (we don't fetch /api/flights/selected for
  // the nearest — that would burn an AeroAPI call every time the
  // nearest plane changes, which can happen frequently).
  map.addSource("nearest-track", {
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

  // Why: kick off all async icon loads before the symbol layers
  // so images land in the registry as quickly as possible. The
  // referencing layers render nothing until addImage completes;
  // maplibre fires a redraw automatically when each image is
  // registered.
  loadHomeIconImage(map, palette);
  loadFlightIconImages(map, palette);

  map.addLayer({
    id: "home-base-point",
    type: "symbol",
    source: "home-base",
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "icon-image": HOME_ICON_IMAGE_ID,
      // Why: source SVG renders at 24 px; icon-size 1.4 gives a ~34
      // px on-screen glyph — small enough to stay anchored at the
      // exact home-base coordinate, big enough to read at typical
      // zooms. Allow + ignore overlap so the home icon is never
      // culled by basemap labels or other custom symbols at busy
      // zooms.
      "icon-size": 1.4,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    }
  });

  // Why: fixed-wing aircraft render as pointers rotated by heading;
  // helicopters keep the circle dot (their nose direction often
  // disagrees with travel direction — sidling, hovering, reversing —
  // so a directional pointer would mislead). Stationary aircraft
  // (groundspeed below MIN_HEADING_RELIABLE_KNOTS or null heading)
  // also fall back to dot since heading is noise at low speeds.
  // Three distance tiers control size + color + opacity, each
  // tier's image variant pre-baked with its color (no SDF tinting
  // needed). icon-rotation-alignment "map" makes the pointer rotate
  // with the map's bearing — heading 0° always points to true north
  // regardless of map orientation. icon-allow-overlap +
  // icon-ignore-placement so flight icons are never culled by
  // basemap labels at busy zooms.
  map.addLayer({
    id: "flight-points",
    type: "symbol",
    source: "flights",
    layout: {
      "icon-image": [
        "case",
        // Pointer ONLY when fixed-wing AND moving fast enough for
        // heading to be meaningful. Everything else gets a dot.
        ["all", ["get", "isMoving"], ["!", ["get", "isHelicopter"]]],
        [
          "case",
          ["<=", ["get", "distanceMiles"], 3],
          FLIGHT_ICON_IMAGE_IDS.pointerClose,
          ["<=", ["get", "distanceMiles"], 8],
          FLIGHT_ICON_IMAGE_IDS.pointerMid,
          FLIGHT_ICON_IMAGE_IDS.pointerFar
        ],
        [
          "case",
          ["<=", ["get", "distanceMiles"], 3],
          FLIGHT_ICON_IMAGE_IDS.dotClose,
          ["<=", ["get", "distanceMiles"], 8],
          FLIGHT_ICON_IMAGE_IDS.dotMid,
          FLIGHT_ICON_IMAGE_IDS.dotFar
        ]
      ],
      // Why: dots match the original circle layer's fill diameters
      // exactly (radii 8 / 6.5 / 4.75 → 16 / 13 / 9.5 px). Source
      // fill spans 20 px (circle r=10), so icon-size = target / 20:
      // 0.80 / 0.65 / 0.475. Strokes sit OUTSIDE the fill (emulated
      // via the dual-shape trick in the icon builders — see comment
      // there), so the fill diameter is the visible colored disc, not
      // partially covered by an inset stroke.
      //
      // Pointers are bumped 15% above dots at every tier because a
      // solid triangle has ~50% the geometric area of a circle in the
      // same bounding box, so reads with noticeably less visual
      // weight at equal nominal size. 15% (1.15×) is a "slightly
      // larger" compromise between minimal bump and full area parity
      // (~1.41×). Pointer values: 0.92 / 0.75 / 0.55.
      //
      // The outer ["case"] branches on shape (matching the icon-image
      // expression above) so pointer vs dot get their own per-tier
      // sizes.
      "icon-size": [
        "case",
        ["all", ["get", "isMoving"], ["!", ["get", "isHelicopter"]]],
        [
          "case",
          ["<=", ["get", "distanceMiles"], 3],
          0.92,
          ["<=", ["get", "distanceMiles"], 8],
          0.75,
          0.55
        ],
        [
          "case",
          ["<=", ["get", "distanceMiles"], 3],
          0.80,
          ["<=", ["get", "distanceMiles"], 8],
          0.65,
          0.475
        ]
      ],
      "icon-rotate": ["get", "headingDegrees"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    },
    paint: {
      "icon-opacity": [
        "case",
        ["<=", ["get", "distanceMiles"], 3],
        0.95,
        ["<=", ["get", "distanceMiles"], 8],
        0.82,
        0.62
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

  // Why: nearest + selected markers use the same pointer-vs-dot
  // shape rule as flight-points (orange-filled), so a selected /
  // nearest fixed-wing flight reads as an orange pointer rotated
  // by heading, and a selected / nearest helicopter or stationary
  // aircraft reads as an orange dot. Without this, focusing a
  // moving plane would visually flatten the heading info that the
  // base flight-points layer is communicating.
  //
  // Both layers share the same icon-image case expression and use
  // icon-rotate driven by headingDegrees (the property is set per
  // feature in the RAF loop). icon-rotation-alignment "map" so the
  // rotation tracks the map's bearing.
  //
  // Selected is drawn AFTER nearest so if both ever resolve true
  // for the same feature (defensive — they're mutually exclusive
  // by construction in FlightMap), the selected variant wins z-order.
  // Halo (selected-flight-halo) stays a circle because it's a
  // diffuse glow, not a directional indicator — it sits underneath
  // both pointer and dot variants without conflict.
  const focusIconImage: maplibregl.ExpressionSpecification = [
    "case",
    ["all", ["get", "isMoving"], ["!", ["get", "isHelicopter"]]],
    FLIGHT_ICON_IMAGE_IDS.pointerFocus,
    FLIGHT_ICON_IMAGE_IDS.dotFocus
  ];
  // Why: focus markers match the previous selected-flight-marker
  // circle (radius 9.5 → fill diameter 19). Source fill = 20, so
  // dot icon-size = 19/20 = 0.95. Pointer is bumped 15% (same
  // visual-weight rationale as the tiered flight-points layer):
  // 0.95 × 1.15 = 1.09. No tier scaling — focus is "the focus,"
  // not "the focus from far away."
  const focusIconSize: maplibregl.ExpressionSpecification = [
    "case",
    ["all", ["get", "isMoving"], ["!", ["get", "isHelicopter"]]],
    1.09,
    0.95
  ];

  map.addLayer({
    id: "nearest-flight-marker",
    type: "symbol",
    source: "flights",
    filter: ["==", ["get", "isNearest"], true],
    layout: {
      "icon-image": focusIconImage,
      "icon-size": focusIconSize,
      "icon-rotate": ["get", "headingDegrees"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    }
  });

  map.addLayer({
    id: "selected-flight-marker",
    type: "symbol",
    source: "flights",
    filter: ["==", ["get", "isSelected"], true],
    layout: {
      "icon-image": focusIconImage,
      "icon-size": focusIconSize,
      "icon-rotate": ["get", "headingDegrees"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    }
  });

  map.addLayer(
    {
      id: "selected-track-line",
      type: "line",
      source: "selected-track",
      // Why: round caps + joins so the trail's endpoints terminate
      // softly instead of with a visible flat edge.
      layout: {
        "line-cap": "round",
        "line-join": "round"
      },
      paint: {
        // Why: solid blue along the whole trail. The orange marker
        // dot at the head is a strong-enough "this is now" cue on
        // its own — a directional hue gradient added more visual
        // noise than wayfinding signal.
        "line-color": palette.trackLineColor,
        "line-width": 2.5
      }
    },
    "selected-flight-marker"
  );

  // Why: nearest flight's trail. Same color + width as the selected
  // trail — visual consistency across "this is the focused plane"
  // treatments. The lack-of-halo on the marker is the only visual
  // cue distinguishing nearest from selected; making the trail subtly
  // different too would muddy that signal. Inserted before
  // `nearest-flight-marker` so the marker draws on top of the trail
  // (matches selected-track-line / selected-flight-marker ordering).
  map.addLayer(
    {
      id: "nearest-track-line",
      type: "line",
      source: "nearest-track",
      layout: {
        "line-cap": "round",
        "line-join": "round"
      },
      paint: {
        "line-color": palette.trackLineColor,
        "line-width": 2.5
      }
    },
    "nearest-flight-marker"
  );

  // Why: labels are reserved for the two flights the user is most
  // likely tracking — the user-selected flight (large + accent
  // color) and the auto-tracked nearest (slightly smaller + muted).
  // Everyone else relies on hover or the sidebar list for
  // identification. Avoids the "wall of labels" look at busy zooms
  // and lets the two important callsigns actually breathe.
  map.addLayer({
    id: "flight-labels",
    type: "symbol",
    source: "flights",
    layout: {
      "text-field": ["case", ["get", "showLabel"], ["get", "label"], ""],
      "text-size": ["case", ["get", "isSelected"], 12, 11],
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
  // Why: ID of the auto-tracked nearest flight (or null when there's
  // an explicit selection). Drives the `isNearest` feature property
  // so the `nearest-flight-marker` layer paints the orange dot
  // without the halo — visual signal that the system is highlighting
  // this plane (sidebar's "Nearest now" / ambient widget) without
  // claiming it as the user's selection. Track + metadata for this
  // flight comes from `selectedMetadataByIdRef` (same storage as the
  // selected flight uses), populated by the client-side prefetch
  // effect in FlightMap that fires /api/flights/selected for
  // predicted-nearest candidates.
  nearestFlightIdRef: React.MutableRefObject<string | null>;
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
  // Why: fired on map load + every `moveend` (pan / zoom settled) so
  // the parent can compute "flights actually in the visible viewport"
  // for the header count. We use moveend (not move) to avoid burning
  // re-renders on every drag frame; the count only needs to be
  // accurate after the gesture settles.
  onViewportChange?: (bounds: ViewportBounds) => void;
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
  nearestFlightIdRef,
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
  onViewportChange,
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
  // Why: same ref-mirror pattern for the viewport callback — the
  // map-creation effect captures it at mount, but consumers can
  // hot-swap their handler without us re-creating the map.
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  // Why: per-map cache of the basemap's original road-line opacities,
  // so the dim-factor effect can multiply against the original on
  // every slider change without compounding. Cleared whenever
  // setStyle wipes the basemap (theme toggle) — the new style ships
  // its own opacities that need fresh caching.
  const roadOpacityCacheRef = useRef<RoadOpacityCache>(new Map());

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
      // Why: dim basemap road lines in dark mode (Dark Matter's
      // default road styling competes with our flight icons). Light
      // mode (Positron) doesn't need this. Cache starts empty on
      // first call — dimBasemapRoadLines populates it from the
      // freshly-loaded style.
      if (mapModeRef.current === "dark") {
        dimBasemapRoadLines(
          map,
          mapLabelVisibilityRef.current.roadDimDark,
          roadOpacityCacheRef.current
        );
      }
      // Why: emit the initial viewport bounds so the parent can show
      // a viewport-correct count right away (the map mounts at the
      // openingBounds, so we know the bounds are valid here). Without
      // this the count would lag until the user first pans / zooms.
      emitViewportBounds(map, onViewportChangeRef.current);
      setMapReady(true);
    });

    // Why: emit on every settled gesture (drag end, zoom end, fit).
    // `moveend` fires once per gesture rather than continuously like
    // `move`, so the header count updates exactly when the user
    // expects ("after I let go") without thrashing React re-renders
    // mid-pan.
    const handleMoveEnd = () => emitViewportBounds(map, onViewportChangeRef.current);
    map.on("moveend", handleMoveEnd);

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
    // Why: the new style brings its own road-line opacities, so the
    // previous cache is stale — clear before setStyle so the next
    // `dimBasemapRoadLines` call repopulates from the fresh values.
    roadOpacityCacheRef.current.clear();
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
      // Why: re-apply road dimming in dark mode (the new style ships
      // with default opacities that we then multiply down). Light
      // mode skips — and leaves the cache empty, ready for the next
      // dark switch.
      if (mapMode === "dark") {
        dimBasemapRoadLines(
          map,
          mapLabelVisibilityRef.current.roadDimDark,
          roadOpacityCacheRef.current
        );
      }
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

  // Why: re-apply road dimming whenever the slider value (or mode)
  // changes, in dark mode only. The cache makes this a no-op-fast
  // path when the factor hasn't changed — setPaintProperty calls
  // are cheap and dimBasemapRoadLines reads from the cache rather
  // than the live style each time. Light mode is intentionally a
  // no-op here: the basemap's defaults stand untouched.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (mapMode !== "dark") return;
    dimBasemapRoadLines(
      mapRef.current,
      mapLabelVisibility.roadDimDark,
      roadOpacityCacheRef.current
    );
  }, [mapLabelVisibility.roadDimDark, mapMode, mapReady]);

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
      const nearestTrackSource = mapRef.current?.getSource("nearest-track") as
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
      let nearestRenderedPosition: { latitude: number; longitude: number } | null = null;
      const playbackFlights = displayFlightsRef.current;
      const selectedId = selectedFlightIdRef.current;
      const nearestId = nearestFlightIdRef.current;
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

      // Why: pre-compute rendered positions and home-base distances so
      // we can pick the label set BEFORE building features. Label rule
      // is "selected (when present) plus the closest 2 non-selected,
      // OR the closest 3 when there's no selection" — always 3 labels
      // on the map. Done as a separate pass because the closest-N
      // decision can't be made until we've measured every flight.
      // Also captures the side-effect refs used downstream (selected /
      // nearest rendered positions) and the per-identity VFR latch
      // refresh.
      const flightData = playbackFlights.map((flight) => {
        const animationState = animationStates.get(flight.id);
        const renderedPosition = getAnimatedPosition(
          animationState,
          flight,
          frameTime
        );
        // Why: spring-smoothed heading mirrors the position chase but with
        // its own (much shorter) τ — see HEADING_SPRING_TAU_SEC. Falls
        // back to the raw reported heading when there's no animation
        // state yet (very first frame after a flight appears).
        const renderedHeadingDegrees =
          (animationState
            ? computeSpringHeading(animationState, frameTime)
            : null) ??
          flight.headingDegrees ??
          0;
        const distanceMiles = getDistanceFromHomeBaseCoordinates(
          renderedPosition.latitude,
          renderedPosition.longitude,
          homeBase
        );
        if (flight.id === selectedFlightIdRef.current) {
          selectedRenderedPosition = renderedPosition;
        }
        if (flight.id === nearestId) {
          nearestRenderedPosition = renderedPosition;
        }
        // Why: refresh the per-identity VFR latch so a transient null
        // squawk doesn't flip the strip-card label from "VFR" away.
        // See VFR_LATCH_DURATION_MS / isFlightVfrForLabel.
        refreshVfrLatchIfApplicable(flight);
        return { flight, renderedPosition, renderedHeadingDegrees, distanceMiles };
      });

      const labelIds = new Set<string>();
      if (selectedId != null) {
        labelIds.add(selectedId);
      }
      // Why: when a selection is pinned we already used one label slot
      // for it, so fill the remaining 2 with the closest non-selected
      // flights. When nothing is selected, all 3 slots go to the
      // closest 3 by distance from home base.
      const remainingLabelSlots = selectedId == null ? 3 : 2;
      const labelCandidates = flightData
        .filter(({ flight }) => flight.id !== selectedId)
        .sort((a, b) => a.distanceMiles - b.distanceMiles)
        .slice(0, remainingLabelSlots);
      for (const { flight } of labelCandidates) {
        labelIds.add(flight.id);
      }

      flightSource.setData({
        type: "FeatureCollection",
        features: flightData.map(({ flight, renderedPosition, renderedHeadingDegrees, distanceMiles }) => ({
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
            isSelected: flight.id === selectedFlightIdRef.current,
            // Why: nearestFlightIdRef is null when there's a selection,
            // so this naturally evaluates false for selected flights —
            // we never paint the nearest treatment on top of the
            // selected one.
            isNearest: flight.id === nearestFlightIdRef.current,
            label: flight.flightNumber ?? flight.callsign,
            showLabel: labelIds.has(flight.id),
            // Why: pointer-vs-dot decision is "fixed-wing AND moving
            // with reliable heading." Helicopters always render as
            // dots — their nose direction often disagrees with their
            // direction of travel (sidling, hovering, reversing) so
            // pointing them with `track` would mislead. Below the
            // speed threshold we also fall back to dot regardless of
            // type, since heading is too noisy to trust.
            // Heading is spring-smoothed (HEADING_SPRING_TAU_SEC) with
            // shortest-arc unwrap so per-poll jitter doesn't cause the
            // pointer to twitch. The dot shape is radially symmetric
            // so rotation is invisible for the dot case anyway.
            headingDegrees: renderedHeadingDegrees,
            isHelicopter: isHelicopterType(flight.aircraftType),
            isMoving:
              flight.headingDegrees != null &&
              flight.groundspeedKnots != null &&
              flight.groundspeedKnots >= MIN_HEADING_RELIABLE_KNOTS,
            stripHoverOpacity,
            stripHoverRadius,
            stripHoverStrokeOpacity
          }
        }))
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
          activeSelectedTrack?.track ?? [],
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

      // Why: nearest-track update — uses the SAME pipeline as the
      // selected case. The client-side prefetch effect in FlightMap
      // fires `/api/flights/selected` for predicted-nearest
      // candidates, lands details in `selectedMetadataById`, and we
      // read them back from `selectedMetadataByIdRef` here. The track
      // (provider-derived from adsb.lol/AeroAPI) is on
      // `details.track`. Falls back to breadcrumbs-only when no
      // details have landed for this flight yet (transient first-
      // frame state). nearestId is null when there's an explicit
      // selection — clear the source so we don't render two trails.
      if (nearestId == null) {
        clearSelectedTrackSource(nearestTrackSource);
      } else {
        const nearestAnimationState = animationStates.get(nearestId);
        const nearestDisplayedProviderTimestampMs = getDisplayedProviderTimestampMs(
          nearestAnimationState,
          frameTime
        );
        const nearestBreadcrumbPoints = clipBreadcrumbCoordinatesToAnimation(
          sanitizeBreadcrumbPoints(
            flightBreadcrumbsRef.current.get(nearestId)?.points ?? []
          ),
          nearestAnimationState,
          frameTime
        );
        // Why: linger-fallback like the selected case — if the nearest
        // happens to be in displayFlightsRef this frame we have a
        // rendered position; otherwise compute one from the animation
        // state so the icon-tail-append still works on the very first
        // frame after the nearest changes.
        const nearestLingerPosition =
          nearestRenderedPosition ??
          (nearestAnimationState
            ? computeSpringPosition(nearestAnimationState, frameTime)
            : null);
        // Same storage as the selected flight's cached details — the
        // unified prefetch effect populates these for predicted-
        // nearest candidates so the trail can render from real
        // provider track the moment the nearest pointer transitions.
        const nearestDetails =
          selectedMetadataByIdRef.current[nearestId]?.value ?? null;
        // When we have provider track, lead-filter heading is
        // correct — it prevents the trail-leads-dot zigzag during
        // the spring chase. With breadcrumbs only (no details
        // landed yet), null heading disables the lead filter, which
        // would otherwise over-reject historical breadcrumbs for
        // slow/circling planes (their past positions can sit
        // geographically ahead of the icon's instantaneous heading).
        const nearestHasProviderTrack =
          nearestDetails != null && nearestDetails.track.length > 0;
        const nearestHeading = nearestHasProviderTrack
          ? nearestAnimationState?.targetHeadingDegrees ?? null
          : null;
        setSelectedTrackSourceData(
          nearestTrackSource,
          nearestId,
          nearestDetails?.track ?? [],
          nearestBreadcrumbPoints,
          nearestLingerPosition,
          nearestDisplayedProviderTimestampMs,
          nearestHeading
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
          activeSelectedTrack?.track ?? [],
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
      activeSelectedTrack?.track ?? [],
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
