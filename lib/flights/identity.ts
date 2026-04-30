import type { Flight } from "@/lib/flights/types";
import type { IdentityScopedValue } from "@/lib/types/flight-map";

export function getLiveFlightIdentityKey(flight: Pick<Flight, "id" | "callsign">) {
  return `${flight.id}|${flight.callsign.trim().toUpperCase()}`;
}

export function getIdentityScopedValue<T>(
  scopedValue: IdentityScopedValue<T> | undefined,
  flight: Pick<Flight, "id" | "callsign">
) {
  if (!scopedValue) {
    return null;
  }

  return scopedValue.identityKey === getLiveFlightIdentityKey(flight) ? scopedValue.value : null;
}

export function getFlightPositionSnapshotKey(flight: Flight) {
  return `${flight.latitude.toFixed(5)}:${flight.longitude.toFixed(5)}`;
}

export function getFlightProviderTimestampSec(flight: Flight) {
  return flight.positionTimestampSec ?? flight.lastContactTimestampSec ?? null;
}
