"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap } from "maplibre-gl";
import { APP_CONFIG } from "@/lib/config";
import {
  distanceBetweenPointsMiles,
  milesToLatitudeDelta,
  milesToLongitudeDelta
} from "@/lib/geo";
import type { Flight } from "@/lib/flights/types";

type FlightApiResponse = {
  center: {
    latitude: number;
    longitude: number;
  };
  flights: Flight[];
  radiusMiles: number;
  source: string;
};

type SelectedFlightDetailsResponse = {
  details: {
    aircraftType: string | null;
    airline: string | null;
    destination: string | null;
    faFlightId: string | null;
    flightNumber: string | null;
    origin: string | null;
    registration: string | null;
    status: string | null;
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

const OPENING_BOUNDS: LngLatBoundsLike = [
  [
    APP_CONFIG.center.longitude -
      milesToLongitudeDelta(APP_CONFIG.openingRadiusMiles, APP_CONFIG.center.latitude),
    APP_CONFIG.center.latitude - milesToLatitudeDelta(APP_CONFIG.openingRadiusMiles)
  ],
  [
    APP_CONFIG.center.longitude +
      milesToLongitudeDelta(APP_CONFIG.openingRadiusMiles, APP_CONFIG.center.latitude),
    APP_CONFIG.center.latitude + milesToLatitudeDelta(APP_CONFIG.openingRadiusMiles)
  ]
];

const refreshMs = 8000;
const PROXIMITY_RING_MILES = [3, 8];

function buildRingCoordinates(radiusMiles: number, steps = 72) {
  const coordinates: [number, number][] = [];

  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const latitudeOffset = Math.sin(angle) * milesToLatitudeDelta(radiusMiles);
    const longitudeOffset =
      Math.cos(angle) *
      milesToLongitudeDelta(radiusMiles, APP_CONFIG.center.latitude + latitudeOffset);

    coordinates.push([
      APP_CONFIG.center.longitude + longitudeOffset,
      APP_CONFIG.center.latitude + latitudeOffset
    ]);
  }

  return coordinates;
}

const HOME_BASE_FEATURES = {
  type: "FeatureCollection" as const,
  features: [
    ...PROXIMITY_RING_MILES.map((radiusMiles) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: buildRingCoordinates(radiusMiles)
      },
      properties: {
        radiusMiles
      }
    })),
    {
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [APP_CONFIG.center.longitude, APP_CONFIG.center.latitude]
      },
      properties: {
        kind: "home-base"
      }
    }
  ]
};

function getPrimaryIdentifier(flight: Flight) {
  return flight.flightNumber ?? flight.registration ?? flight.callsign;
}

function getIdentifierLabel(flight: Flight) {
  if (flight.flightNumber) {
    return "Flight";
  }

  if (flight.registration) {
    return "Registration";
  }

  return "Callsign";
}

function getSecondaryIdentifier(flight: Flight) {
  if (flight.flightNumber) {
    return flight.callsign;
  }

  if (flight.registration && flight.callsign !== flight.registration) {
    return flight.callsign;
  }

  return null;
}

function getRouteLabel(flight: Flight) {
  if (flight.origin && flight.destination) {
    return `${flight.origin} to ${flight.destination}`;
  }

  if (flight.origin) {
    return `From ${flight.origin}`;
  }

  if (flight.destination) {
    return `To ${flight.destination}`;
  }

  return null;
}

function getOperatorLabel(flight: Flight) {
  return flight.airline ?? flight.registeredOwner ?? null;
}

function getListSecondaryLeft(flight: Flight) {
  return getOperatorLabel(flight) ?? flight.callsign;
}

function getListSecondaryRight(flight: Flight) {
  return getRouteLabel(flight) ?? flight.aircraftType ?? formatAltitude(flight.altitudeFeet);
}

function formatAltitude(altitudeFeet: number | null) {
  return altitudeFeet == null ? "Altitude unknown" : `${altitudeFeet.toLocaleString()} ft`;
}

function getDistanceFromHomeBaseMiles(flight: Flight) {
  return distanceBetweenPointsMiles({
    fromLatitude: APP_CONFIG.center.latitude,
    fromLongitude: APP_CONFIG.center.longitude,
    toLatitude: flight.latitude,
    toLongitude: flight.longitude
  });
}

function getDistanceFromHomeBaseCoordinates(latitude: number, longitude: number) {
  return distanceBetweenPointsMiles({
    fromLatitude: APP_CONFIG.center.latitude,
    fromLongitude: APP_CONFIG.center.longitude,
    toLatitude: latitude,
    toLongitude: longitude
  });
}

function formatDistanceMiles(distanceMiles: number) {
  return `${distanceMiles.toFixed(1)} mi`;
}

function dedupeCoordinates(coordinates: [number, number][]) {
  return coordinates.filter((point, index, points) => {
    const previousPoint = points[index - 1];

    return previousPoint == null || previousPoint[0] !== point[0] || previousPoint[1] !== point[1];
  });
}

function setSelectedTrackSourceData(
  source: GeoJSONSource | undefined,
  track: SelectedFlightDetailsResponse["details"] | null,
  renderedPosition: { latitude: number; longitude: number } | null
) {
  if (!source) {
    return;
  }

  const coordinates = dedupeCoordinates(
    track?.track.map((point) => [point.longitude, point.latitude] as [number, number]) ?? []
  );

  if (renderedPosition) {
    const tailPoint: [number, number] = [renderedPosition.longitude, renderedPosition.latitude];
    const lastPoint = coordinates[coordinates.length - 1];

    if (lastPoint == null || lastPoint[0] !== tailPoint[0] || lastPoint[1] !== tailPoint[1]) {
      coordinates.push(tailPoint);
    }
  }

  source.setData({
    type: "FeatureCollection",
    features:
      coordinates.length >= 2
        ? [
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates
              },
              properties: {}
            }
          ]
        : []
  });
}

function projectFlightPosition(
  flight: Pick<Flight, "groundspeedKnots" | "headingDegrees" | "latitude" | "longitude">,
  seconds: number
) {
  if (flight.groundspeedKnots == null || flight.headingDegrees == null || seconds <= 0) {
    return {
      latitude: flight.latitude,
      longitude: flight.longitude
    };
  }

  const distanceMiles = flight.groundspeedKnots * 1.15078 * (seconds / 3600);
  const headingRadians = (flight.headingDegrees * Math.PI) / 180;
  const northSouthMiles = Math.cos(headingRadians) * distanceMiles;
  const eastWestMiles = Math.sin(headingRadians) * distanceMiles;
  const latitudeOffset = milesToLatitudeDelta(northSouthMiles);
  const longitudeOffset =
    eastWestMiles === 0
      ? 0
      : Math.sign(eastWestMiles) *
        milesToLongitudeDelta(Math.abs(eastWestMiles), flight.latitude + latitudeOffset);

  return {
    latitude: flight.latitude + latitudeOffset,
    longitude: flight.longitude + longitudeOffset
  };
}

function getRenderedPosition(
  flight: Flight,
  previousFlight: Flight | undefined,
  progress: number
) {
  if (!previousFlight) {
    return {
      latitude: flight.latitude,
      longitude: flight.longitude
    };
  }

  const clampedProgress = Math.min(progress, 1);
  const interpolatedLatitude =
    previousFlight.latitude + (flight.latitude - previousFlight.latitude) * clampedProgress;
  const interpolatedLongitude =
    previousFlight.longitude + (flight.longitude - previousFlight.longitude) * clampedProgress;

  if (progress <= 1) {
    return {
      latitude: interpolatedLatitude,
      longitude: interpolatedLongitude
    };
  }

  const projectedSeconds = Math.min((progress - 1) * (refreshMs / 1000), 2);

  return projectFlightPosition(
    {
      latitude: interpolatedLatitude,
      longitude: interpolatedLongitude,
      groundspeedKnots: flight.groundspeedKnots,
      headingDegrees: flight.headingDegrees
    },
    projectedSeconds
  );
}

export function FlightMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const previousFlightsRef = useRef<Map<string, Flight>>(new Map());
  const [flights, setFlights] = useState<Flight[]>([]);
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [selectedFlightDetails, setSelectedFlightDetails] =
    useState<SelectedFlightDetailsResponse["details"]>(null);
  const [dataSource, setDataSource] = useState<string>("loading");
  const [mapReady, setMapReady] = useState(false);
  const selectedFlightDetailsRef = useRef<SelectedFlightDetailsResponse["details"]>(null);
  const selectedFlight =
    flights.find((flight) => flight.id === selectedFlightId) ?? flights[0] ?? null;
  const selectedFlightRequestKey = selectedFlight
    ? [
        selectedFlight.id,
        selectedFlight.callsign,
        selectedFlight.flightNumber ?? "",
        selectedFlight.registration ?? ""
      ].join("|")
    : null;
  const selectedFlightRequest = useMemo(
    () =>
      selectedFlight == null
        ? null
        : {
            id: selectedFlight.id,
            callsign: selectedFlight.callsign,
            flightNumber: selectedFlight.flightNumber,
            airline: selectedFlight.airline,
            aircraftType: selectedFlight.aircraftType,
            origin: selectedFlight.origin,
            destination: selectedFlight.destination,
            registration: selectedFlight.registration,
            registeredOwner: selectedFlight.registeredOwner
          },
    [selectedFlightRequestKey]
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      bounds: OPENING_BOUNDS,
      fitBoundsOptions: {
        padding: 40
      },
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.on("load", () => {
      setMapReady(true);

      map.addSource("home-base", {
        type: "geojson",
        data: HOME_BASE_FEATURES
      });

      map.addSource("flights", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });

      map.addSource("selected-track", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });

      map.addLayer({
        id: "home-rings",
        type: "line",
        source: "home-base",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "rgba(38, 84, 124, 0.25)",
          "line-width": [
            "match",
            ["get", "radiusMiles"],
            3,
            1.4,
            8,
            1.1,
            1
          ],
          "line-dasharray": [2, 3]
        }
      });

      map.addLayer({
        id: "home-base-point",
        type: "circle",
        source: "home-base",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 6,
          "circle-color": "#f4efe6",
          "circle-stroke-color": "#0f4c81",
          "circle-stroke-width": 3
        }
      });

      map.addLayer({
        id: "flight-points",
        type: "circle",
        source: "flights",
        paint: {
          "circle-radius": [
            "case",
            ["<=", ["get", "distanceMiles"], 3],
            8,
            ["<=", ["get", "distanceMiles"], 8],
            6.5,
            4.75
          ],
          "circle-color": [
            "case",
            ["<=", ["get", "distanceMiles"], 3],
            "#0f4c81",
            ["<=", ["get", "distanceMiles"], 8],
            "#3a6f98",
            "#7895ad"
          ],
          "circle-opacity": [
            "case",
            ["<=", ["get", "distanceMiles"], 3],
            0.95,
            ["<=", ["get", "distanceMiles"], 8],
            0.82,
            0.62
          ],
          "circle-stroke-color": "#f4efe6",
          "circle-stroke-width": [
            "case",
            ["get", "isPriority"],
            2.6,
            1.8
          ]
        }
      });

      map.addLayer({
        id: "selected-flight-halo",
        type: "circle",
        source: "flights",
        filter: ["==", ["get", "isSelected"], true],
        paint: {
          "circle-radius": 18,
          "circle-color": "rgba(15, 76, 129, 0.12)",
          "circle-stroke-color": "rgba(15, 76, 129, 0.38)",
          "circle-stroke-width": 2.5
        }
      });

      map.addLayer({
        id: "selected-flight-marker",
        type: "circle",
        source: "flights",
        filter: ["==", ["get", "isSelected"], true],
        paint: {
          "circle-radius": 9.5,
          "circle-color": "#f07f4f",
          "circle-opacity": 1,
          "circle-stroke-color": "#fff9f2",
          "circle-stroke-width": 3
        }
      });

      map.addLayer({
        id: "selected-track-line",
        type: "line",
        source: "selected-track",
        paint: {
          "line-color": "rgba(15, 76, 129, 0.5)",
          "line-width": 2.5
        }
      });

      map.addLayer({
        id: "flight-labels",
        type: "symbol",
        source: "flights",
        layout: {
          "text-field": ["case", ["get", "showLabel"], ["get", "label"], ""],
          "text-size": [
            "case",
            ["get", "isSelected"],
            12,
            ["get", "isPriority"],
            11,
            10
          ],
          "text-font": ["Noto Sans Regular"],
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": false
        },
        paint: {
          "text-color": [
            "case",
            ["get", "isSelected"],
            "#9f4316",
            "#17324d"
          ],
          "text-halo-color": "rgba(255,255,255,0.92)",
          "text-halo-width": [
            "case",
            ["get", "isSelected"],
            1.8,
            1.2
          ]
        }
      });

      map.on("click", "flight-points", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;

        if (typeof id === "string") {
          setSelectedFlightId(id);
        }
      });

      map.on("mouseenter", "flight-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "flight-points", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    mapRef.current = map;

    return () => {
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadFlights() {
      const response = await fetch("/api/flights", { cache: "no-store" });
      const data = (await response.json()) as FlightApiResponse;

      if (cancelled) {
        return;
      }

      const sortedFlights = [...data.flights].sort(
        (left, right) =>
          getDistanceFromHomeBaseMiles(left) - getDistanceFromHomeBaseMiles(right)
      );

      setFlights(sortedFlights);
      setDataSource(data.source);
      setSelectedFlightId((currentId) => {
        if (currentId && sortedFlights.some((flight) => flight.id === currentId)) {
          return currentId;
        }

        return sortedFlights[0]?.id ?? null;
      });
    }

    void loadFlights();
    const intervalId = window.setInterval(() => {
      void loadFlights();
    }, refreshMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedFlightRequest) {
      setSelectedFlightDetails(null);
      return;
    }

    let cancelled = false;
    setSelectedFlightDetails(null);
    const searchParams = new URLSearchParams({
      id: selectedFlightRequest.id,
      callsign: selectedFlightRequest.callsign
    });

    if (selectedFlightRequest.flightNumber) {
      searchParams.set("flightNumber", selectedFlightRequest.flightNumber);
    }

    if (selectedFlightRequest.airline) {
      searchParams.set("airline", selectedFlightRequest.airline);
    }

    if (selectedFlightRequest.aircraftType) {
      searchParams.set("aircraftType", selectedFlightRequest.aircraftType);
    }

    if (selectedFlightRequest.origin) {
      searchParams.set("origin", selectedFlightRequest.origin);
    }

    if (selectedFlightRequest.destination) {
      searchParams.set("destination", selectedFlightRequest.destination);
    }

    if (selectedFlightRequest.registration) {
      searchParams.set("registration", selectedFlightRequest.registration);
    }

    if (selectedFlightRequest.registeredOwner) {
      searchParams.set("registeredOwner", selectedFlightRequest.registeredOwner);
    }

    async function loadSelectedFlightDetails() {
      const response = await fetch(`/api/flights/selected?${searchParams.toString()}`, {
        cache: "no-store"
      });
      const data = (await response.json()) as SelectedFlightDetailsResponse;

      if (!cancelled) {
        setSelectedFlightDetails(data.details);
      }
    }

    void loadSelectedFlightDetails();

    return () => {
      cancelled = true;
    };
  }, [selectedFlightRequest, selectedFlightRequestKey]);

  useEffect(() => {
    selectedFlightDetailsRef.current = selectedFlightDetails;
  }, [selectedFlightDetails]);

  useEffect(() => {
    const source = mapRef.current?.getSource("flights") as GeoJSONSource | undefined;

    if (!source) {
      return;
    }

    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const previousFlights = previousFlightsRef.current;
    const nextFlights = new Map(flights.map((flight) => [flight.id, flight]));
    const animationStart = performance.now();
    const flightSource = source;
    const trackSource = mapRef.current?.getSource("selected-track") as GeoJSONSource | undefined;

    function renderFrame(frameTime: number) {
      const progress = (frameTime - animationStart) / refreshMs;
      let selectedRenderedPosition: { latitude: number; longitude: number } | null = null;

      flightSource.setData({
        type: "FeatureCollection",
        features: flights.map((flight, index) => {
          const renderedPosition = getRenderedPosition(
            flight,
            previousFlights.get(flight.id),
            progress
          );
          const distanceMiles = getDistanceFromHomeBaseCoordinates(
            renderedPosition.latitude,
            renderedPosition.longitude
          );

          if (flight.id === selectedFlightId) {
            selectedRenderedPosition = renderedPosition;
          }

          return {
            type: "Feature" as const,
            geometry: {
              type: "Point" as const,
              coordinates: [renderedPosition.longitude, renderedPosition.latitude]
            },
            properties: {
              id: flight.id,
              distanceMiles,
              isPriority: index < 3,
              isSelected: flight.id === selectedFlightId,
              label: flight.flightNumber ?? flight.callsign,
              showLabel: index < 3 || flight.id === selectedFlightId
            }
          };
        })
      });

      setSelectedTrackSourceData(
        trackSource,
        selectedFlightDetailsRef.current,
        selectedRenderedPosition
      );

      animationFrameRef.current = requestAnimationFrame(renderFrame);
    }

    previousFlightsRef.current = nextFlights;
    animationFrameRef.current = requestAnimationFrame(renderFrame);

    return () => {
      if (animationFrameRef.current != null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [flights, mapReady, selectedFlightId]);

  useEffect(() => {
    const source = mapRef.current?.getSource("selected-track") as GeoJSONSource | undefined;

    setSelectedTrackSourceData(
      source,
      selectedFlightDetails,
      selectedFlight == null
        ? null
        : {
            latitude: selectedFlight.latitude,
            longitude: selectedFlight.longitude
          }
    );
  }, [mapReady, selectedFlight, selectedFlightDetails]);

  const selectedFlightDisplay =
    selectedFlight == null
      ? null
      : {
          ...selectedFlight,
          aircraftType: selectedFlightDetails?.aircraftType ?? selectedFlight.aircraftType,
          airline: selectedFlightDetails?.airline ?? selectedFlight.airline,
          destination: selectedFlightDetails?.destination ?? selectedFlight.destination,
          flightNumber: selectedFlightDetails?.flightNumber ?? selectedFlight.flightNumber,
          origin: selectedFlightDetails?.origin ?? selectedFlight.origin,
          registration: selectedFlightDetails?.registration ?? selectedFlight.registration
        };
  const nearestFlight = flights[0] ?? null;

  return (
    <section className="tracker-panel">
      <div className="map-panel">
        <div className="map-frame" ref={containerRef} />
        <div className="map-overlay bottom-left compact">
          <div className="map-overlay-row">
            <span className="map-overlay-label">Focus</span>
            <strong>{APP_CONFIG.radiusMiles} mi</strong>
          </div>
          <div className="map-overlay-row">
            <span className="map-overlay-label">Source</span>
            <strong>{dataSource}</strong>
          </div>
        </div>
      </div>

      <aside className="flight-card-stack">
        <div className="stack-header">
          <p className="eyebrow">Current Aircraft</p>
          <h2>{flights.length} flights in view</h2>
          {nearestFlight ? (
            <div className="nearest-chip">
              <span className="nearest-chip-label">Nearest now</span>
              <strong>{getPrimaryIdentifier(nearestFlight)}</strong>
              <small>{formatDistanceMiles(getDistanceFromHomeBaseMiles(nearestFlight))}</small>
            </div>
          ) : null}
        </div>

        {selectedFlightDisplay ? (
          <article className="featured-card atc-card">
            <div className="featured-header atc-header">
              <div>
                <p className="feature-label">{getIdentifierLabel(selectedFlightDisplay)}</p>
                <h3>{getPrimaryIdentifier(selectedFlightDisplay)}</h3>
                {getSecondaryIdentifier(selectedFlightDisplay) ? (
                  <p className="secondary-identifier">
                    {getSecondaryIdentifier(selectedFlightDisplay)}
                  </p>
                ) : null}
              </div>
              <div className="atc-badges">
                <span className="badge">
                  {selectedFlightDisplay.aircraftType ?? "Unknown type"}
                </span>
                {selectedFlightDetails?.status ? (
                  <span className="badge badge-live">{selectedFlightDetails.status}</span>
                ) : null}
              </div>
            </div>
            <dl className="flight-details atc-grid">
              {getOperatorLabel(selectedFlightDisplay) ? (
                <div className="atc-cell span-2">
                  <dt>{selectedFlightDisplay.flightNumber ? "Airline" : "Operator"}</dt>
                  <dd>{getOperatorLabel(selectedFlightDisplay)}</dd>
                </div>
              ) : null}
              {selectedFlightDisplay.registration &&
              getPrimaryIdentifier(selectedFlightDisplay) !== selectedFlightDisplay.registration ? (
                <div className="atc-cell">
                  <dt>Registration</dt>
                  <dd>{selectedFlightDisplay.registration}</dd>
                </div>
              ) : null}
              {getRouteLabel(selectedFlightDisplay) ? (
                <div className="atc-cell span-2">
                  <dt>Route</dt>
                  <dd>{getRouteLabel(selectedFlightDisplay)}</dd>
                </div>
              ) : null}
              {selectedFlightDisplay.registeredOwner &&
              selectedFlightDisplay.registeredOwner !== getOperatorLabel(selectedFlightDisplay) ? (
                <div className="atc-cell span-2">
                  <dt>Owner</dt>
                  <dd>{selectedFlightDisplay.registeredOwner}</dd>
                </div>
              ) : null}
              <div className="atc-cell">
                <dt>Distance</dt>
                <dd>{formatDistanceMiles(getDistanceFromHomeBaseMiles(selectedFlightDisplay))}</dd>
              </div>
              <div className="atc-cell">
                <dt>Altitude</dt>
                <dd>{formatAltitude(selectedFlightDisplay.altitudeFeet)}</dd>
              </div>
            </dl>
          </article>
        ) : null}

        <div className="flight-list">
          {flights.map((flight) => (
            <button
              className={`flight-list-item ${
                flight.id === selectedFlight?.id ? "active" : ""
              }`}
              key={flight.id}
              onClick={() => setSelectedFlightId(flight.id)}
              type="button"
            >
              <span>
                <strong>{getPrimaryIdentifier(flight)}</strong>
                <small>
                  {getListSecondaryLeft(flight)} ·{" "}
                  {formatDistanceMiles(getDistanceFromHomeBaseMiles(flight))}
                </small>
              </span>
              <span>
                <strong>{flight.aircraftType ?? "Aircraft"}</strong>
                <small>{getListSecondaryRight(flight)}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}
