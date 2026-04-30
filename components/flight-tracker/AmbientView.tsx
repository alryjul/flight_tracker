"use client";

// Why: ambient widget — a floating card on top of the map showing the
// nearest aircraft. Mirrors the SelectedFlightCard's information
// architecture (same labels, same sections, same dt/value pairs) so
// users learn one card-shape and see it again here scaled up. The
// only differences are:
//   1. "NEAREST" header replaces FLIGHT/REGISTRATION dt
//   2. Bearing + distance shown alongside the header
//   3. Marquee values (flight number, FROM/TO codes) wrapped in
//      split-flap displays for the solari-board flip aesthetic
//   4. Larger type / more generous spacing
//   5. No selected-flight enrichment, so no schedule times or status
//      badge — those require a per-selection AeroAPI call which we
//      don't trigger for the nearest aircraft.

import { useMemo } from "react";
import { Helicopter, Plane } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SplitFlapDisplay } from "@/components/ui/split-flap";
import {
  getAircraftTypeBadgeLabel,
  isHelicopterType,
  resolveAircraftType
} from "@/lib/flights/aircraftTypes";
import {
  formatAirspeed,
  formatAltitude,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  normalizeRegisteredOwnerLabel
} from "@/lib/flights/display";
import {
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles
} from "@/lib/map/geo-helpers";
import type { Flight } from "@/lib/flights/types";
import type { HomeBaseCenter } from "@/lib/types/flight-map";
import { cn } from "@/lib/utils";

// Why: dt label styling — same shape as SelectedFlightCard's LABEL_CLASS
// but slightly larger size for ambient (text-xs vs text-[10px]). Letters
// stay uppercase + tracking-wider for the labeled-metric register.
const LABEL_CLASS =
  "text-xs leading-tight uppercase tracking-wider text-muted-foreground";

const VALUE_LEADING = "leading-tight";

// Why: bearing from home base to the flight, mapped to a 16-point compass
// (N, NNE, NE, ENE, ...). Lets the viewer know which direction to look up.
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

type AmbientViewProps = {
  flight: Flight | null;
  /** Whether the displayed flight is the user-selected one (true) or
   * the auto-tracked nearest aircraft (false). Drives the dt label. */
  isSelected: boolean;
  homeBase: HomeBaseCenter;
};

export function AmbientView({ flight, isSelected, homeBase }: AmbientViewProps) {
  // Why: compute everything before the JSX so the markup reads as a
  // straight mirror of SelectedFlightCard. nullable-flight handled by
  // the early-return below.
  const distanceMiles = flight
    ? getDistanceFromHomeBaseMiles(flight, homeBase)
    : null;
  const bearing = useMemo(
    () => (flight ? getCompassBearingLabel(flight, homeBase) : null),
    [flight, homeBase]
  );

  if (!flight) {
    return (
      <AmbientShell>
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">
          Waiting for an aircraft in range…
        </p>
      </AmbientShell>
    );
  }
  const primaryIdentifier = getPrimaryIdentifier(flight).toUpperCase();
  const operatorLabel = getOperatorLabel(flight);
  const operatorTitle = getOperatorLabelTitle(flight);
  const showRegistration =
    flight.registration != null &&
    getPrimaryIdentifier(flight) !== flight.registration;
  const ownerLabel = normalizeRegisteredOwnerLabel(flight.registeredOwner);
  const showOwner = ownerLabel != null && ownerLabel !== operatorLabel;

  return (
    <AmbientShell>
      <CardHeader className="gap-3 px-5 pt-5">
        {/* Header row — "NEAREST" + bearing/distance on left, type
            badge on right. Mirrors SelectedFlightCard's
            FLIGHT/REGISTRATION dt + badges layout. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <p className={LABEL_CLASS}>
              {isSelected ? "Selected" : "Nearest"}
              {bearing && distanceMiles != null ? (
                <span className="ml-2 normal-case tracking-normal text-foreground/60 tabular-nums">
                  {formatDistanceMiles(distanceMiles)} · {bearing}
                </span>
              ) : null}
            </p>
            {/* Split-flap title. Length pads to 6 chars min so short
                callsigns (CMD7, EJA471) don't make the panel collapse. */}
            <div className="rounded-md bg-foreground px-3 py-2 text-background shadow-md">
              <SplitFlapDisplay
                value={primaryIdentifier}
                charSet="alphanumeric"
                length={Math.max(primaryIdentifier.length, 6)}
                cycleMs={42}
                flipMs={300}
                className="text-3xl font-semibold tracking-wider"
              />
            </div>
          </div>
          <AmbientAircraftTypeBadge aircraftType={flight.aircraftType} />
        </div>

        {/* Route row — FROM / TO with split-flaps for short codes,
            plain text for long readable names. */}
        <AmbientRouteRow flight={flight} />
      </CardHeader>

      <CardContent className="px-5 pb-5">
        {/* Operator / Registration / Owner — same dl layout as
            SelectedFlightCard. Larger text-sm for ambient. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {operatorLabel ? (
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1",
                !showRegistration && "col-span-2"
              )}
            >
              <dt className={LABEL_CLASS}>{operatorTitle}</dt>
              <dd className={cn("truncate font-medium", VALUE_LEADING)}>
                {operatorLabel}
              </dd>
            </div>
          ) : null}
          {showRegistration ? (
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1",
                !operatorLabel && "col-span-2"
              )}
            >
              <dt className={LABEL_CLASS}>Registration</dt>
              <dd
                className={cn(
                  "truncate font-medium tabular-nums",
                  VALUE_LEADING
                )}
              >
                {flight.registration}
              </dd>
            </div>
          ) : null}
          {showOwner ? (
            <div className="col-span-2 flex min-w-0 flex-col gap-1">
              <dt className={LABEL_CLASS}>Owner</dt>
              <dd className={cn("truncate font-medium", VALUE_LEADING)}>
                {ownerLabel}
              </dd>
            </div>
          ) : null}
        </dl>

        <Separator className="my-3" />

        {/* Stats — Distance / Altitude / Airspeed, mirrors
            SelectedFlightCard's metrics row. */}
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <dt className={LABEL_CLASS}>Distance</dt>
            <dd className={cn("font-medium tabular-nums", VALUE_LEADING)}>
              {formatDistanceMiles(
                getDistanceFromHomeBaseMiles(flight, homeBase)
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={LABEL_CLASS}>Altitude</dt>
            <dd className={cn("font-medium tabular-nums", VALUE_LEADING)}>
              {formatAltitude(flight.altitudeFeet)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={LABEL_CLASS}>Airspeed</dt>
            <dd className={cn("font-medium tabular-nums", VALUE_LEADING)}>
              {formatAirspeed(flight.groundspeedKnots)}
            </dd>
          </div>
        </dl>
      </CardContent>
    </AmbientShell>
  );
}

// Why: outer shell — fixed positioning, glassmorphic background, the
// pointer-events handling. Pulled out so the early-return waiting
// state and the populated state share the same chrome.
function AmbientShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed top-4 left-1/2 z-30 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2">
      <Card className="pointer-events-auto gap-3 border-border/60 bg-card/95 py-0 shadow-xl backdrop-blur-sm">
        {children}
      </Card>
    </div>
  );
}

// Why: ambient-sized version of SelectedFlightCard's AircraftTypeBadge.
// We don't import the real one because it carries a Tooltip+Provider
// per badge that's overkill for the ambient surface, where the user
// is glancing not hovering. Just the icon + short name.
function AmbientAircraftTypeBadge({
  aircraftType
}: {
  aircraftType: string | null;
}) {
  const resolved = resolveAircraftType(aircraftType);
  const label = getAircraftTypeBadgeLabel(aircraftType);
  const Icon = isHelicopterType(aircraftType) ? Helicopter : Plane;
  return (
    <Badge
      variant="secondary"
      className="text-xs"
      title={resolved?.full ?? label}
    >
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

// Why: ambient version of FlightRouteRow — same FROM / TO split as
// SelectedFlightCard, but each airport code wrapped in a split-flap
// panel when it's short (≤4 chars / IATA code). Long readable names
// (helipads, hospital names) fall back to plain text in the same
// position because a 20-cell split-flap on "LAPD Hooper Heliport"
// would be visually broken.
function AmbientRouteRow({ flight }: { flight: Flight }) {
  const origin = flight.origin;
  const destination = flight.destination;

  if (origin && destination) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={LABEL_CLASS}>From</p>
          <AirportCell code={origin} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <p className={LABEL_CLASS}>To</p>
          <AirportCell code={destination} />
        </div>
      </div>
    );
  }

  if (origin) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className={LABEL_CLASS}>From</p>
        <AirportCell code={origin} />
      </div>
    );
  }

  if (destination) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className={LABEL_CLASS}>To</p>
        <AirportCell code={destination} />
      </div>
    );
  }

  return null;
}

function AirportCell({ code }: { code: string }) {
  const isShortCode = code.length <= 4;
  if (isShortCode) {
    return (
      <div className="inline-block w-fit rounded-md bg-foreground px-2.5 py-1.5 text-background shadow-md">
        <SplitFlapDisplay
          value={code}
          charSet="alpha"
          length={3}
          padDirection="end"
          cycleMs={50}
          flipMs={300}
          className="text-2xl font-semibold tracking-wider"
        />
      </div>
    );
  }
  return (
    <p className={cn("truncate text-base font-medium", VALUE_LEADING)}>
      {code}
    </p>
  );
}
