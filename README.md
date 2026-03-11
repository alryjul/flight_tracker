# Flight Tracker

Ambient-style live flight tracker centered around West Hollywood, intended to show nearby aircraft in a calm map display rather than a dense ops dashboard.

## Stack

- Next.js
- TypeScript
- MapLibre GL
- OpenSky Network API for live positions
- ADSBdb for background aircraft enrichment in the live feed
- AeroAPI for cached commercial route metadata, selected-flight metadata, and track overlays

## Discovery Provider

The main nearby-aircraft feed is controlled by `FLIGHT_DISCOVERY_PROVIDER`:

- `auto`: behave like `opensky` for now
- `aeroapi`: force FlightAware AeroAPI for nearby-aircraft discovery
- `opensky`: force OpenSky for nearby-aircraft discovery

The normal path is now OpenSky for nearby-aircraft discovery, with AeroAPI reserved for selected-flight enrichment and tracks. The AeroAPI discovery prototype remains available behind `FLIGHT_DISCOVERY_PROVIDER="aeroapi"` if you want to test it again later.

## Current behavior

- Centers the experience around an approximate West Hollywood location
- Shows a 25 mile airspace window
- Polls `/api/flights` every 4 seconds
- Uses mock flight data when OpenSky credentials are not configured
- Uses cached ADSBdb metadata for nearby aircraft details like registration, owner, and type
- Uses AeroAPI as the primary source of truth for commercial airline/route metadata, with server-side caching and a paced top-10 background warm queue
- Reserves AeroAPI selected-flight lookups for richer active-card metadata and track overlays
- Loads richer selected-flight metadata and trajectory data from AeroAPI when `AEROAPI_KEY` is configured
- Renders a live map plus a compact list of aircraft details

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. In your OpenSky account page, create an API client and copy its `client_id` and `client_secret` into `.env.local`.
5. Run `npm run dev`.

Example `.env.local`:

```bash
FLIGHT_DISCOVERY_PROVIDER="opensky"
OPENSKY_CLIENT_ID="your_client_id"
OPENSKY_CLIENT_SECRET="your_client_secret"
AEROAPI_KEY="your_aeroapi_key"
```

Legacy username/password variables are still accepted as a fallback in the code, but OpenSky's official REST docs now direct users to OAuth2 client credentials instead of Basic Auth.

If OpenSky credentials are missing, the app still works with animated mock flight data so the interface can be developed without a live feed.

## Notes

- OpenSky state vectors are enough for position and altitude, but richer metadata like aircraft type, origin, and destination may be partial or unavailable in v1.
- ADSBdb lookups are cached in memory for aircraft details, and AeroAPI is cached separately for feed route metadata and selected-flight detail/track requests.
