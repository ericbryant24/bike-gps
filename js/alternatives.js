// Alternative routes: drop BRouter alternatives that merely repeat the main
// route, and summarise each distinct one so the trade-off between distance,
// time and traffic exposure is visible. Pure functions; unit-tested in Node.

import { cumulativeDistances, pointAtDistance, snapToPath } from './geo.js';
import { rateSegments, routeComposition } from './rating.js';

/** BRouter accepts alternativeidx 0..3; we ask for these beyond the main route. */
export const ALTERNATIVE_INDICES = [1, 2];

/** Fraction of route `b`'s length that runs along route `a` (within `tolerance` metres). */
export function overlapFraction(a, b, { samples = 60, tolerance = 30 } = {}) {
  if (!a?.points?.length || !b?.points?.length) return 0;
  const ca = a.cum || cumulativeDistances(a.points);
  const cb = b.cum || cumulativeDistances(b.points);
  const total = cb[cb.length - 1];
  if (!total) return 1;
  let hits = 0;
  let hint = 0;
  for (let i = 0; i <= samples; i++) {
    const p = pointAtDistance(b.points, cb, (i / samples) * total).point;
    const snap = snapToPath(p, a.points, ca, hint, 40, tolerance);
    if (snap && snap.dist <= tolerance) {
      hits++;
      hint = snap.index;
    }
  }
  return hits / (samples + 1);
}

/**
 * True when the two routes are the same ride for practical purposes: nearly
 * all of each lies along the other. BRouter returns the main route again when
 * it has no alternative, and often alternatives that differ by a block or two.
 */
export function sameRoute(a, b, { threshold = 0.9 } = {}) {
  return overlapFraction(a, b) >= threshold && overlapFraction(b, a) >= threshold;
}

/** Keep the first of each group of near-identical routes, preserving order. */
export function dedupeRoutes(routes) {
  const out = [];
  for (const r of routes) {
    if (r?.points?.length && !out.some((o) => sameRoute(o, r))) out.push(r);
  }
  return out;
}

/** Traffic exposure of a route: metres graded D/E (busy or major road) plus the composition. */
export function exposure(route) {
  const comp = routeComposition(rateSegments(route));
  const busy = comp.byGrade.D + comp.byGrade.E;
  return { ...comp, busy, busyShare: comp.total ? busy / comp.total : 0 };
}

/**
 * Compare distinct routes. Returns [{ route, exposure, badges }] in input order.
 * A badge only appears when the route beats every other by a clear margin.
 */
export function compareAlternatives(routes) {
  const rows = routes.map((route) => ({ route, exposure: exposure(route), badges: [] }));
  if (rows.length < 2) return rows;
  const award = (badge, value, margin) => {
    const vals = rows.map(value);
    const best = Math.min(...vals);
    const winners = vals.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
    if (winners.length !== 1) return;
    const runnerUp = Math.min(...vals.filter((_, i) => i !== winners[0]));
    if (runnerUp - best >= margin(best, runnerUp)) rows[winners[0]].badges.push(badge);
  };
  award('Least traffic', (r) => r.exposure.busy, (best, next) => Math.max(75, 0.1 * next));
  award('Fastest', (r) => r.route.time || Infinity, () => 30);
  award('Shortest', (r) => r.route.length, (best) => Math.max(50, 0.02 * best));
  return rows;
}
