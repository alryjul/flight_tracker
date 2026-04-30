import type { LngLatBoundsLike } from "maplibre-gl";
import { APP_CONFIG } from "@/lib/config";
import { PROXIMITY_RING_MILES } from "@/lib/config/flight-map-constants";
import {
  distanceBetweenPointsMiles,
  milesToLatitudeDelta,
  milesToLongitudeDelta
} from "@/lib/geo";
import { MAX_TRACK_SEGMENT_MILES } from "@/lib/config/flight-map-constants";
import type { Flight } from "@/lib/flights/types";
import type { HomeBaseCenter } from "@/lib/types/flight-map";

export function buildRingCoordinates(center: HomeBaseCenter, radiusMiles: number, steps = 72) {
  const coordinates: [number, number][] = [];

  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const latitudeOffset = Math.sin(angle) * milesToLatitudeDelta(radiusMiles);
    const longitudeOffset =
      Math.cos(angle) * milesToLongitudeDelta(radiusMiles, center.latitude + latitudeOffset);

    coordinates.push([center.longitude + longitudeOffset, center.latitude + latitudeOffset]);
  }

  return coordinates;
}

export function buildHomeBaseFeatures(center: HomeBaseCenter) {
  return {
    type: "FeatureCollection" as const,
    features: [
      ...PROXIMITY_RING_MILES.map((radiusMiles) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: buildRingCoordinates(center, radiusMiles)
        },
        properties: {
          radiusMiles
        }
      })),
      {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [center.longitude, center.latitude]
        },
        properties: {
          kind: "home-base"
        }
      }
    ]
  };
}

export function buildOpeningBounds(center: HomeBaseCenter, radiusMiles: number): LngLatBoundsLike {
  const openingRadiusMiles = Math.min(radiusMiles, APP_CONFIG.openingRadiusMiles);

  return [
    [
      center.longitude - milesToLongitudeDelta(openingRadiusMiles, center.latitude),
      center.latitude - milesToLatitudeDelta(openingRadiusMiles)
    ],
    [
      center.longitude + milesToLongitudeDelta(openingRadiusMiles, center.latitude),
      center.latitude + milesToLatitudeDelta(openingRadiusMiles)
    ]
  ];
}

export function getDistanceFromHomeBaseMiles(flight: Flight, center: HomeBaseCenter) {
  return distanceBetweenPointsMiles({
    fromLatitude: center.latitude,
    fromLongitude: center.longitude,
    toLatitude: flight.latitude,
    toLongitude: flight.longitude
  });
}

export function getDistanceFromHomeBaseCoordinates(
  latitude: number,
  longitude: number,
  center: HomeBaseCenter
) {
  return distanceBetweenPointsMiles({
    fromLatitude: center.latitude,
    fromLongitude: center.longitude,
    toLatitude: latitude,
    toLongitude: longitude
  });
}

export function formatDistanceMiles(distanceMiles: number) {
  return `${distanceMiles.toFixed(1)} mi`;
}

export function dedupeCoordinates(coordinates: [number, number][]) {
  return coordinates.filter((point, index, points) => {
    const previousPoint = points[index - 1];

    return previousPoint == null || previousPoint[0] !== point[0] || previousPoint[1] !== point[1];
  });
}

export function isValidTrackCoordinate(coordinate: [number, number]) {
  const [longitude, latitude] = coordinate;

  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

// Why: a single teleport point (antenna handoff, stale ICAO assignment,
// transient garbage) used to nuke the entire accumulated trail. Now we
// drop the bad point and keep going. Only after CONSECUTIVE_TELEPORTS_TO_RESET
// bad points in a row do we treat it as a real trajectory discontinuity
// (e.g., wraparound, ICAO reassigned to a flight halfway across the world).
const CONSECUTIVE_TELEPORTS_TO_RESET = 3;

export function sanitizeCoordinateSequence(coordinates: [number, number][]) {
  const dedupedCoordinates = dedupeCoordinates(coordinates.filter(isValidTrackCoordinate));
  const sanitizedCoordinates: [number, number][] = [];
  let consecutiveTeleports = 0;

  for (const coordinate of dedupedCoordinates) {
    const previousCoordinate = sanitizedCoordinates[sanitizedCoordinates.length - 1];

    if (!previousCoordinate) {
      sanitizedCoordinates.push(coordinate);
      consecutiveTeleports = 0;
      continue;
    }

    const segmentMiles = distanceBetweenPointsMiles({
      fromLatitude: previousCoordinate[1],
      fromLongitude: previousCoordinate[0],
      toLatitude: coordinate[1],
      toLongitude: coordinate[0]
    });
    const longitudeDelta = Math.abs(coordinate[0] - previousCoordinate[0]);
    const isTeleport = longitudeDelta > 120 || segmentMiles > MAX_TRACK_SEGMENT_MILES;

    if (isTeleport) {
      consecutiveTeleports += 1;
      if (consecutiveTeleports >= CONSECUTIVE_TELEPORTS_TO_RESET) {
        sanitizedCoordinates.length = 0;
        sanitizedCoordinates.push(coordinate);
        consecutiveTeleports = 0;
      }
      continue;
    }

    sanitizedCoordinates.push(coordinate);
    consecutiveTeleports = 0;
  }

  return sanitizedCoordinates;
}
