"use client";

import { Helicopter, Plane } from "lucide-react";
import { memo, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import {
  getAircraftTypeBadgeLabel,
  isHelicopterType
} from "@/lib/flights/aircraftTypes";
import {
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getRouteCell
} from "@/lib/flights/display";
import type { Flight } from "@/lib/flights/types";
import { cn } from "@/lib/utils";

type FlightListItemProps = {
  flight: Flight;
  isSelected: boolean;
  isStripHovered: boolean;
  rankChange: number | undefined;
  // Why: parent callbacks take a flight id and remain stable across renders.
  // The child binds them to its own flight.id via useCallback, so the
  // <button>'s onClick / onMouseEnter / onMouseLeave / ref props get stable
  // handler identity per-instance — the React.memo wrapper below can then
  // skip render when nothing about this flight has actually changed.
  onSelect: (id: string) => void;
  onHoverStart: (id: string) => void;
  onHoverEnd: (id: string) => void;
  registerRef: (id: string, node: HTMLButtonElement | null) => void;
};

function FlightListItemImpl({
  flight,
  isSelected,
  isStripHovered,
  rankChange,
  onSelect,
  onHoverStart,
  onHoverEnd,
  registerRef
}: FlightListItemProps) {
  const handleSelect = useCallback(() => onSelect(flight.id), [onSelect, flight.id]);
  const handleHoverStart = useCallback(
    () => onHoverStart(flight.id),
    [onHoverStart, flight.id]
  );
  const handleHoverEnd = useCallback(
    () => onHoverEnd(flight.id),
    [onHoverEnd, flight.id]
  );
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => registerRef(flight.id, node),
    [registerRef, flight.id]
  );

  return (
    <button
      className={cn(
        "group flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors",
        "border-sidebar-border bg-sidebar/40 hover:bg-sidebar-accent/60",
        isSelected &&
          "border-sidebar-primary bg-sidebar-accent text-sidebar-accent-foreground",
        isStripHovered && !isSelected && "border-sidebar-primary/40"
      )}
      onBlur={handleHoverEnd}
      onClick={handleSelect}
      onFocus={handleHoverStart}
      onMouseEnter={handleHoverStart}
      onMouseLeave={handleHoverEnd}
      ref={handleRef}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="truncate font-mono text-sm font-semibold tabular-nums">
          {getPrimaryIdentifier(flight)}
        </strong>
        <span className="flex items-center gap-1.5">
          {rankChange ? (
            <span
              aria-label={rankChange > 0 ? "Moved closer" : "Moved farther"}
              className={cn(
                "text-[10px] font-medium",
                rankChange > 0 ? "text-emerald-500" : "text-amber-500"
              )}
              title={rankChange > 0 ? "Moved closer" : "Moved farther"}
            >
              {rankChange > 0 ? "↑" : "↓"}
            </span>
          ) : null}
          {(() => {
            const Icon = isHelicopterType(flight.aircraftType) ? Helicopter : Plane;
            return (
              <Badge
                variant="outline"
                className="px-1.5 py-0 font-mono text-[9px] font-normal tabular-nums"
              >
                <Icon aria-hidden="true" />
                {getAircraftTypeBadgeLabel(flight.aircraftType)}
              </Badge>
            );
          })()}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <span className="flex min-w-0 flex-col">
          {/* Why: keep the strip row's dt in lockstep with SelectedFlightCard
              so a flight that reads "Airline: Southwest Airlines" in the main
              card doesn't read "Operator: Southwest Airlines" in its strip row.
              CALSTAR & friends correctly degrade to "Operator" in both places. */}
          <small className="text-[9px] uppercase tracking-wider text-muted-foreground">
            {getOperatorLabelTitle(flight)}
          </small>
          <strong className="truncate font-mono font-medium">
            {/* Why: when there's no real operator info (no airline, no
                non-manufacturer owner), show an em-dash rather than echoing
                the callsign that's already in the strip's title above. The
                old behavior fell back to the callsign which read as a bug. */}
            {getOperatorLabel(flight) ?? "—"}
          </strong>
        </span>
        <span className="flex min-w-0 flex-col">
          {/* Why: route cell adapts label + value together — origin-only
              flights read as "FROM / Hooper" instead of the redundant
              "ROUTE / From Hooper" we used to show. Two-airport routes
              still use "ROUTE / X to Y" because the strip's half-width
              cell isn't tall enough to split into FROM / TO columns
              like the SelectedFlightCard does. */}
          {(() => {
            const routeCell = getRouteCell(flight);
            return (
              <>
                <small className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  {routeCell.label}
                </small>
                <strong className="truncate font-mono font-medium tabular-nums">
                  {routeCell.value}
                </strong>
              </>
            );
          })()}
        </span>
      </div>
    </button>
  );
}

// Why: every poll the orchestrator gets a fresh flights array (and possibly
// fresh per-flight objects from the metadata-merge pipeline), so React.memo's
// default shallow compare on `flight` would always fail and re-render every
// item every poll — exactly what we're trying to avoid. Compare only the
// fields the JSX actually reads. Adding new display fields to the JSX means
// adding them here too.
export const FlightListItem = memo(FlightListItemImpl, (prev, next) => {
  if (
    prev.isSelected !== next.isSelected ||
    prev.isStripHovered !== next.isStripHovered ||
    prev.rankChange !== next.rankChange ||
    prev.onSelect !== next.onSelect ||
    prev.onHoverStart !== next.onHoverStart ||
    prev.onHoverEnd !== next.onHoverEnd ||
    prev.registerRef !== next.registerRef
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
    a.squawk === b.squawk
  );
});
