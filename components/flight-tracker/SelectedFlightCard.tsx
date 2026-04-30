"use client";

import { Helicopter, Plane } from "lucide-react";
import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import {
  formatAirspeed,
  formatAltitude,
  getArrivalTimeDisplay,
  getDepartureTimeDisplay,
  getFlightStatusSeverity,
  getIdentifierLabel,
  getMeaningfulFlightStatus,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getRadiotelephonyCall,
  getStripRouteLabel,
  normalizeRegisteredOwnerLabel,
  type FlightStatusSeverity,
  type ScheduleTimes
} from "@/lib/flights/display";
import {
  getAircraftTypeBadgeLabel,
  isHelicopterType,
  resolveAircraftType
} from "@/lib/flights/aircraftTypes";
import { resolveAirportInfo } from "@/lib/flights/laAirports";
import type { ComponentProps } from "react";
import type { Flight } from "@/lib/flights/types";
import {
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles
} from "@/lib/map/geo-helpers";
import type {
  HomeBaseCenter,
  SelectedFlightDetailsResponse,
  TrendDirection
} from "@/lib/types/flight-map";
import { cn } from "@/lib/utils";

type SelectedFlightCardProps = {
  flight: Flight;
  details: SelectedFlightDetailsResponse["details"] | null;
  homeBase: HomeBaseCenter;
  altitudeTrend: TrendDirection;
  airspeedTrend: TrendDirection;
};

// Why: every dt label across the card uses the same compact uppercase
// styling. Pinning leading-tight (vs. the cascaded text-xs/relaxed
// 1.625 from Card) gives all labels a 12.5px line-box for 10px text —
// no extra "leading" space below the label glyphs that would otherwise
// inflate the visible gap to the value below.
const LABEL_CLASS =
  "text-[10px] leading-tight uppercase tracking-wider text-muted-foreground";

// Why: severity-to-visual mapping for the status badge. Lives at the
// component layer (not display.ts) because it's a styling concern; the
// classification rules in display.ts return a severity string and the
// component owns how that severity renders. shadcn's Badge has no
// "warning" variant by default, so the warning row uses outline +
// inline amber tints (works in both light + dark, mirrors the
// destructive variant's "tinted bg + colored text" pattern).
const STATUS_BADGE_STYLES: Record<
  FlightStatusSeverity,
  { variant: ComponentProps<typeof Badge>["variant"]; className?: string }
> = {
  critical: { variant: "destructive" },
  warning: {
    variant: "outline",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
  },
  ground: { variant: "secondary" },
  info: { variant: "default" }
};

// Why: same story for values — each value across the card pins
// leading-tight so the line-box height stays tight to the glyphs
// regardless of font size. Without this, header values (text-lg, 22.5px
// box) and content values (text-xs, 19.5px box) sit in differently-tall
// boxes, making the dt-to-value gap look uneven across blocks even
// when gap-1 is applied uniformly.
const VALUE_LEADING = "leading-tight";

// Why: the card title shows the IATA flight number ("WN1184") because
// it's what passengers see on boarding passes — the friendly hero
// signifier. The ICAO callsign ("SWA1184") and spoken radio call
// ("Southwest 1184") used to live in a small line under the title;
// that was visual noise on the common case where they're identical
// (charter ops, GA flights) and not particularly useful info on the
// hover-curious commercial case. Move them into a tooltip on the
// title — discoverable for the curious, invisible for everyone else.
//
// Skip rendering the tooltip when there's nothing additive to say
// (no distinct callsign, no resolvable airline operator) — falling
// back to plain title text rather than an empty hover target.
function FlightTitleWithRadioTooltip({ flight }: { flight: Flight }) {
  const primary = getPrimaryIdentifier(flight);
  const radioCall = getRadiotelephonyCall(flight);
  const callsignDiffersFromPrimary =
    flight.callsign && flight.callsign !== primary;

  if (!callsignDiffersFromPrimary && !radioCall) {
    return (
      <CardTitle className="text-lg leading-tight tabular-nums">
        {primary}
      </CardTitle>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why: dotted underline as the visual affordance for "this
              has more info on hover". Keeps the title clean while
              hinting at interactivity. cursor-help reinforces it. */}
          <CardTitle className="cursor-help text-lg leading-tight tabular-nums underline decoration-muted-foreground/40 decoration-dotted underline-offset-4">
            {primary}
          </CardTitle>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="flex flex-col gap-0.5">
          {callsignDiffersFromPrimary ? (
            <span className="tabular-nums">
              <span className="text-background/70">ATC </span>
              {flight.callsign}
            </span>
          ) : null}
          {radioCall ? (
            <span>
              <span className="text-background/70">Radio </span>
              &ldquo;{radioCall}&rdquo;
            </span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Why: airport code value with a hover tooltip showing the full
// airport name when it resolves in our KNOWN_AIRPORTS table. Hovering
// "BUR" shows "Hollywood Burbank"; "LAPD Hooper Heliport" shows
// "Jay Stephen Hooper Memorial Heliport (Piper Tech, Downtown LA)".
// Unmapped values (reverse-geocoded neighborhoods, status fallbacks)
// render as plain text without a tooltip.
const AIRPORT_VALUE_CLASS = cn(
  "truncate text-xs font-medium tabular-nums",
  VALUE_LEADING
);

function AirportValue({ code }: { code: string }) {
  const airport = resolveAirportInfo(code);

  if (!airport) {
    return <p className={AIRPORT_VALUE_CLASS}>{code}</p>;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <p
            className={cn(
              AIRPORT_VALUE_CLASS,
              "cursor-help underline decoration-muted-foreground/30 decoration-dotted underline-offset-4"
            )}
            tabIndex={0}
          >
            {code}
          </p>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-xs">
          <span>{airport.name}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Why: small muted line under each airport showing the most-current
// departure / arrival time when AeroAPI provides schedule data.
// "Dep 3:45 PM" / "ETA 4:58 PM" / "Arr 4:58 PM" / "Sched X:XX PM".
// Helpers in display.ts pick the variant + label.
function ScheduleTimeLine({
  display
}: {
  display: { label: string; time: string } | null;
}) {
  if (!display) return null;
  return (
    <p className="truncate text-[10px] leading-tight tabular-nums text-muted-foreground">
      <span className="text-foreground/70">{display.label}</span>{" "}
      {display.time}
    </p>
  );
}

// Why: route row splits into FROM / TO when both endpoints are known
// so each side gets its own half-width column for truncation
// breathing room (long helipad / medical center names like "LAPD
// Hooper Heliport" or "Cedars-Sinai Medical Center" don't fit a
// single-line "X to Y" without truncating). Falls back to a single
// full-width labeled row when only one endpoint is known, or to the
// VFR / Route pending status when neither is.
//
// When AeroAPI schedule data is available (commercial flights with
// metadata), a small muted time line sits under each airport: "Dep
// 3:45 PM" under FROM, "ETA 4:58 PM" under TO. Hidden for non-
// commercial / unfiled flights where AeroAPI has no schedule.
function FlightRouteRow({
  flight,
  scheduleTimes
}: {
  flight: Flight;
  scheduleTimes: ScheduleTimes | null;
}) {
  const origin = flight.origin;
  const destination = flight.destination;
  const departureDisplay = scheduleTimes ? getDepartureTimeDisplay(scheduleTimes) : null;
  const arrivalDisplay = scheduleTimes ? getArrivalTimeDisplay(scheduleTimes) : null;

  if (origin && destination) {
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={LABEL_CLASS}>From</p>
          <AirportValue code={origin} />
          <ScheduleTimeLine display={departureDisplay} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <p className={LABEL_CLASS}>To</p>
          <AirportValue code={destination} />
          <ScheduleTimeLine display={arrivalDisplay} />
        </div>
      </div>
    );
  }

  if (origin) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className={LABEL_CLASS}>From</p>
        <AirportValue code={origin} />
        <ScheduleTimeLine display={departureDisplay} />
      </div>
    );
  }

  if (destination) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className={LABEL_CLASS}>To</p>
        <AirportValue code={destination} />
        <ScheduleTimeLine display={arrivalDisplay} />
      </div>
    );
  }

  // No origin and no destination — fall back to the single-row Route
  // label with whatever fallback string applies (VFR for VFR-squawking
  // flights, Route pending otherwise). Plain text — fallback string
  // isn't an airport, no tooltip to show.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className={LABEL_CLASS}>Route</p>
      <p className={AIRPORT_VALUE_CLASS}>{getStripRouteLabel(flight)}</p>
    </div>
  );
}

// Why: aircraft-type badge needs the readable short name, an icon
// (Plane / Helicopter), and a hover tooltip with the raw ICAO + full
// manufacturer-prefixed name when we have a mapping. For unmapped
// types we fall back to the raw ICAO with a Plane icon (most unmapped
// types are GA / experimental fixed-wing) and skip the tooltip — the
// displayed text already IS the most precise info we have.
function AircraftTypeBadge({
  aircraftType
}: {
  aircraftType: string | null;
}) {
  const resolved = resolveAircraftType(aircraftType);
  const label = getAircraftTypeBadgeLabel(aircraftType);
  const Icon = isHelicopterType(aircraftType) ? Helicopter : Plane;

  // No mapping → raw ICAO already shown, no tooltip content to add.
  if (!resolved) {
    return (
      <Badge variant="secondary" className="text-[10px]">
        <Icon aria-hidden="true" />
        {label}
      </Badge>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="cursor-help text-[10px]"
            tabIndex={0}
          >
            <Icon aria-hidden="true" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="flex flex-col gap-0.5">
          {aircraftType ? (
            <span className="tabular-nums">
              <span className="text-background/70">ICAO </span>
              {aircraftType.trim().toUpperCase()}
            </span>
          ) : null}
          <span>{resolved.full}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SelectedFlightCardImpl({
  flight,
  details,
  homeBase,
  altitudeTrend,
  airspeedTrend
}: SelectedFlightCardProps) {
  // Why: pull these once so the visibility logic for the Operator +
  // Registration row reads cleanly. When only one of the two fields
  // applies we span it across both columns; when both apply they sit
  // side-by-side on a single grid row.
  const operatorLabel = getOperatorLabel(flight);
  const showRegistration =
    flight.registration != null &&
    getPrimaryIdentifier(flight) !== flight.registration;
  const ownerLabel = normalizeRegisteredOwnerLabel(flight.registeredOwner);
  const showOwner = ownerLabel != null && ownerLabel !== operatorLabel;
  // Why: the status badge hides the "everything's fine" airborne states
  // (En Route / On Time) and only renders for signal-bearing values —
  // ground transitions, deviations, timeliness drift. See display.ts.
  // When it does render, the badge variant + tint reflect the severity
  // of the state (critical / warning / ground / info) so the user can
  // tell at a glance whether the status is concerning or just neutral.
  const meaningfulStatus = getMeaningfulFlightStatus(details?.status);
  const statusBadgeStyle = meaningfulStatus
    ? STATUS_BADGE_STYLES[getFlightStatusSeverity(meaningfulStatus)]
    : null;

  // Why: pull schedule times once and pass to the route row. null when
  // details aren't available (commercial pre-enrichment, GA / private
  // flights AeroAPI doesn't have data for) — route row hides the time
  // line in that case. originTimezone / destinationTimezone come
  // from AeroAPI's airport objects and let each side render in its
  // own local frame.
  const scheduleTimes: ScheduleTimes | null = details
    ? {
        scheduledOut: details.scheduledOut,
        estimatedOut: details.estimatedOut,
        actualOut: details.actualOut,
        scheduledIn: details.scheduledIn,
        estimatedIn: details.estimatedIn,
        actualIn: details.actualIn,
        originTimezone: details.originTimezone,
        destinationTimezone: details.destinationTimezone
      }
    : null;

  return (
    <Card className="mx-1 mt-2 mb-2 shrink-0 gap-3 py-3">
      <CardHeader className="gap-2 px-3">
        {/* Why: the hero hierarchy for a commercial flight reads:
              1. Flight number   ← biggest, with radio tooltip
              2. Route           ← second tier, right under the title
              3. Airline / Reg   ← side-by-side dl row in CardContent
            Badges (type, status) pin to the top-right via items-start,
            aligning with the small dt label rather than centering on
            the big title. */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <CardDescription className={LABEL_CLASS}>
              {getIdentifierLabel(flight)}
            </CardDescription>
            <FlightTitleWithRadioTooltip flight={flight} />
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <AircraftTypeBadge aircraftType={flight.aircraftType} />
            {meaningfulStatus && statusBadgeStyle ? (
              <Badge
                variant={statusBadgeStyle.variant}
                className={cn("text-[10px]", statusBadgeStyle.className)}
              >
                {meaningfulStatus}
              </Badge>
            ) : null}
          </div>
        </div>
        {/* Route as second-tier emphasis directly under the title.
            Splits into FROM / TO when both ends are known so each side
            gets its own half-width column (avoids truncating long
            helipad / medical center names). Falls back to a single
            full-width row for origin-only, destination-only, or
            no-route cases (VFR / Route pending). */}
        <FlightRouteRow flight={flight} scheduleTimes={scheduleTimes} />
      </CardHeader>
      <CardContent className="px-3">
        {/* Why: each dl cell wraps its dt+dd in `flex flex-col gap-1` so
            the 4px label-to-value rhythm matches the FLIGHT / ROUTE
            blocks in the header. Without this the content cells render
            with dt and dd touching (preflight resets default dl
            margins), which read visibly tighter than the header. */}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          {operatorLabel ? (
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1",
                !showRegistration && "col-span-2"
              )}
            >
              <dt className={LABEL_CLASS}>{getOperatorLabelTitle(flight)}</dt>
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
        <Separator className="my-2" />
        <dl className="grid grid-cols-3 gap-2 text-xs">
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
            <dd
              className={cn(
                "flex items-baseline gap-1 font-medium tabular-nums",
                VALUE_LEADING
              )}
            >
              {formatAltitude(
                flight.altitudeFeet,
                details?.status
              )}
              {altitudeTrend ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "text-[10px]",
                    altitudeTrend === "up" ? "text-emerald-500" : "text-amber-500"
                  )}
                >
                  {altitudeTrend === "up" ? "↑" : "↓"}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={LABEL_CLASS}>Airspeed</dt>
            <dd
              className={cn(
                "flex items-baseline gap-1 font-medium tabular-nums",
                VALUE_LEADING
              )}
            >
              {formatAirspeed(flight.groundspeedKnots)}
              {airspeedTrend ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "text-[10px]",
                    airspeedTrend === "up" ? "text-emerald-500" : "text-amber-500"
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
  );
}

// Why: same story as MapCanvas + the list strips. The card only needs to
// re-render when the selected flight, its detail enrichment, or the trend
// signals change — not on every poll cycle. Like FlightListItem, the merge
// pipeline can produce fresh flight objects with the same data, so use a
// custom comparator on the display-relevant flight fields.
export const SelectedFlightCard = memo(SelectedFlightCardImpl, (prev, next) => {
  if (
    prev.details !== next.details ||
    prev.altitudeTrend !== next.altitudeTrend ||
    prev.airspeedTrend !== next.airspeedTrend ||
    prev.homeBase !== next.homeBase
  ) {
    return false;
  }
  const a = prev.flight;
  const b = next.flight;
  return (
    a.id === b.id &&
    a.flightNumber === b.flightNumber &&
    a.registration === b.registration &&
    a.callsign === b.callsign &&
    a.aircraftType === b.aircraftType &&
    a.airline === b.airline &&
    a.registeredOwner === b.registeredOwner &&
    a.origin === b.origin &&
    a.destination === b.destination &&
    a.altitudeFeet === b.altitudeFeet &&
    a.groundspeedKnots === b.groundspeedKnots &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude
  );
});
