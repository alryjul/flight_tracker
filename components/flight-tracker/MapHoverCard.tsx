"use client";

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { getHoverSubtitle, getPrimaryIdentifier } from "@/lib/flights/display";
import type { Flight } from "@/lib/flights/types";
import type { HoveredFlightState } from "@/lib/types/flight-map";

type MapHoverCardProps = {
  hoveredFlight: HoveredFlightState | null;
  hoveredFlightDisplay: Flight | null;
};

function MapHoverCardImpl({ hoveredFlight, hoveredFlightDisplay }: MapHoverCardProps) {
  if (!hoveredFlight || !hoveredFlightDisplay) return null;
  return (
    <div
      className="pointer-events-none fixed z-20 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={{
        left: hoveredFlight.left,
        top: hoveredFlight.top,
        transform: "translate(8px, 8px)"
      }}
    >
      <div className="flex items-center gap-2">
        <strong className="tabular-nums">{getPrimaryIdentifier(hoveredFlightDisplay)}</strong>
        {hoveredFlightDisplay.aircraftType ? (
          <Badge
            variant="outline"
            className="px-1 py-0 text-[9px] font-normal tabular-nums"
          >
            {hoveredFlightDisplay.aircraftType}
          </Badge>
        ) : null}
      </div>
      <span className="text-muted-foreground">{getHoverSubtitle(hoveredFlightDisplay)}</span>
    </div>
  );
}

// Why: hoveredFlight changes only on map mouse moves (rare); the orchestrator
// re-renders on every poll. Default shallow compare skips the render when
// neither hoveredFlight nor hoveredFlightDisplay changed identity.
export const MapHoverCard = memo(MapHoverCardImpl);
