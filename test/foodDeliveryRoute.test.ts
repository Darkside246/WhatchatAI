import { describe, expect, it } from 'vitest';
import { URGENT_AFTER_SECONDS, describeRoute, planRoute, type RouteStop } from '../src/domain/food/deliveryRoute.js';

/**
 * Planning a driver's run.
 *
 * Computed from the pins the customers dropped, never by asking a model to
 * sort addresses - a model cannot measure, and a customer's address is their
 * personal information. These pin the properties a driver would notice if
 * they were wrong.
 */

// Barbados-ish coordinates, spaced so the right order is obvious by eye.
const SHOP = { latitude: 13.1, longitude: -59.6 };

function stop(orderId: string, latitude: number | null, longitude: number | null, ageSeconds = 0): RouteStop {
  return { orderId, latitude, longitude, ageSeconds };
}

describe('planning a delivery run', () => {
  it('drives the nearest stop first', () => {
    const route = planRoute(SHOP, [
      stop('far', 13.2, -59.6),
      stop('near', 13.11, -59.6),
      stop('middle', 13.15, -59.6),
    ]);

    expect(route.stops.map((s) => s.orderId)).toEqual(['near', 'middle', 'far']);
    expect(route.stops.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it('never drops a stop, whatever it knows about it', () => {
    // The failure that matters most: a stop missing from the list is a
    // delivery nobody makes.
    const route = planRoute(SHOP, [stop('a', 13.11, -59.6), stop('b', null, null), stop('c', 13.12, -59.6)]);

    expect(route.stops).toHaveLength(3);
    expect(route.stops.map((s) => s.orderId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('puts a stop with no pin last and says so rather than guessing a position', () => {
    const route = planRoute(SHOP, [stop('nopin', null, null), stop('located', 13.11, -59.6)]);

    expect(route.stops[route.stops.length - 1]).toMatchObject({ orderId: 'nopin', legMetres: null });
    expect(route.unlocatedOrderIds).toEqual(['nopin']);
  });

  it('leads with an order that is already late, even when it is the furthest away', () => {
    // Pure nearest-neighbour leaves the oldest order until last whenever it
    // happens to be furthest, which is how the person who ordered first gets
    // their food last and cold.
    const route = planRoute(SHOP, [
      stop('close', 13.101, -59.6, 60),
      stop('late-and-far', 13.3, -59.6, URGENT_AFTER_SECONDS + 60),
    ]);

    expect(route.stops[0]?.orderId).toBe('late-and-far');
  });

  it('orders several late stops oldest first', () => {
    const route = planRoute(SHOP, [
      stop('late', 13.11, -59.6, URGENT_AFTER_SECONDS + 60),
      stop('latest', 13.3, -59.6, URGENT_AFTER_SECONDS + 600),
    ]);

    expect(route.stops.map((s) => s.orderId)).toEqual(['latest', 'late']);
  });

  it('measures each leg from the stop before it, not from the shop', () => {
    const route = planRoute(SHOP, [stop('a', 13.11, -59.6), stop('b', 13.12, -59.6)]);

    // Both legs are one step of 0.01 degrees of latitude, so the second leg
    // is the same size as the first - it is not measured back to the shop.
    const [first, second] = route.stops;
    expect(first?.legMetres).toBeGreaterThan(0);
    expect(second?.legMetres).toBeCloseTo(first?.legMetres ?? 0, -1);
  });

  it('totals only the legs it could measure', () => {
    const withPin = planRoute(SHOP, [stop('a', 13.11, -59.6)]);
    const withBoth = planRoute(SHOP, [stop('a', 13.11, -59.6), stop('b', null, null)]);

    expect(withBoth.totalMetres).toBe(withPin.totalMetres);
  });

  it('has nothing to total when nothing has a pin', () => {
    const route = planRoute(SHOP, [stop('a', null, null)]);

    expect(route.totalMetres).toBeNull();
    expect(route.stops).toHaveLength(1);
  });

  it('handles an empty run without inventing one', () => {
    const route = planRoute(SHOP, []);

    expect(route.stops).toEqual([]);
    expect(route.totalMetres).toBeNull();
    expect(describeRoute(route)).toBe('Nothing to deliver right now.');
  });

  it('is not worse than driving them in the order they arrived', () => {
    // The whole justification for doing this at all. A deliberately awful
    // input order - out, back, out again - must come back shorter.
    const scattered = [
      stop('a', 13.30, -59.60),
      stop('b', 13.11, -59.60),
      stop('c', 13.25, -59.60),
      stop('d', 13.12, -59.60),
      stop('e', 13.20, -59.60),
    ];
    const planned = planRoute(SHOP, scattered);
    const plannedTotal = planned.totalMetres ?? 0;

    // Same stops, driven in the order they were handed over.
    let arrivalTotal = 0;
    let previous = SHOP;
    for (const s of scattered) {
      arrivalTotal += planRoute(previous, [s]).totalMetres ?? 0;
      previous = { latitude: s.latitude!, longitude: s.longitude! };
    }

    expect(plannedTotal).toBeLessThan(arrivalTotal);
  });

  it('says what the distance is and is not', () => {
    // A driver who is told "4.2 km of driving" and finds it is 6 stops
    // believing nothing else this screen says.
    const route = planRoute(SHOP, [stop('a', 13.15, -59.6)]);

    expect(describeRoute(route)).toContain('in a straight line');
  });

  it('warns about the stops it could not place', () => {
    const route = planRoute(SHOP, [stop('a', 13.11, -59.6), stop('b', null, null)]);

    expect(describeRoute(route)).toContain('no pin');
  });
});
