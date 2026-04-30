"use client";

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
  getFlightStatusSeverity,
  getIdentifierLabel,
  getMeaningfulFlightStatus,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getRadiotelephonyCall,
  getStripRouteLabel,
  normalizeRegisteredOwnerLabel,
  type FlightStatusSeverity
} from "@/lib/flights/display";
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
            <Badge variant="secondary" className="text-[10px]">
              {flight.aircraftType ?? "Unknown type"}
            </Badge>
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
            Mirrors the FLIGHT / REGISTRATION block's dt+title structure
            so the ROUTE label visually anchors the route line the same
            way. getStripRouteLabel always returns something usable —
            "BUR to SJC" / "From SMO" / "Route pending" / "VFR" — so
            this slot never goes blank. */}
        <div className="flex min-w-0 flex-col gap-1">
          <p className={LABEL_CLASS}>Route</p>
          <p
            className={cn(
              "truncate text-xs font-medium tabular-nums",
              VALUE_LEADING
            )}
          >
            {getStripRouteLabel(flight)}
          </p>
        </div>
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
