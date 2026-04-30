"use client";

import { Badge } from "@/components/ui/badge";
import {
  getListSecondaryLeft,
  getPrimaryIdentifier,
  getStripRouteLabel
} from "@/lib/flights/display";
import type { Flight } from "@/lib/flights/types";
import { cn } from "@/lib/utils";

type FlightListItemProps = {
  flight: Flight;
  isSelected: boolean;
  isStripHovered: boolean;
  rankChange: number | undefined;
  onSelect: () => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
};

export function FlightListItem({
  flight,
  isSelected,
  isStripHovered,
  rankChange,
  onSelect,
  onHoverStart,
  onHoverEnd,
  buttonRef
}: FlightListItemProps) {
  return (
    <button
      className={cn(
        "group flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors",
        "border-sidebar-border bg-sidebar/40 hover:bg-sidebar-accent/60",
        isSelected &&
          "border-sidebar-primary bg-sidebar-accent text-sidebar-accent-foreground",
        isStripHovered && !isSelected && "border-sidebar-primary/40"
      )}
      onBlur={onHoverEnd}
      onClick={onSelect}
      onFocus={onHoverStart}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      ref={buttonRef}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="truncate text-sm font-semibold tabular-nums">
          {getPrimaryIdentifier(flight)}
        </strong>
        <span className="flex items-center gap-1.5">
          {rankChange ? (
            <span
              aria-label={rankChange > 0 ? "Moved closer" : "Moved farther"}
              className={cn(
                "text-[10px] font-medium",
                rankChange > 0 ? "text-emerald-500" : "text-muted-foreground"
              )}
              title={rankChange > 0 ? "Moved closer" : "Moved farther"}
            >
              {rankChange > 0 ? "↑" : "↓"}
            </span>
          ) : null}
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[9px] font-normal tabular-nums"
          >
            {flight.aircraftType ?? "UNK"}
          </Badge>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <span className="flex min-w-0 flex-col">
          <small className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Operator
          </small>
          <strong className="truncate font-medium">
            {getListSecondaryLeft(flight)}
          </strong>
        </span>
        <span className="flex min-w-0 flex-col">
          <small className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Route
          </small>
          <strong className="truncate font-medium tabular-nums">
            {getStripRouteLabel(flight)}
          </strong>
        </span>
      </div>
    </button>
  );
}
