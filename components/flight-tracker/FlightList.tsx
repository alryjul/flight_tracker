"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { Flight } from "@/lib/flights/types";
import { FlightListItem } from "./FlightListItem";

type FlightListProps = {
  flights: Flight[];
  selectedFlightId: string | null;
  hoveredStripFlightId: string | null;
  stripRankChanges: Record<string, number>;
  onSelectFlight: (id: string) => void;
  onHoverStart: (id: string) => void;
  onHoverEnd: (id: string) => void;
  registerStripRef: (id: string, node: HTMLButtonElement | null) => void;
};

export function FlightList({
  flights,
  selectedFlightId,
  hoveredStripFlightId,
  stripRankChanges,
  onSelectFlight,
  onHoverStart,
  onHoverEnd,
  registerStripRef
}: FlightListProps) {
  return (
    <ScrollArea className="min-h-0 flex-1 px-1">
      <div className="flex flex-col gap-1 pb-2">
        {flights.map((flight) => {
          const isSelected = flight.id === selectedFlightId;
          const isStripHovered = flight.id === hoveredStripFlightId;
          const rankChange = stripRankChanges[flight.id];
          // Why: pass parent callbacks directly + flight as the single object.
          // FlightListItem binds its own per-flight callbacks via useCallback so
          // the memoized child sees stable handler identity across renders.
          // Inline `() => onHoverStart(flight.id)` here would create new
          // function objects every render (50 items × 4 callbacks each),
          // defeating React.memo's prop comparison.
          return (
            <FlightListItem
              key={flight.id}
              flight={flight}
              isSelected={isSelected}
              isStripHovered={isStripHovered}
              rankChange={rankChange}
              onSelect={onSelectFlight}
              onHoverStart={onHoverStart}
              onHoverEnd={onHoverEnd}
              registerRef={registerStripRef}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
