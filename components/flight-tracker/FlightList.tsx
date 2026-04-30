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
          return (
            <FlightListItem
              key={flight.id}
              flight={flight}
              isSelected={isSelected}
              isStripHovered={isStripHovered}
              rankChange={rankChange}
              onSelect={() => onSelectFlight(flight.id)}
              onHoverStart={() => onHoverStart(flight.id)}
              onHoverEnd={() => onHoverEnd(flight.id)}
              buttonRef={(node) => registerStripRef(flight.id, node)}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
