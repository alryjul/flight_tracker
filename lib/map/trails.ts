import type { GeoJSONSource } from "maplibre-gl";
import {
  BREADCRUMB_LEAD_TOLERANCE_MILES,
  MAX_BREADCRUMB_OVERLAP_MILES,
  MAX_PROVIDER_TO_BREADCRUMB_CONNECT_MILES,
  MAX_TRACK_TO_AIRCRAFT_MILES,
  SELECTED_TRACK_REFRESH_GRACE_MS
} from "@/lib/config/flight-map-constants";
import { getFlightProviderTimestampSec } from "@/lib/flights/identity";
import type { Flight } from "@/lib/flights/types";
import { distanceBetweenPointsMiles } from "@/lib/geo";
import { sanitizeCoordinateSequence } from "@/lib/map/geo-helpers";
import type {
  BreadcrumbPoint,
  FlightSnapshot,
  SelectedFlightDetailsResponse,
  SelectedTrackPoint
} from "@/lib/types/flight-map";

// Why: shared helper for both the legacy snapshot-derived breadcrumbs and the
// new persistent per-flight buffer. Sanitizes the coordinate sequence
// (dedup + teleport tolerance) and re-attaches the original timestamps.
export function sanitizeBreadcrumbPoints(rawPoints: BreadcrumbPoint[]) {
  if (rawPoints.length === 0) return [];

  const sanitizedCoordinates = sanitizeCoordinateSequence(
    rawPoints.map((point) => point.coordinate)
  );

  const pointsByCoordinate = new Map<string, BreadcrumbPoint["providerTimestampSec"]>();
  for (const point of rawPoints) {
    const key = `${point.coordinate[0]},${point.coordinate[1]}`;
    if (!pointsByCoordinate.has(key)) {
      pointsByCoordinate.set(key, point.providerTimestampSec);
    }
  }

  const breadcrumbs: BreadcrumbPoint[] = [];
  for (const coordinate of sanitizedCoordinates) {
    const key = `${coordinate[0]},${coordinate[1]}`;
    const providerTimestampSec = pointsByCoordinate.get(key);
    if (providerTimestampSec !== undefined) {
      breadcrumbs.push({ coordinate, providerTimestampSec });
    }
  }
  return breadcrumbs;
}

// Why: only filter by physical id (icao24). Callsign changes mid-session
// (Mode-S transponder updates, ATC re-coding) used to drop pre-change
// breadcrumbs from the trail even though they were the same physical
// aircraft. ICAO24 is permanent per airframe; the callsign is metadata.
export function getBreadcrumbPoints(snapshots: FlightSnapshot[], flightId: string) {
  const points = snapshots
    .map((snapshot) => snapshot.flightsById.get(flightId))
    .filter((flight): flight is Flight => flight != null)
    .map((flight) => ({
      coordinate: [flight.longitude, flight.latitude] as [number, number],
      providerTimestampSec: getFlightProviderTimestampSec(flight)
    }));

  return sanitizeBreadcrumbPoints(points);
}

type TrackSegment = [number, number][];

// Why: previously this function applied the `displayedProviderTimestampMs`
// (the playback aircraft's interpolated position-time) as an upper bound on
// every coordinate considered. In practice that culls AeroAPI track points
// captured between OpenSky polls — exactly the freshest segment users want
// to see — and causes the trail to flicker as animation progress crosses the
// boundary. The trail is the *historical record*; the icon is its own
// concern. They're allowed to disagree by a few seconds.
//
// Pipeline:
//   1. Sanitize provider track points (drop teleports, dedupe).
//   2. Filter breadcrumbs collected client-side (cap, lead-projection,
//      provider-overlap dedup).
//   3. Decide topology: if the provider tail is close enough to the
//      breadcrumb head, merge into one segment. Otherwise keep them as
//      two separate LineString segments (rendered as multiple features)
//      — avoids drawing a phantom 14-mi straight line through unverified
//      airspace when adsb.lol's trace is stale relative to the live icon.
//   4. Append the live (interpolated) aircraft position as the tail of the
//      LAST segment — but only when the trail's last data point is older
//      than the icon's playback time, otherwise we'd backtrack from a
//      fresh trail tip to a lagging icon position.
//
// Returns: `TrackSegment[]` — array of disjoint polylines. The renderer
// emits one LineString feature per segment.
export function getSanitizedTrackCoordinates(
  track: SelectedFlightDetailsResponse["details"] | null,
  breadcrumbPoints: BreadcrumbPoint[],
  renderedPosition: { latitude: number; longitude: number } | null,
  displayedProviderTimestampMs: number | null,
  iconHeadingDegrees: number | null
): TrackSegment[] {
  const providerTrack = track?.track ?? [];
  // Why: the trail tail can be marginally fresher than the animated icon's
  // playback position because the icon coasts off OpenSky/adsb.lol position
  // snapshots (with 4s polls + 2.5s extrapolation) while the trail comes
  // from adsb.lol's full trace which is updated near-real-time. Without
  // this filter the trail visibly leads the icon by a couple seconds — at
  // 500kt that's a few hundred meters, very noticeable. Drop trail points
  // newer than the icon's playback time so the trail tail aligns with
  // (or sits just behind) the icon. The icon-tail append below then
  // closes any small remaining gap.
  const renderableProviderTrack =
    displayedProviderTimestampMs == null
      ? providerTrack
      : providerTrack.filter((point) => {
          const pointMs = Date.parse(point.timestamp);
          return !Number.isFinite(pointMs) || pointMs <= displayedProviderTimestampMs;
        });
  const sanitizedCoordinates = sanitizeCoordinateSequence(
    renderableProviderTrack.map((point) => [point.longitude, point.latitude] as [number, number])
  );
  const lastProviderTrackTimestampMs = getLastTrackTimestampMs(renderableProviderTrack);
  const firstProviderTrackTimestampMs = getFirstTrackTimestampMs(renderableProviderTrack);

  let trailEndTimestampMs = lastProviderTrackTimestampMs;

  // Why: drop breadcrumbs whose timestamp falls WITHIN the provider track's
  // time range — they're duplicates of points the trace already renders,
  // just at slightly different lat/lon (different sampling cadences /
  // sources). Drawing both produces a visible ghost line parallel to the
  // real track. Breadcrumbs OUTSIDE the trace coverage (older than its
  // head, or newer than its tail) are kept — those fill the gaps.
  //
  // This subsumes the previous "only filter when AeroAPI" heuristic. For
  // sparse OpenSky tracks (short window near the current position),
  // breadcrumbs older than the trace head pass through and still provide
  // the historical trail. For comprehensive tracks (adsb.lol / AeroAPI),
  // the duplicates that caused the ghost line are dropped.
  function breadcrumbOverlapsProviderTrack(point: BreadcrumbPoint): boolean {
    if (
      point.providerTimestampSec == null ||
      firstProviderTrackTimestampMs == null ||
      lastProviderTrackTimestampMs == null
    ) {
      return false;
    }
    const breadcrumbMs = point.providerTimestampSec * 1000;
    return (
      breadcrumbMs >= firstProviderTrackTimestampMs &&
      breadcrumbMs <= lastProviderTrackTimestampMs
    );
  }

  // Why: the time-based cap below isn't enough on its own. For slow GA
  // traffic (~60kt) a breadcrumb appended the moment a poll lands has a
  // timestamp that *just barely* slips under the time-interpolated cap, so
  // the cap doesn't filter it — but the icon hasn't lerped to that position
  // yet, so the breadcrumb sits geographically AHEAD of the dot. This
  // position-based filter rejects breadcrumbs whose forward projection on
  // the icon's heading vector exceeds BREADCRUMB_LEAD_TOLERANCE_MILES,
  // closing the visual "trail leads dot" zigzag during the lerp.
  let breadcrumbLeadFilter:
    | ((point: BreadcrumbPoint) => boolean)
    | null = null;
  if (renderedPosition && iconHeadingDegrees != null) {
    const milesPerDegLat = 69.0;
    const milesPerDegLon =
      69.0 * Math.cos((renderedPosition.latitude * Math.PI) / 180);
    const headingRad = (iconHeadingDegrees * Math.PI) / 180;
    const sinHeading = Math.sin(headingRad);
    const cosHeading = Math.cos(headingRad);
    const iconLat = renderedPosition.latitude;
    const iconLon = renderedPosition.longitude;
    breadcrumbLeadFilter = (point) => {
      const dEastMiles = (point.coordinate[0] - iconLon) * milesPerDegLon;
      const dNorthMiles = (point.coordinate[1] - iconLat) * milesPerDegLat;
      const aheadMiles = dNorthMiles * cosHeading + dEastMiles * sinHeading;
      return aheadMiles <= BREADCRUMB_LEAD_TOLERANCE_MILES;
    };
  }

  // ----- Build provider segment + filter breadcrumbs -----
  const providerSegment: TrackSegment = sanitizedCoordinates;

  let breadcrumbCoordinates: TrackSegment = [];
  if (breadcrumbPoints.length > 0) {
    const eligibleBreadcrumbs = breadcrumbPoints.filter((point) => {
      // Cap breadcrumbs at the icon's playback time too, same reason as
      // the provider-track filter above: keep the trail from leading the
      // icon. Breadcrumbs accumulate from /api/flights polls so they're
      // typically only a few seconds older than the icon's playback time
      // anyway.
      if (
        displayedProviderTimestampMs != null &&
        point.providerTimestampSec != null &&
        point.providerTimestampSec * 1000 > displayedProviderTimestampMs
      ) {
        return false;
      }
      // Position-based "ahead of icon" filter — see the comment above the
      // breadcrumbLeadFilter block.
      if (breadcrumbLeadFilter && !breadcrumbLeadFilter(point)) {
        return false;
      }
      // Temporal-overlap filter — drop breadcrumbs already covered by the
      // provider track. See breadcrumbOverlapsProviderTrack above.
      if (breadcrumbOverlapsProviderTrack(point)) {
        return false;
      }
      return true;
    });
    breadcrumbCoordinates = eligibleBreadcrumbs.map((point) => point.coordinate);

    const latestBreadcrumbTimestampSec = eligibleBreadcrumbs.reduce<number | null>(
      (latest, point) =>
        point.providerTimestampSec != null && (latest == null || point.providerTimestampSec > latest)
          ? point.providerTimestampSec
          : latest,
      null
    );
    if (latestBreadcrumbTimestampSec != null) {
      const breadcrumbMs = latestBreadcrumbTimestampSec * 1000;
      trailEndTimestampMs =
        trailEndTimestampMs == null ? breadcrumbMs : Math.max(trailEndTimestampMs, breadcrumbMs);
    }
  }

  // ----- Decide topology -----
  // Three cases:
  //   (1) Both provider segment and breadcrumbs have data.
  //       → Strip breadcrumb prefix that overlaps the provider tail.
  //         If the bridge gap is short, concatenate into one segment.
  //         If it's long, keep them as two disjoint segments.
  //   (2) Only one side has data → it's the only segment.
  //   (3) Neither has data → no segments.
  const segments: TrackSegment[] = [];
  if (providerSegment.length > 0 && breadcrumbCoordinates.length > 0) {
    const providerTail = providerSegment[providerSegment.length - 1]!;
    const trimmedBreadcrumbs: TrackSegment = [...breadcrumbCoordinates];

    // Strip breadcrumbs that overlap the provider tail (within rendering
    // tolerance) — avoids drawing a tiny zigzag at the join.
    while (trimmedBreadcrumbs.length > 0) {
      const head = trimmedBreadcrumbs[0]!;
      const dist = distanceBetweenPointsMiles({
        fromLatitude: providerTail[1],
        fromLongitude: providerTail[0],
        toLatitude: head[1],
        toLongitude: head[0]
      });
      if (dist > MAX_BREADCRUMB_OVERLAP_MILES) break;
      trimmedBreadcrumbs.shift();
    }

    const breadcrumbHead = trimmedBreadcrumbs[0];
    if (!breadcrumbHead) {
      // All breadcrumbs were overlap dupes; just use the provider segment.
      segments.push(providerSegment);
    } else {
      const connectorMiles = distanceBetweenPointsMiles({
        fromLatitude: providerTail[1],
        fromLongitude: providerTail[0],
        toLatitude: breadcrumbHead[1],
        toLongitude: breadcrumbHead[0]
      });
      if (connectorMiles <= MAX_PROVIDER_TO_BREADCRUMB_CONNECT_MILES) {
        // Bridge is short enough — merge into one continuous segment.
        segments.push([...providerSegment, ...trimmedBreadcrumbs]);
      } else {
        // Bridge is too long to draw a credible straight line. Keep them
        // as two separate polylines so the user sees both the historical
        // trail AND the live segment near the icon, without a phantom
        // line through unverified airspace.
        segments.push(providerSegment);
        segments.push(trimmedBreadcrumbs);
      }
    }
  } else if (providerSegment.length > 0) {
    segments.push(providerSegment);
  } else if (breadcrumbCoordinates.length > 0) {
    segments.push(breadcrumbCoordinates);
  }

  // ----- Append the icon as the tail of the LAST segment -----
  // Skip when the trail's last data point is fresher than the icon's
  // playback time (would draw a backwards segment from a fresh tip), or
  // when the gap is too wide (would draw a phantom long jump).
  if (renderedPosition) {
    const tailPoint: [number, number] = [
      renderedPosition.longitude,
      renderedPosition.latitude
    ];
    const trailIsAheadOfIcon =
      trailEndTimestampMs != null &&
      displayedProviderTimestampMs != null &&
      trailEndTimestampMs > displayedProviderTimestampMs;

    if (segments.length === 0) {
      // Only the icon — can't draw a line from a single point. Drop.
    } else if (!trailIsAheadOfIcon) {
      const lastSegment = segments[segments.length - 1]!;
      const lastCoordinate = lastSegment[lastSegment.length - 1]!;
      const tailSegmentMiles = distanceBetweenPointsMiles({
        fromLatitude: lastCoordinate[1],
        fromLongitude: lastCoordinate[0],
        toLatitude: tailPoint[1],
        toLongitude: tailPoint[0]
      });
      if (
        tailSegmentMiles <= MAX_TRACK_TO_AIRCRAFT_MILES &&
        (lastCoordinate[0] !== tailPoint[0] || lastCoordinate[1] !== tailPoint[1])
      ) {
        lastSegment.push(tailPoint);
      }
    }
  }

  // Drop any segments shorter than 2 points — can't render a line from one.
  return segments.filter((segment) => segment.length >= 2);
}

export function hashTrackSegments(segments: TrackSegment[]) {
  // Why: shape + per-segment head/tail/midpoint fingerprint. The midpoint
  // sample makes a false-collision astronomically rare — two trails with
  // identical heads, tails, and length would also need the same midpoint
  // coordinate to dedup to "no change."
  if (segments.length === 0) {
    return "0";
  }
  return segments
    .map((coords) => {
      if (coords.length === 0) return "e";
      const head = coords[0]!;
      const tail = coords[coords.length - 1]!;
      const mid = coords[Math.floor(coords.length / 2)]!;
      return `${coords.length}|${head[0]},${head[1]}|${mid[0]},${mid[1]}|${tail[0]},${tail[1]}`;
    })
    .join("/");
}

const trackSourceLastHashBySource = new WeakMap<GeoJSONSource, string>();

// Why: track the selection that's currently drawn on the source. When the
// user clicks a NEW flight, we want to clear the previous flight's trail
// (otherwise it visually persists under the new icon). But within the SAME
// selection, we want to preserve whatever was last drawn even if a recompute
// transiently produces fewer than 2 coordinates — that's how we avoid the
// flash-and-disappear pattern between click and fetch return.
const trackSourceLastSelectionId = new WeakMap<GeoJSONSource, string | null>();

export function setSelectedTrackSourceData(
  source: GeoJSONSource | undefined,
  selectionId: string | null,
  track: SelectedFlightDetailsResponse["details"] | null,
  breadcrumbPoints: BreadcrumbPoint[],
  renderedPosition: { latitude: number; longitude: number } | null,
  displayedProviderTimestampMs: number | null,
  iconHeadingDegrees: number | null
) {
  if (!source) {
    return;
  }

  const lastSelectionId = trackSourceLastSelectionId.get(source) ?? null;
  const isSelectionChange = lastSelectionId !== selectionId;

  const segments = getSanitizedTrackCoordinates(
    track,
    breadcrumbPoints,
    renderedPosition,
    displayedProviderTimestampMs,
    iconHeadingDegrees
  );

  // Within the same selection, refuse to wipe the trail: a transient empty
  // recompute (e.g., breadcrumbs collapsed to a single dedup'd point while
  // we wait for the fetch to land) shouldn't erase what was last drawn.
  if (segments.length === 0 && !isSelectionChange) {
    return;
  }

  const nextHash = hashTrackSegments(segments);
  if (
    !isSelectionChange &&
    trackSourceLastHashBySource.get(source) === nextHash
  ) {
    return;
  }
  trackSourceLastHashBySource.set(source, nextHash);
  trackSourceLastSelectionId.set(source, selectionId);

  source.setData({
    type: "FeatureCollection",
    features: segments.map((coordinates) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates
      },
      properties: {}
    }))
  });
}

export function clearSelectedTrackSource(source: GeoJSONSource | undefined) {
  if (!source) return;
  trackSourceLastHashBySource.set(source, "0");
  trackSourceLastSelectionId.set(source, null);
  source.setData({ type: "FeatureCollection", features: [] });
}

export function getLastTrackTimestampMs(track: SelectedTrackPoint[]) {
  const lastPoint = track[track.length - 1];

  if (!lastPoint) {
    return null;
  }

  const timestampMs = Date.parse(lastPoint.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

export function getFirstTrackTimestampMs(track: SelectedTrackPoint[]) {
  const firstPoint = track[0];

  if (!firstPoint) {
    return null;
  }

  const timestampMs = Date.parse(firstPoint.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

export function mergeSameFlightTrackHistory(
  currentTrack: SelectedTrackPoint[],
  nextTrack: SelectedTrackPoint[]
) {
  const nextFirstTimestampMs = getFirstTrackTimestampMs(nextTrack);

  if (nextFirstTimestampMs == null) {
    return nextTrack;
  }

  const historicalPrefix = currentTrack.filter((point) => {
    const timestampMs = Date.parse(point.timestamp);

    if (!Number.isFinite(timestampMs)) {
      return true;
    }

    return timestampMs < nextFirstTimestampMs;
  });

  const mergedTrack = [...historicalPrefix, ...nextTrack];
  const seenPointKeys = new Set<string>();

  return mergedTrack.filter((point) => {
    const pointKey = [
      point.timestamp,
      point.latitude.toFixed(6),
      point.longitude.toFixed(6)
    ].join("|");

    if (seenPointKeys.has(pointKey)) {
      return false;
    }

    seenPointKeys.add(pointKey);
    return true;
  });
}

export function resolveSelectedTrackRefresh(
  currentDetails: SelectedFlightDetailsResponse["details"] | null,
  nextDetails: SelectedFlightDetailsResponse["details"] | null,
  currentTrackFreshAtMs: number | null,
  nowMs: number
) {
  const currentTrack = currentDetails?.track ?? [];
  const nextTrack = nextDetails?.track ?? [];
  const currentHasTrustedProviderTrack =
    currentDetails?.faFlightId != null && currentTrack.length > 0;
  const nextHasTrustedProviderTrack =
    nextDetails?.faFlightId != null && nextTrack.length > 0;
  const sameFlight =
    currentDetails?.faFlightId != null &&
    nextDetails?.faFlightId != null &&
    currentDetails.faFlightId === nextDetails.faFlightId;
  const withinGrace =
    currentTrackFreshAtMs != null && nowMs - currentTrackFreshAtMs < SELECTED_TRACK_REFRESH_GRACE_MS;

  if (currentHasTrustedProviderTrack && !nextHasTrustedProviderTrack) {
    return {
      refreshedAtMs: currentTrackFreshAtMs,
      track: currentTrack
    };
  }

  if (!sameFlight) {
    return {
      refreshedAtMs: nextTrack.length > 0 ? nowMs : currentTrackFreshAtMs,
      track: nextTrack.length > 0 ? nextTrack : currentTrack
    };
  }

  if (nextTrack.length === 0) {
    return {
      refreshedAtMs: currentTrackFreshAtMs,
      track: withinGrace ? currentTrack : []
    };
  }

  if (currentTrack.length === 0) {
    return {
      refreshedAtMs: nowMs,
      track: nextTrack
    };
  }

  const currentLastTimestampMs = getLastTrackTimestampMs(currentTrack);
  const currentFirstTimestampMs = getFirstTrackTimestampMs(currentTrack);
  const nextLastTimestampMs = getLastTrackTimestampMs(nextTrack);
  const nextFirstTimestampMs = getFirstTrackTimestampMs(nextTrack);

  if (
    nextLastTimestampMs != null &&
    currentLastTimestampMs != null &&
    nextLastTimestampMs >= currentLastTimestampMs
  ) {
    const looksLikeTruncatedTail =
      nextTrack.length < currentTrack.length &&
      nextFirstTimestampMs != null &&
      currentFirstTimestampMs != null &&
      nextFirstTimestampMs > currentFirstTimestampMs;

    return {
      refreshedAtMs: nowMs,
      track: looksLikeTruncatedTail
        ? mergeSameFlightTrackHistory(currentTrack, nextTrack)
        : nextTrack
    };
  }

  return {
    refreshedAtMs: withinGrace ? currentTrackFreshAtMs : nowMs,
    track: withinGrace ? currentTrack : nextTrack
  };
}

export function mergeSelectedFlightDetailPayload(
  currentDetails: SelectedFlightDetailsResponse["details"] | null,
  nextDetails: SelectedFlightDetailsResponse["details"] | null,
  currentTrackFreshAtMs: number | null,
  nowMs: number
): {
  details: SelectedFlightDetailsResponse["details"] | null;
  trackFreshAtMs: number | null;
} {
  if (!currentDetails) {
    return {
      details: nextDetails,
      trackFreshAtMs: nextDetails?.track.length ? nowMs : currentTrackFreshAtMs
    };
  }

  if (!nextDetails) {
    return {
      details: currentDetails,
      trackFreshAtMs: currentTrackFreshAtMs
    };
  }

  const { refreshedAtMs, track } = resolveSelectedTrackRefresh(
    currentDetails,
    nextDetails,
    currentTrackFreshAtMs,
    nowMs
  );

  return {
    details: {
      aircraftType: nextDetails.aircraftType ?? currentDetails.aircraftType,
      airline: nextDetails.airline ?? currentDetails.airline,
      destination: nextDetails.destination ?? currentDetails.destination,
      faFlightId: nextDetails.faFlightId ?? currentDetails.faFlightId,
      flightNumber: nextDetails.flightNumber ?? currentDetails.flightNumber,
      origin: nextDetails.origin ?? currentDetails.origin,
      registration: nextDetails.registration ?? currentDetails.registration,
      registeredOwner: nextDetails.registeredOwner ?? currentDetails.registeredOwner,
      status: nextDetails.status ?? currentDetails.status,
      track
    },
    trackFreshAtMs: refreshedAtMs
  };
}

export function areTrackPointsEquivalent(left: SelectedTrackPoint[], right: SelectedTrackPoint[]) {
  return (
    left.length === right.length &&
    left.every((point, index) => {
      const other = right[index];

      return (
        other != null &&
        point.altitudeFeet === other.altitudeFeet &&
        point.groundspeedKnots === other.groundspeedKnots &&
        point.heading === other.heading &&
        point.latitude === other.latitude &&
        point.longitude === other.longitude &&
        point.timestamp === other.timestamp
      );
    })
  );
}

export function areSelectedFlightDetailsEquivalent(
  left: SelectedFlightDetailsResponse["details"] | null,
  right: SelectedFlightDetailsResponse["details"] | null
) {
  if (left === right) {
    return true;
  }

  if (left == null || right == null) {
    return false;
  }

  return (
    left.aircraftType === right.aircraftType &&
    left.airline === right.airline &&
    left.destination === right.destination &&
    left.faFlightId === right.faFlightId &&
    left.flightNumber === right.flightNumber &&
    left.origin === right.origin &&
    left.registration === right.registration &&
    left.registeredOwner === right.registeredOwner &&
    left.status === right.status &&
    areTrackPointsEquivalent(left.track, right.track)
  );
}
