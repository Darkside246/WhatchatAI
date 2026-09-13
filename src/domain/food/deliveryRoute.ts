import { distanceMetres } from './deliveryZone.js';

/**
 * The order to drive them in.
 *
 * Computed here, from the pins the customers actually dropped, and
 * deliberately NOT by asking a language model. Two reasons, and the second
 * matters more than the first.
 *
 * A model cannot measure. Asked to order a handful of addresses it produces
 * something that reads like a route and is frequently worse than driving
 * them in the order they came in - and it cannot tell you it was guessing.
 * Nearest-neighbour with a 2-opt pass is a few lines, is exact about the
 * distances it is comparing, and gets within a few percent of optimal at
 * the sizes a single driver carries.
 *
 * And a customer's address is their personal information. Sending a list of
 * them to a third-party model to be sorted would hand real people's home
 * addresses to a service that has no business holding them, for a
 * calculation that does not need a model at all. The agent's job here is to
 * explain the route, never to compute it - and it is given the sequence and
 * the distances, never the addresses.
 *
 * What this is not: live traffic, one-way systems, or turn-by-turn. It is
 * straight-line distance, which is the right approximation for a shop
 * delivering within a few miles of itself and an honest one to state
 * plainly rather than dress up as navigation.
 */

export interface RouteStop {
  orderId: string;
  /** Null whenever the customer never dropped a pin - a real and common case, not an error. */
  latitude: number | null;
  longitude: number | null;
  /** Seconds since the order was placed. Used to keep a stop that is already late from being driven last. */
  ageSeconds: number;
}

export interface PlannedStop {
  orderId: string;
  /** 1-based, in the order to drive them. */
  position: number;
  /** Straight-line metres from the previous stop (or from the shop, for the first). Null when either end has no pin. */
  legMetres: number | null;
}

export interface PlannedRoute {
  stops: PlannedStop[];
  /** Sum of the legs that could be measured. Null when nothing could be. */
  totalMetres: number | null;
  /**
   * Stops that could not be placed because nobody dropped a pin. They are
   * still in the list, at the end, and named here so the driver is told
   * rather than left to notice - an address the route could not use is
   * exactly the one that goes wrong.
   */
  unlocatedOrderIds: string[];
}

interface Located extends RouteStop {
  latitude: number;
  longitude: number;
}

function isLocated(stop: RouteStop): stop is Located {
  return stop.latitude !== null && stop.longitude !== null;
}

/**
 * How much later a stop is allowed to make the route before its age wins.
 *
 * Pure nearest-neighbour will happily leave the oldest order until last
 * because it happens to be furthest away, which is how a customer who
 * ordered first gets their food last and cold. A stop older than this is
 * pulled to the front of the run even when that costs distance, because at
 * that point the delivery is already failing and a few hundred metres is
 * not the problem.
 */
export const URGENT_AFTER_SECONDS = 45 * 60;

function legBetween(from: Located, to: Located): number {
  return distanceMetres(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
  );
}

/** Total straight-line distance of a run starting at the shop. */
function routeLength(shop: Located, order: Located[]): number {
  let total = 0;
  let previous = shop;
  for (const stop of order) {
    total += legBetween(previous, stop);
    previous = stop;
  }
  return total;
}

/**
 * Improves an order by repeatedly reversing any segment that shortens the
 * run - the standard 2-opt pass.
 *
 * Bounded rather than run to convergence: a driver carries a handful of
 * stops, and a loop with no ceiling is how a background job becomes a
 * production incident on the one day somebody assigns forty.
 */
function twoOpt(shop: Located, initial: Located[]): Located[] {
  const best = [...initial];
  const maxPasses = 20;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let j = i + 1; j < best.length; j += 1) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        if (routeLength(shop, candidate) < routeLength(shop, best) - 0.5) {
          best.splice(0, best.length, ...candidate);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  return best;
}

/**
 * Plans one driver's run from the shop.
 *
 * The result is a complete ordering of everything handed in - nothing is
 * dropped for being unlocatable, because a stop missing from the list is a
 * delivery nobody makes.
 */
export function planRoute(
  shop: { latitude: number; longitude: number },
  stops: RouteStop[],
): PlannedRoute {
  const origin: Located = { orderId: '', latitude: shop.latitude, longitude: shop.longitude, ageSeconds: 0 };
  const located = stops.filter(isLocated);
  const unlocated = stops.filter((stop) => !isLocated(stop));

  // Anything already past the urgency threshold leads, oldest first, and is
  // optimised only among itself - the point is that it goes first, not that
  // the trip to it is short.
  const urgent = located.filter((stop) => stop.ageSeconds >= URGENT_AFTER_SECONDS).sort((a, b) => b.ageSeconds - a.ageSeconds);
  const rest = located.filter((stop) => stop.ageSeconds < URGENT_AFTER_SECONDS);

  const remaining = [...rest];
  const nearestFirst: Located[] = [];
  let cursor: Located = urgent[urgent.length - 1] ?? origin;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const distance = legBetween(cursor, remaining[index]!);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    nearestFirst.push(next!);
    cursor = next!;
  }

  const ordered = [...urgent, ...twoOpt(urgent[urgent.length - 1] ?? origin, nearestFirst)];

  const planned: PlannedStop[] = [];
  let previous: Located = origin;
  let total = 0;
  for (const stop of ordered) {
    const leg = legBetween(previous, stop);
    total += leg;
    planned.push({ orderId: stop.orderId, position: planned.length + 1, legMetres: Math.round(leg) });
    previous = stop;
  }

  // Kept in the run, at the end, with no pretended distance.
  for (const stop of unlocated) {
    planned.push({ orderId: stop.orderId, position: planned.length + 1, legMetres: null });
  }

  return {
    stops: planned,
    totalMetres: ordered.length > 0 ? Math.round(total) : null,
    unlocatedOrderIds: unlocated.map((stop) => stop.orderId),
  };
}

/**
 * The route in a sentence, for the driver and for the agent to read out.
 *
 * Deliberately says what the number is and is not. "About 4.2 km in a
 * straight line" is a useful figure a driver can sanity-check; calling the
 * same number "4.2 km of driving" would be a claim this cannot support and
 * the driver would stop trusting the rest of it.
 */
export function describeRoute(route: PlannedRoute): string {
  const count = route.stops.length;
  if (count === 0) return 'Nothing to deliver right now.';

  const parts: string[] = [`${count} stop${count === 1 ? '' : 's'}`];
  if (route.totalMetres !== null) {
    parts.push(
      route.totalMetres >= 1000
        ? `about ${(route.totalMetres / 1000).toFixed(1)} km in a straight line`
        : `about ${route.totalMetres} m in a straight line`,
    );
  }
  if (route.unlocatedOrderIds.length > 0) {
    parts.push(
      `${route.unlocatedOrderIds.length} with no pin — check ${route.unlocatedOrderIds.length === 1 ? 'its address' : 'their addresses'} before you go`,
    );
  }
  return `${parts.join(' · ')}.`;
}
