"use client";

// Why: ambient widget — a small floating card that sits on top of the
// map view (not a full-screen takeover). Shows the closest aircraft
// via large split-flap displays for the marquee values (flight
// number + airport codes), with supporting text below for type,
// operator, distance, altitude, etc. The map keeps running
// underneath; toggling ambient on/off only mounts/unmounts this
// card. Designed as a "look at this" accent rather than a replacement
// view.

import { useMemo } from "react";
import {
  getAircraftTypeBadgeLabel,
  resolveAircraftType
} from "@/lib/flights/aircraftTypes";
import {
  formatAltitude,
  getOperatorLabel,
  getPrimaryIdentifier
} from "@/lib/flights/display";
import { getDistanceFromHomeBaseMiles } from "@/lib/map/geo-helpers";
import type { Flight } from "@/lib/flights/types";
import type { HomeBaseCenter } from "@/lib/types/flight-map";
import { SplitFlapDisplay } from "@/components/ui/split-flap";

type AmbientViewProps = {
  nearestFlight: Flight | null;
  homeBase: HomeBaseCenter;
};

// Why: bearing from home base to the flight, mapped to a 16-point
// compass (N, NNE, NE, ENE, ...). Lets the viewer know which
// direction to look up.
function getCompassBearingLabel(
  flight: Flight,
  home: HomeBaseCenter
): string | null {
  const φ1 = (home.latitude * Math.PI) / 180;
  const φ2 = (flight.latitude * Math.PI) / 180;
  const Δλ = ((flight.longitude - home.longitude) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const degrees = ((θ * 180) / Math.PI + 360) % 360;
  const points = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];
  const idx = Math.round(degrees / 22.5) % 16;
  return points[idx] ?? "N";
}

export function AmbientView({ nearestFlight, homeBase }: AmbientViewProps) {
  const bearing = useMemo(
    () => (nearestFlight ? getCompassBearingLabel(nearestFlight, homeBase) : null),
    [nearestFlight, homeBase]
  );

  const distanceMiles = nearestFlight
    ? getDistanceFromHomeBaseMiles(nearestFlight, homeBase)
    : null;

  const flightLabel = nearestFlight
    ? getPrimaryIdentifier(nearestFlight).toUpperCase()
    : "";

  const aircraftType = nearestFlight
    ? resolveAircraftType(nearestFlight.aircraftType)
    : null;
  const aircraftTypeLabel = nearestFlight
    ? getAircraftTypeBadgeLabel(nearestFlight.aircraftType)
    : "";
  const aircraftTypeFull = aircraftType?.full ?? aircraftTypeLabel;

  const operatorLabel = nearestFlight ? getOperatorLabel(nearestFlight) : null;

  const origin = nearestFlight?.origin ?? null;
  const destination = nearestFlight?.destination ?? null;

  // Why: only put origin/destination on the split-flap when they look
  // like short codes (3-4 chars) — long readable names like "LAPD
  // Hooper Heliport" would need ~20 cells, which looks broken in a
  // small card. Long names render as plain text instead.
  const originIsShort = origin != null && origin.length <= 4;
  const destinationIsShort = destination != null && destination.length <= 4;

  // Why: shown as a trailing string under the route. Builds from the
  // longer-form names if either side isn't short-coded.
  const longRouteText = useMemo(() => {
    if (originIsShort && destinationIsShort) return null;
    if (origin && destination) return `${origin} → ${destination}`;
    if (origin) return `From ${origin}`;
    if (destination) return `To ${destination}`;
    return null;
  }, [origin, destination, originIsShort, destinationIsShort]);

  return (
    // Why: top-center of the viewport. With the sidebar open
    // (320px on the left), this lands roughly centered over the map
    // area at common viewport widths. left-1/2 + -translate-x-1/2
    // ignores the sidebar — slightly off-center over just the map
    // but reads as "centered on screen."
    <div className="pointer-events-none fixed top-4 left-1/2 z-30 -translate-x-1/2">
      <div className="pointer-events-auto flex flex-col gap-3 rounded-lg border border-border/60 bg-card/95 px-5 py-4 shadow-xl backdrop-blur-sm">
        {/* Header strip */}
        <div className="flex items-baseline justify-between gap-6">
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Nearest
          </p>
          {bearing && distanceMiles != null ? (
            <p className="text-[10px] tabular-nums uppercase tracking-wider text-muted-foreground">
              {distanceMiles.toFixed(1)} mi · {bearing}
            </p>
          ) : (
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Waiting…
            </p>
          )}
        </div>

        {/* Marquee row: flight number + route via split-flaps */}
        {nearestFlight ? (
          <div className="flex items-center gap-4">
            {/* Flight number */}
            <div className="rounded-md bg-foreground px-3 py-2 text-background shadow-md">
              <SplitFlapDisplay
                value={flightLabel}
                charSet="alphanumeric"
                length={Math.max(flightLabel.length, 6)}
                cycleMs={42}
                flipMs={300}
                className="text-2xl font-semibold tracking-wider"
              />
            </div>

            {/* Route — split-flap when both sides are short codes,
                otherwise let the long-route text below handle it. */}
            {originIsShort && destinationIsShort ? (
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-foreground px-2.5 py-2 text-background shadow-md">
                  <SplitFlapDisplay
                    value={origin ?? ""}
                    charSet="alpha"
                    length={3}
                    padDirection="end"
                    cycleMs={50}
                    flipMs={300}
                    className="text-2xl font-semibold tracking-wider"
                  />
                </div>
                <span className="text-2xl text-muted-foreground/60">→</span>
                <div className="rounded-md bg-foreground px-2.5 py-2 text-background shadow-md">
                  <SplitFlapDisplay
                    value={destination ?? ""}
                    charSet="alpha"
                    length={3}
                    padDirection="end"
                    cycleMs={50}
                    flipMs={300}
                    className="text-2xl font-semibold tracking-wider"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No aircraft in range</p>
        )}

        {/* Supporting info row */}
        {nearestFlight ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{aircraftTypeFull}</span>
            {operatorLabel ? (
              <>
                <span className="opacity-50">·</span>
                <span>{operatorLabel}</span>
              </>
            ) : null}
            {longRouteText ? (
              <>
                <span className="opacity-50">·</span>
                <span className="tabular-nums">{longRouteText}</span>
              </>
            ) : null}
            <span className="opacity-50">·</span>
            <span className="tabular-nums">
              {formatAltitude(nearestFlight.altitudeFeet)}
            </span>
            {nearestFlight.groundspeedKnots != null ? (
              <>
                <span className="opacity-50">·</span>
                <span className="tabular-nums">
                  {nearestFlight.groundspeedKnots.toLocaleString()} kt
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
