import {
  BOOTSTRAP_MAX_EXTRAPOLATION_SEC,
  PROVIDER_DELTA_EMA_DECAY,
  SPRING_TAU_SEC
} from "@/lib/config/flight-map-constants";
import { milesToLatitudeDelta, milesToLongitudeDelta } from "@/lib/geo";
import {
  getFlightPositionSnapshotKey,
  getFlightProviderTimestampSec,
  getLiveFlightIdentityKey
} from "@/lib/flights/identity";
import type { Flight } from "@/lib/flights/types";
import type {
  BreadcrumbPoint,
  FlightAnimationState
} from "@/lib/types/flight-map";

// Why: closed-form evaluation of the critically-damped spring at frameTime.
// Between target updates, the state's (from, target, targetSetAt) fully
// determines the chase; computing pos(t) doesn't require per-frame state
// mutation. This keeps rendering stateless and makes time-warping (eg. for
// debug snapshots) trivial.
export function computeSpringPosition(state: FlightAnimationState, frameTime: number) {
  const elapsedSec = Math.max(0, (frameTime - state.targetSetAt) / 1000);
  const factor = Math.exp(-elapsedSec / SPRING_TAU_SEC);
  return {
    latitude: state.targetLatitude + (state.fromLatitude - state.targetLatitude) * factor,
    longitude: state.targetLongitude + (state.fromLongitude - state.targetLongitude) * factor
  };
}

// Why: the cap timestamp chases lastProviderTimestampSec from
// fromProviderTimestampSec at the SAME τ as the position chase, so the icon
// position and the trail's time cap settle at the same lag. That invariant
// is what guarantees the trail never leads the dot.
export function computeSpringProviderTimestampSec(
  state: FlightAnimationState,
  frameTime: number
): number | null {
  if (state.lastProviderTimestampSec == null) return null;
  if (state.fromProviderTimestampSec == null) return state.lastProviderTimestampSec;
  const elapsedSec = Math.max(0, (frameTime - state.targetSetAt) / 1000);
  const factor = Math.exp(-elapsedSec / SPRING_TAU_SEC);
  return (
    state.lastProviderTimestampSec +
    (state.fromProviderTimestampSec - state.lastProviderTimestampSec) * factor
  );
}

export function getAnimatedPosition(
  animationState: FlightAnimationState | undefined,
  fallbackFlight: Flight,
  frameTime: number
) {
  if (!animationState) {
    return {
      latitude: fallbackFlight.latitude,
      longitude: fallbackFlight.longitude
    };
  }
  return computeSpringPosition(animationState, frameTime);
}

// Why: still useful for "is the chase essentially settled" gates (eg.
// breadcrumb-tail clipping, diagnostic logging). Returns 1 - factor so it
// reads "0 = just started chase episode, 1 = fully settled" — same
// semantic shape as the old animation progress, so call sites that gate on
// `progress >= 0.995` continue to mean "done chasing."
export function getAnimationProgress(animationState: FlightAnimationState | undefined, frameTime: number) {
  if (!animationState) {
    return 1;
  }
  const elapsedSec = Math.max(0, (frameTime - animationState.targetSetAt) / 1000);
  return 1 - Math.exp(-elapsedSec / SPRING_TAU_SEC);
}

// Why: EMA over poll intervals. Retained on the state for diagnostics and
// future adaptive-τ tuning. `null` sample preserves prior estimate;
// first-ever sample seeds the average without smoothing.
export function updateProviderDeltaEma(prev: number | null, sample: number | null) {
  if (sample == null) return prev;
  if (prev == null) return sample;
  return prev * PROVIDER_DELTA_EMA_DECAY + sample * (1 - PROVIDER_DELTA_EMA_DECAY);
}

export function getDisplayedProviderTimestampMs(
  animationState: FlightAnimationState | undefined,
  frameTime: number
) {
  const sec = animationState
    ? computeSpringProviderTimestampSec(animationState, frameTime)
    : null;
  return sec == null ? null : sec * 1000;
}

export function clipBreadcrumbCoordinatesToAnimation(
  points: BreadcrumbPoint[],
  animationState: FlightAnimationState | undefined,
  frameTime: number
) {
  if (points.length === 0 || !animationState) {
    return points;
  }

  const progress = getAnimationProgress(animationState, frameTime);

  if (progress >= 0.995) {
    return points;
  }

  const lastCoordinate = points[points.length - 1]?.coordinate;
  const targetCoordinate: [number, number] = [
    animationState.targetLongitude,
    animationState.targetLatitude
  ];

  if (!lastCoordinate) {
    return points;
  }

  if (lastCoordinate[0] === targetCoordinate[0] && lastCoordinate[1] === targetCoordinate[1]) {
    return points.slice(0, -1);
  }

  return points;
}

export function updateFlightAnimationStates(
  currentStates: Map<string, FlightAnimationState>,
  flights: Flight[],
  frameTime: number
) {
  const nextStates = new Map<string, FlightAnimationState>();

  for (const flight of flights) {
    const existingState = currentStates.get(flight.id);
    const identityKey = getLiveFlightIdentityKey(flight);
    const providerTimestampSec = getFlightProviderTimestampSec(flight);

    if (!existingState || existingState.identityKey !== identityKey) {
      // Fresh chase. Naively from = target = reported leaves the spring at
      // rest until the *next* poll lands ~4 s later, so on page load the
      // icons sit static for an awkward beat. Boost: extrapolate the
      // target forward by the data lag (now − provider timestamp) along
      // the reported heading × groundspeed. The spring then has somewhere
      // to chase from frame 1, producing immediate visible motion.
      // Strictly position-only — we keep `lastProviderTimestampSec` at the
      // actual reported time so the trail's cap doesn't lie about how
      // fresh our data is, preserving the trail-can't-lead-icon invariant.
      let bootstrapTargetLat = flight.latitude;
      let bootstrapTargetLon = flight.longitude;
      if (
        flight.headingDegrees != null &&
        flight.groundspeedKnots != null &&
        flight.groundspeedKnots > 0 &&
        flight.positionTimestampSec != null
      ) {
        const dataLagSec = Math.max(
          0,
          Math.min(BOOTSTRAP_MAX_EXTRAPOLATION_SEC, Date.now() / 1000 - flight.positionTimestampSec)
        );
        if (dataLagSec > 0) {
          const distanceMiles = flight.groundspeedKnots * 1.15078 * (dataLagSec / 3600);
          const headingRad = (flight.headingDegrees * Math.PI) / 180;
          bootstrapTargetLat =
            flight.latitude + milesToLatitudeDelta(Math.cos(headingRad) * distanceMiles);
          bootstrapTargetLon =
            flight.longitude +
            milesToLongitudeDelta(Math.sin(headingRad) * distanceMiles, flight.latitude);
        }
      }

      nextStates.set(flight.id, {
        averageProviderDeltaSec: null,
        fromLatitude: flight.latitude,
        fromLongitude: flight.longitude,
        identityKey,
        fromProviderTimestampSec: providerTimestampSec,
        lastProviderTimestampSec: providerTimestampSec,
        targetSetAt: frameTime,
        targetLatitude: bootstrapTargetLat,
        targetLongitude: bootstrapTargetLon,
        targetGroundspeedKnots: flight.groundspeedKnots,
        targetHeadingDegrees: flight.headingDegrees
      });
      continue;
    }

    // Provider timestamp didn't advance — no new info, keep the chase running.
    if (
      providerTimestampSec != null &&
      existingState.lastProviderTimestampSec != null &&
      providerTimestampSec <= existingState.lastProviderTimestampSec
    ) {
      nextStates.set(flight.id, existingState);
      continue;
    }

    const providerDeltaSec =
      providerTimestampSec != null && existingState.lastProviderTimestampSec != null
        ? providerTimestampSec - existingState.lastProviderTimestampSec
        : null;
    const averageProviderDeltaSec = updateProviderDeltaEma(
      existingState.averageProviderDeltaSec,
      providerDeltaSec
    );

    const targetUnchanged =
      getFlightPositionSnapshotKey({
        ...flight,
        latitude: existingState.targetLatitude,
        longitude: existingState.targetLongitude
      }) === getFlightPositionSnapshotKey(flight);

    if (targetUnchanged) {
      // Same position target, but the provider timestamp may have advanced
      // (deadband suppressed a small move; aircraft is hovering or parked).
      // We MUST re-anchor the cap-timestamp spring — leaving fromProviderT
      // and targetSetAt unchanged while bumping lastProviderT produces a
      // discontinuous jump in the cap of ~one poll-interval, breaking the
      // position/cap symmetry that prevents trail-leading-icon for any
      // hovering helicopter or parked aircraft.
      //
      // Re-anchoring both the position and the cap to the current frame
      // time keeps them in lockstep (same τ, same elapsed clock). Position
      // chase stays smooth because targetLat/Lon didn't change.
      const currentSpringPositionUnchanged = computeSpringPosition(
        existingState,
        frameTime
      );
      const currentSpringProviderTimestampSecUnchanged =
        computeSpringProviderTimestampSec(existingState, frameTime);

      nextStates.set(flight.id, {
        ...existingState,
        averageProviderDeltaSec,
        fromLatitude: currentSpringPositionUnchanged.latitude,
        fromLongitude: currentSpringPositionUnchanged.longitude,
        fromProviderTimestampSec: currentSpringProviderTimestampSecUnchanged,
        lastProviderTimestampSec: providerTimestampSec ?? existingState.lastProviderTimestampSec,
        targetSetAt: frameTime,
        targetGroundspeedKnots: flight.groundspeedKnots,
        targetHeadingDegrees: flight.headingDegrees
      });
      continue;
    }

    // New target. Capture the spring's current visual position as the new
    // chase start, then update target. Because we capture *exactly* where
    // the chase is right now, the spring continues smoothly through this
    // reset — no position discontinuity even when the target jumps. Same
    // for the cap timestamp.
    const currentSpringPosition = computeSpringPosition(existingState, frameTime);
    const currentSpringProviderTimestampSec = computeSpringProviderTimestampSec(
      existingState,
      frameTime
    );

    nextStates.set(flight.id, {
      averageProviderDeltaSec,
      fromLatitude: currentSpringPosition.latitude,
      fromLongitude: currentSpringPosition.longitude,
      identityKey,
      fromProviderTimestampSec: currentSpringProviderTimestampSec,
      lastProviderTimestampSec: providerTimestampSec ?? existingState.lastProviderTimestampSec,
      targetSetAt: frameTime,
      targetLatitude: flight.latitude,
      targetLongitude: flight.longitude,
      targetGroundspeedKnots: flight.groundspeedKnots,
      targetHeadingDegrees: flight.headingDegrees
    });
  }

  return nextStates;
}
