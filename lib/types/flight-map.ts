import type { Flight } from "@/lib/flights/types";

export type FlightApiResponse = {
  center: {
    latitude: number;
    longitude: number;
  };
  flights: Flight[];
  radiusMiles: number;
  source: string;
};

export type HomeBaseCenter = {
  latitude: number;
  longitude: number;
};

export type SelectedFlightDetailsResponse = {
  details: {
    aircraftType: string | null;
    airline: string | null;
    destination: string | null;
    faFlightId: string | null;
    flightNumber: string | null;
    origin: string | null;
    registration: string | null;
    registeredOwner: string | null;
    status: string | null;
    // Schedule times — raw ISO 8601 strings from AeroAPI. Display
    // helpers pick the most current variant (actual > estimated >
    // scheduled) per side and format the label + time for the card.
    scheduledOut: string | null;
    estimatedOut: string | null;
    actualOut: string | null;
    scheduledIn: string | null;
    estimatedIn: string | null;
    actualIn: string | null;
    track: Array<{
      altitudeFeet: number | null;
      groundspeedKnots: number | null;
      heading: number | null;
      latitude: number;
      longitude: number;
      timestamp: string;
    }>;
  } | null;
  source: string;
};

export type HoveredFlightState = {
  flightId: string;
  left: number;
  top: number;
};

export type FlightSnapshot = {
  capturedAt: number;
  flights: Flight[];
  flightsById: Map<string, Flight>;
};

// Why: critically-damped spring chase. Each "chase episode" begins when a new
// reported position arrives — we capture the icon's current visual position
// as `from`, set `target` to the new reported position, and stamp
// `targetSetAt` with the current frame time. Between updates the rendered
// position evolves continuously toward target via
//   pos(t) = target + (from - target) × exp(-(t - targetSetAt) / SPRING_TAU_SEC)
// The cap timestamp follows the same recurrence with the same time constant
// (`fromProviderTimestampSec` chases `lastProviderTimestampSec`), keeping it
// in lockstep with the icon — that's the invariant that prevents the trail
// from leading the dot.
export type FlightAnimationState = {
  averageProviderDeltaSec: number | null;
  identityKey: string;

  // --- Position chase ---
  fromLatitude: number;
  fromLongitude: number;
  targetLatitude: number;
  targetLongitude: number;

  // --- Cap-timestamp chase (matched τ → matches lag dynamics) ---
  fromProviderTimestampSec: number | null;
  lastProviderTimestampSec: number | null;

  // --- Chase episode anchor ---
  // Frame time (performance.now base) when the current target was set.
  // All spring evaluations use elapsed = (frameTime - targetSetAt) / 1000.
  targetSetAt: number;

  // --- Auxiliary (heading/speed for trail filtering, breadcrumbs, debug) ---
  targetGroundspeedKnots: number | null;
  targetHeadingDegrees: number | null;
};

export type BreadcrumbPoint = {
  coordinate: [number, number];
  providerTimestampSec: number | null;
};

export type FlightBreadcrumbBuffer = {
  points: BreadcrumbPoint[];
  lastSeenAt: number;
};

export type SelectedTrackPoint = NonNullable<SelectedFlightDetailsResponse["details"]>["track"][number];

export type TrendDirection = "up" | "down" | null;

export type RememberedFlightMetadata = Partial<
  Pick<Flight, "aircraftType" | "registration" | "registeredOwner">
>;

export type IdentityScopedValue<T> = {
  identityKey: string;
  value: T;
};
