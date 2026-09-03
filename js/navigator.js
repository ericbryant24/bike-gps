// Navigation engine: consumes GPS fixes, tracks progress along the route,
// decides what to announce and when, detects off-route and arrival.
// No DOM access — drives both the real GPS and the ride simulator, and is
// unit-tested with synthetic fixes.

import { distance, pointAtDistance, snapToPath, speakDistance } from './geo.js';

const ARRIVE_RADIUS = 25;
const PASSED_SLACK = 8; // metres past a maneuver before it counts as done
const OFFROUTE_FIXES = 3; // consecutive off-route fixes before we say so
const OFFROUTE_SPEAK_GAP = 20000;

export class Navigator {
  constructor({ route, steps, units = 'metric', offRouteMeters = 40 }) {
    this.units = units;
    this.offRouteMeters = offRouteMeters;
    this.listeners = new Map();
    this.speed = null; // m/s, smoothed
    this.lastFix = null;
    this.setRoute(route, steps);
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) fn(payload);
  }

  /** Swap in a (re)computed route. Steps must be the announceable list. */
  setRoute(route, steps) {
    this.route = route;
    this.steps = steps;
    this.hint = 0;
    this.offRouteCount = 0;
    this.offRoute = false;
    this.offRouteSpokenAt = 0;
    this.arrived = false;
    this.announced = new Set();
    this.state = null;
    this.started = false;
  }

  /** Announce the departure instruction. Call once when navigation starts. */
  start() {
    if (this.started) return;
    this.started = true;
    const depart = this.steps[0];
    const first = this.steps[1];
    let text = depart?.text || 'Start riding';
    if (first && first.kind !== 'arrive' && first.along < 150) text += `, then ${lower(first.text)}`;
    this.emit('speak', { text, priority: true });
  }

  updateSpeed(fix) {
    let v = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    if (v == null && this.lastFix) {
      const dt = (fix.timestamp - this.lastFix.timestamp) / 1000;
      if (dt > 0.5 && dt < 30) v = distance(this.lastFix, fix) / dt;
    }
    if (v != null) this.speed = this.speed == null ? v : this.speed * 0.6 + v * 0.4;
    this.lastFix = fix;
  }

  /**
   * Feed a fix: { lat, lon, accuracy, heading, speed, timestamp }.
   * Returns the new state (also emitted as 'update').
   */
  update(fix) {
    this.updateSpeed(fix);
    const { points, cum, length } = this.route;
    const snap = snapToPath(fix, points, cum, this.hint);
    if (!snap) return null;
    this.hint = snap.index;

    const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : 15;
    const threshold = Math.max(this.offRouteMeters, Math.min(accuracy * 1.5, 120));
    const remaining = Math.max(0, length - snap.along);

    // Off-route detection: require several consecutive bad fixes so a single
    // GPS glitch doesn't trigger a reroute.
    if (snap.dist > threshold) {
      this.offRouteCount += 1;
      if (this.offRouteCount >= OFFROUTE_FIXES && !this.offRoute) {
        this.offRoute = true;
        this.emit('offroute', { fix, snap });
        if (Date.now() - this.offRouteSpokenAt > OFFROUTE_SPEAK_GAP) {
          this.offRouteSpokenAt = Date.now();
          this.emit('speak', { text: 'Off route. Recalculating.', priority: true });
        }
      }
    } else {
      this.offRouteCount = 0;
      this.offRoute = false;
    }

    // Current maneuver = first step still ahead of us (skipping departure).
    let stepIdx = this.steps.length - 1;
    for (let i = 1; i < this.steps.length; i++) {
      if (this.steps[i].along > snap.along - PASSED_SLACK) {
        stepIdx = i;
        break;
      }
    }
    const step = this.steps[stepIdx];
    const next = this.steps[stepIdx + 1] || null;
    const distToStep = Math.max(0, step.along - snap.along);

    // Arrival: near the end of the track, or physically near the destination.
    const dest = points[points.length - 1];
    const nearDest = distance(fix, dest) < ARRIVE_RADIUS;
    if (!this.arrived && !this.offRoute && (remaining < ARRIVE_RADIUS || (nearDest && remaining < 120))) {
      this.arrived = true;
      this.emit('speak', { text: 'You have arrived at your destination.', priority: true });
      this.emit('arrive', { fix });
    }

    if (!this.offRoute && !this.arrived) this.maybeAnnounce(stepIdx, step, next, distToStep);

    const speed = this.speed ?? 0;
    const refSpeed = speed > 1 ? speed : length / Math.max(1, this.route.time || length / 4.5);
    const etaSeconds = remaining / Math.max(1.5, refSpeed);

    this.state = {
      fix,
      snap,
      onRoute: snap.dist <= threshold,
      offRoute: this.offRoute,
      along: snap.along,
      remaining,
      progress: length > 0 ? snap.along / length : 0,
      speed,
      stepIdx,
      step,
      next,
      distToStep,
      etaSeconds,
      arrived: this.arrived,
      bearing: Number.isFinite(fix.heading) ? fix.heading : this.pathBearing(snap),
    };
    this.emit('update', this.state);
    return this.state;
  }

  pathBearing(snap) {
    const { points, cum } = this.route;
    const ahead = pointAtDistance(points, cum, snap.along + 20)?.point;
    if (!ahead) return 0;
    const a = snap.point;
    const y = Math.sin(((ahead.lon - a.lon) * Math.PI) / 180) * Math.cos((ahead.lat * Math.PI) / 180);
    const x =
      Math.cos((a.lat * Math.PI) / 180) * Math.sin((ahead.lat * Math.PI) / 180) -
      Math.sin((a.lat * Math.PI) / 180) * Math.cos((ahead.lat * Math.PI) / 180) * Math.cos(((ahead.lon - a.lon) * Math.PI) / 180);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  maybeAnnounce(stepIdx, step, next, distToStep) {
    if (step.kind === 'depart') return;
    const speed = this.speed ?? 4.5;
    // Distances scale with speed: ~45 s warning, ~7 s "now".
    const earlyDist = Math.min(500, Math.max(150, speed * 45));
    const nowDist = Math.min(80, Math.max(30, speed * 7));
    const prevGap = step.along - (this.steps[stepIdx - 1]?.along ?? 0);

    const key = (stage) => `${stepIdx}:${stage}`;
    if (distToStep <= nowDist && !this.announced.has(key('now'))) {
      this.announced.add(key('now'));
      this.announced.add(key('early'));
      let text = step.kind === 'arrive' ? step.text : step.text;
      if (next && next.kind !== 'arrive' && next.along - step.along < 90) text += `, then ${lower(next.text)}`;
      this.emit('speak', { text, priority: true });
    } else if (distToStep <= earlyDist && distToStep > nowDist + 20 && prevGap > earlyDist * 0.7 && !this.announced.has(key('early'))) {
      this.announced.add(key('early'));
      this.emit('speak', { text: `In ${speakDistance(distToStep, this.units)}, ${lower(step.text)}`, priority: false });
    }
  }
}

function lower(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
}

/**
 * Ride simulator: emits fixes along the route at `speed` m/s. Optional
 * `detourAt` (0..1) sends the rider off route for a while to exercise
 * rerouting. Returns a controller with stop()/setSpeed().
 */
export function simulateRide(route, { speed = 5.5, intervalMs = 1000, onFix, detourAt = null, noise = 2, timeScale = 1 } = {}) {
  let along = 0;
  let stopped = false;
  let currentSpeed = speed;
  let timer = null;
  const start = Date.now();
  const totalLen = route.length;
  let detourLeft = detourAt == null ? 0 : -1;

  const tick = () => {
    if (stopped) return;
    along += currentSpeed * (intervalMs / 1000) * timeScale;
    let pos;
    let heading;
    if (detourLeft === -1 && along / totalLen >= detourAt) detourLeft = 12; // 12 fixes off-route
    const base = pointAtDistance(route.points, route.cum, Math.min(along, totalLen));
    const ahead = pointAtDistance(route.points, route.cum, Math.min(along + 15, totalLen));
    heading = bearingBetween(base.point, ahead.point);
    if (detourLeft > 0) {
      detourLeft -= 1;
      // Drift sideways off the route, then rejoin.
      const off = 30 + (12 - detourLeft) * 15;
      pos = offsetPoint(base.point, heading + 90, off);
      along -= currentSpeed * (intervalMs / 1000) * timeScale * 0.5; // slow down while lost
    } else {
      pos = noise ? offsetPoint(base.point, Math.random() * 360, Math.random() * noise) : base.point;
    }
    onFix({
      lat: pos.lat,
      lon: pos.lon,
      accuracy: 8,
      heading,
      speed: currentSpeed,
      timestamp: start + (Date.now() - start) * timeScale,
      simulated: true,
    });
    if (along >= totalLen + 40) {
      stopped = true;
      return;
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 200);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    setSpeed(v) {
      currentSpeed = v;
    },
    get running() {
      return !stopped;
    },
  };
}

function bearingBetween(a, b) {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function offsetPoint(p, brg, dist) {
  const R = 6371008.8;
  const δ = dist / R;
  const θ = (brg * Math.PI) / 180;
  const φ1 = (p.lat * Math.PI) / 180;
  const λ1 = (p.lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
}
