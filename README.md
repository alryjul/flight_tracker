# Flight Tracker

Ambient-style live flight tracker centered around West Hollywood, intended to show nearby aircraft in a calm map display rather than a dense ops dashboard.

## Stack

- Next.js
- TypeScript
- MapLibre GL
- OpenSky Network API for live positions
- ADSBdb for aircraft and route enrichment
- AeroAPI for selected-flight detail and track overlays

## Current behavior

- Centers the experience around an approximate West Hollywood location
- Shows a 25 mile airspace window
- Polls `/api/flights` every 8 seconds
- Uses mock flight data when OpenSky credentials are not configured
- Enriches live flights with cached ADSBdb lookups for registration, aircraft type, airline, and route when available
- Loads richer metadata and trajectory data for the selected aircraft from AeroAPI when `AEROAPI_KEY` is configured
- Renders a live map plus a compact list of aircraft details

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. In your OpenSky account page, create an API client and copy its `client_id` and `client_secret` into `.env.local`.
5. Run `npm run dev`.

Example `.env.local`:

```bash
OPENSKY_CLIENT_ID="your_client_id"
OPENSKY_CLIENT_SECRET="your_client_secret"
AEROAPI_KEY="your_aeroapi_key"
```

Legacy username/password variables are still accepted as a fallback in the code, but OpenSky's official REST docs now direct users to OAuth2 client credentials instead of Basic Auth.

If OpenSky credentials are missing, the app still works with animated mock flight data so the interface can be developed without a live feed.

## Notes

- OpenSky state vectors are enough for position and altitude, but richer metadata like aircraft type, origin, and destination may be partial or unavailable in v1.
- ADSBdb lookups are cached in memory by aircraft hex and callsign to avoid repeated lookups every poll cycle.
