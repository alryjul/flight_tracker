"use client";

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
  formatAirspeed,
  formatAltitude,
  getIdentifierLabel,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getRouteLabel,
  getSecondaryIdentifier,
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

export function SelectedFlightCard({
  flight,
  details,
  homeBase,
  altitudeTrend,
  airspeedTrend
}: SelectedFlightCardProps) {
  return (
    <Card className="mx-1 mt-2 mb-2 shrink-0 gap-3 py-3">
      <CardHeader className="gap-1 px-3">
        <CardDescription className="text-[10px] uppercase tracking-wider">
          {getIdentifierLabel(flight)}
        </CardDescription>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg leading-tight tabular-nums">
            {getPrimaryIdentifier(flight)}
          </CardTitle>
          <div className="flex flex-wrap justify-end gap-1">
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
        {getSecondaryIdentifier(flight) ? (
          <p className="text-xs text-muted-foreground">
            {getSecondaryIdentifier(flight)}
          </p>
        ) : null}
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
                    altitudeTrend === "up" ? "text-emerald-500" : "text-red-500"
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
                    airspeedTrend === "up" ? "text-emerald-500" : "text-red-500"
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
