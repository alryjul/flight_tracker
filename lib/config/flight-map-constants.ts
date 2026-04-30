export const refreshMs = 4000;
export const HIDDEN_TAB_REFRESH_MS = 30_000;
export const PROXIMITY_RING_MILES = [3, 8];
export const HOME_BASE_STORAGE_KEY = "flight-tracker-home-base";
export const VISIBLE_FLIGHT_LIMIT = 50;
export const VISIBLE_FLIGHT_ENTRY_COUNT = 45;
// Why: bumping the exit rank from 60 → 80 widens the hysteresis band a
// flight has to cross before it gets retracted. Combined with the score's
// hard horizons (which prevent far-away GA from competing for top-50 slots
// at all), this leaves the visible set very stable over time.
export const VISIBLE_FLIGHT_EXIT_RANK = 80;
// Why: 60 s linger means a flight that just slipped past the exit rank
// hangs around long enough for a couple of polls to confirm or refute the
// drop, masking any remaining single-poll score jitter.
export const VISIBLE_FLIGHT_LINGER_MS = 1000 * 60;

// Why: ranking tier model lives in lib/flights/scoring.ts so the server
// (discovery slice) and client (visible-flight rank) never drift apart.
// See that module for the full tier semantics + tuning rationale.
export const STRIP_REORDER_INTERVAL_MS = 24000;
export const STRIP_REORDER_RANK_THRESHOLD = 2;
export const STRIP_REORDER_SCORE_THRESHOLD = 1.25;
export const STRIP_RANK_CUE_MS = 2200;
export const SNAPSHOT_HISTORY_RETENTION_MS = refreshMs * 18;
// Why: snapshot history is pruned aggressively (72s) because it drives
// animation interpolation and per-poll change detection — it doesn't need
// long memory. But the *selected flight's* breadcrumb trail benefits from
// far more history: a hovering GA helicopter watched for 20 minutes should
// still show its flight path, not just the last 72s. The per-flight buffer
// below is independent of the snapshot pruning.
export const FLIGHT_BREADCRUMB_BUFFER_MAX_POINTS = 600;
export const FLIGHT_BREADCRUMB_BUFFER_RETENTION_MS = 1000 * 60 * 30;
// Why: a gap larger than this in a per-flight breadcrumb buffer is a
// strong signal of a landing → ramp time → takeoff sequence (the aircraft
// stops transmitting on the ground for many minutes). When that happens
// the prior leg's breadcrumbs would otherwise paint a connecting line
// from the old leg's last position to the new leg's start. Wipe the
// buffer so each leg's breadcrumbs are independent. Mirrors adsb.lol's
// isolateCurrentLeg threshold.
export const BREADCRUMB_LEG_BREAK_GAP_MS = 1000 * 60 * 15;
export const SELECTED_TRACK_REFRESH_GRACE_MS = 1000 * 30;
export const MAX_TRACK_SEGMENT_MILES = 320;
export const MAX_TRACK_TO_AIRCRAFT_MILES = 2.5;
// Why: the bridge connects the trace tail to the first live breadcrumb
// when the temporal-overlap filter has already dropped breadcrumbs the
// trace covers. In nominal operation that gap is small (just past the
// trace's ~1 min lag with adsb.lol full+recent merged). In edge cases —
// brief feeder coverage holes, very fast aircraft, late selection — the
// gap can stretch. We prefer a continuous visual line over a disjoint
// for any plausible same-flight gap, only refusing to bridge when the
// distance is so extreme the data is almost certainly corrupted (e.g.,
// stale trace from a previous flight bleeding through). 100 mi covers
// ~12 min of jet cruise or ~50 min of helicopter — comfortably past
// realistic coverage holes, comfortably short of mistaken-flight
// territory.
export const MAX_PROVIDER_TO_BREADCRUMB_CONNECT_MILES = 100;
export const MIN_POSITION_CHANGE_MILES = 0.03;
export const MAX_POSITION_JITTER_DEADBAND_MILES = 0.12;
// Why: critically-damped spring time constant for the icon-position chase.
// The rendered icon evolves toward the latest reported position via
//   pos += (target - pos) × (1 - exp(-dt / τ))
// In steady-state linear motion with poll interval P, the icon's lag behind
// the *latest reported position* settles at
//   L* = P × τ_avg / (1 - exp(-P/τ))
// which for our P ≈ 4s polls gives ~10 s of icon-lag at τ = 8 s. The cap
// timestamp uses the same τ so trail and icon move in lockstep — that's
// the invariant that prevents the trail from leading the dot.
//
// Tuning intuition: bigger τ = laxer chase = more lag, more glide.
// Smaller τ = stiffer chase = less lag, more reactive (visible "snaps" on
// turns at very small τ). 6 s is the "ambient buttery glide" sweet spot.
export const SPRING_TAU_SEC = 8;
// Why: on page load (or when a flight first enters the viewport), the
// spring has nowhere to chase if from = target — icons sit static until the
// next poll lands. We bootstrap by extrapolating the target forward by
// the reported data lag (now − provider timestamp) along the reported
// heading × groundspeed, giving the spring an immediate target to chase.
// Capped because positionTimestampSec can be unreliable for stale or
// outlier reports — 10 s is a generous ceiling that still bounds visible
// "wrong direction" extrapolation if heading happens to be wrong.
export const BOOTSTRAP_MAX_EXTRAPOLATION_SEC = 10;
// Why: tuning factors used in two or more places. Naming them (a) makes the
// intent obvious at the call site and (b) prevents the values drifting apart
// when one spot gets tweaked.
//
// PROVIDER_DELTA_EMA_DECAY: the new sample's weight is (1 - decay). Larger
//   decay = slower to react to changing poll cadence. 0.65 gives ~3 polls
//   of effective averaging. Used by the diagnostic and could be useful if
//   we ever want τ to adapt to actual poll cadence.
//
// DEADBAND_FRACTION_OF_EXPECTED_MOVE: tiny moves below this fraction of
//   the expected per-poll move are treated as jitter and suppressed. 0.25
//   = a quarter of expected move, which is small enough to keep the icon
//   visibly responsive yet kills GPS noise on parked aircraft.
export const PROVIDER_DELTA_EMA_DECAY = 0.65;
export const DEADBAND_FRACTION_OF_EXPECTED_MOVE = 0.25;
export const ALTITUDE_TREND_THRESHOLD_FEET = 100;
export const AIRSPEED_TREND_THRESHOLD_KNOTS = 5;
export const METRIC_TREND_LOOKBACK_MS = 1000 * 30;
export const MIN_METRIC_TREND_POINTS = 3;
export const SELECTED_ENRICHMENT_RETRY_DELAYS_MS = [6000, 18000, 36000];
export const STRIP_HOVER_ECHO_DURATION_MS = 1400;
export const STRIP_HOVER_ECHO_BASE_RADIUS = 13;
export const STRIP_HOVER_ECHO_GROWTH = 14;
export const MAX_BREADCRUMB_OVERLAP_MILES = 0.18;
// Why: when a new poll lands the breadcrumb is appended at the freshly
// reported provider position INSTANTLY, while the icon starts a multi-second
// lerp from its previous rendered position toward that same target. During
// the lerp the breadcrumb sits at a position the icon hasn't visually reached
// yet — so the rendered LineString goes (provider_track) → (breadcrumb_at_new_pos)
// → (icon_at_lerp_pos), which paints a forward-then-back zigzag past the dot.
// Filter breadcrumbs whose forward projection on the icon's heading exceeds
// this tolerance — that drops the in-flight-lerp breadcrumbs without losing
// behind-the-dot ones. ~8 m tolerance keeps the filter from oscillating on
// rounding noise near zero.
export const BREADCRUMB_LEAD_TOLERANCE_MILES = 0.005;
