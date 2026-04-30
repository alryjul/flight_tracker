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
  getIdentifierLabel,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getRadiotelephonyCall,
  getRouteLabel,
  normalizeRegisteredOwnerLabel
} from "@/lib/flights/display";
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
  return (
    <Card className="mx-1 mt-2 mb-2 shrink-0 gap-3 py-3">
      <CardHeader className="px-3">
        {/* Why: pin the badges to the top-right corner of the header
            instead of vertically centering them next to the big title.
            With items-start the badges align with the small "FLIGHT" /
            "REGISTRATION" dt label on the left, leaving the title row
            visually clean. */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <CardDescription className="text-[10px] uppercase tracking-wider">
              {getIdentifierLabel(flight)}
            </CardDescription>
            <FlightTitleWithRadioTooltip flight={flight} />
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <Badge variant="secondary" className="text-[10px]">
              {flight.aircraftType ?? "Unknown type"}
            </Badge>
            {details?.status ? (
              <Badge className="text-[10px]">
                {details.status}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          {getOperatorLabel(flight) ? (
            <div className="col-span-2 min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {getOperatorLabelTitle(flight)}
              </dt>
              <dd className="truncate font-medium">
                {getOperatorLabel(flight)}
              </dd>
            </div>
          ) : null}
          {flight.registration &&
          getPrimaryIdentifier(flight) !== flight.registration ? (
            <div className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Registration
              </dt>
              <dd className="truncate font-medium tabular-nums">
                {flight.registration}
              </dd>
            </div>
          ) : null}
          {getRouteLabel(flight) ? (
            <div className="col-span-2 min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Route
              </dt>
              <dd className="truncate font-medium tabular-nums">
                {getRouteLabel(flight)}
              </dd>
            </div>
          ) : null}
          {normalizeRegisteredOwnerLabel(flight.registeredOwner) &&
          normalizeRegisteredOwnerLabel(flight.registeredOwner) !==
            getOperatorLabel(flight) ? (
            <div className="col-span-2 min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Owner
              </dt>
              <dd className="truncate font-medium">
                {normalizeRegisteredOwnerLabel(flight.registeredOwner)}
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
                getDistanceFromHomeBaseMiles(flight, homeBase)
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Altitude
            </dt>
            <dd className="flex items-baseline gap-1 font-medium tabular-nums">
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
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Airspeed
            </dt>
            <dd className="flex items-baseline gap-1 font-medium tabular-nums">
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
