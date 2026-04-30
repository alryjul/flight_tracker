"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap } from "maplibre-gl";
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
  onHoverFlight: (state: HoveredFlightState | null) => void;
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
  onHoverFlight
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);

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
          onSelectFlight(id);
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

    const flightSource = source;
    const trackSource = mapRef.current?.getSource("selected-track") as GeoJSONSource | undefined;

    // [trail-debug] Throttle for the optional in-frame diagnostic. Toggle with
    // `window.__TRAIL_DEBUG = true` in DevTools to surface the icon vs trail-tip
    // relationship for the selected flight at ~1 Hz.
    let trailDebugLastLogAtMs = 0;

    function renderFrame(frameTime: number) {
      // Why: read kept to preserve the original RAF timing semantics. The
      // value is unused but the access keeps the ref hot and serves as a
      // stable insertion point for future snapshot-driven readouts.
      const playbackSnapshots = snapshotHistoryRef.current;
      void playbackSnapshots;
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
    <div className="fixed inset-0 z-0">
      <div className="h-full w-full" ref={containerRef} />
    </div>
  );
}
