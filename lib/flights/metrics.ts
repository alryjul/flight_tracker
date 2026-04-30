import type { Flight } from "@/lib/flights/types";
import type { FlightSnapshot, TrendDirection } from "@/lib/types/flight-map";
import { METRIC_TREND_LOOKBACK_MS, MIN_METRIC_TREND_POINTS } from "@/lib/config/flight-map-constants";
import { getLiveFlightIdentityKey } from "@/lib/flights/identity";

export function getMetricTrend(
  values: Array<number | null>,
  threshold: number
): TrendDirection {
  const meaningfulValues = values.filter((value): value is number => value != null);

  if (meaningfulValues.length < MIN_METRIC_TREND_POINTS) {
    return null;
  }

  const firstValue = meaningfulValues[0]!;
  const lastValue = meaningfulValues[meaningfulValues.length - 1]!;
  const netDelta = lastValue - firstValue;

  if (Math.abs(netDelta) < threshold) {
    return null;
  }

  const direction: TrendDirection = netDelta > 0 ? "up" : "down";
  const stepThreshold = Math.max(1, threshold * 0.3);
  let alignedSteps = 0;
  let opposingSteps = 0;

  for (let index = 1; index < meaningfulValues.length; index += 1) {
    const delta = meaningfulValues[index]! - meaningfulValues[index - 1]!;

    if (Math.abs(delta) < stepThreshold) {
      continue;
    }

    if (delta > 0) {
      if (direction === "up") {
        alignedSteps += 1;
      } else {
        opposingSteps += 1;
      }
    } else if (direction === "down") {
      alignedSteps += 1;
    } else {
      opposingSteps += 1;
    }
  }

  if (alignedSteps === 0) {
    return null;
  }

  return alignedSteps >= opposingSteps ? direction : null;
}

export function getFlightMetricHistory(
  snapshots: FlightSnapshot[],
  flight: Pick<Flight, "id" | "callsign">,
  getValue: (flight: Flight) => number | null
) {
  const identityKey = getLiveFlightIdentityKey(flight);
  const now = performance.now();

  return snapshots
    .filter((snapshot) => now - snapshot.capturedAt <= METRIC_TREND_LOOKBACK_MS)
    .map((snapshot) => snapshot.flightsById.get(flight.id))
    .filter(
      (snapshotFlight): snapshotFlight is Flight =>
        snapshotFlight != null && getLiveFlightIdentityKey(snapshotFlight) === identityKey
    )
    .map(getValue);
}
