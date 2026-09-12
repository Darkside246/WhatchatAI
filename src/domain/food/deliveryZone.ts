/**
 * Whether this kitchen will deliver to where the customer dropped their pin.
 *
 * A centre and a radius rather than a drawn polygon, and haversine rather
 * than PostGIS ST_Contains. Both are deliberate: it ships without requiring
 * a database extension, an operator can set a zone up by typing one number
 * instead of drawing a shape, and for a business delivering from a single
 * address a radius answers the real question - is this within the distance
 * we are willing to drive.
 *
 * The honest limit is that a radius does not know about rivers, motorways
 * or a bay. A kitchen on a coastline will include water it cannot drive
 * across. Zones are therefore a first filter for the operator's own
 * judgment, not a routing engine - which is why an out-of-zone order is
 * offered collection rather than silently refused.
 */

const EARTH_RADIUS_METRES = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function distanceMetres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface DeliveryZone {
  id: string;
  name: string;
  centreLatitude: number;
  centreLongitude: number;
  radiusMetres: number;
  feeCents: number;
  minimumOrderCents: number;
}

export interface ZoneMatch {
  zone: DeliveryZone;
  distanceMetres: number;
}

/**
 * The zone a delivery falls in, or null when it falls outside all of them.
 *
 * Picks the CHEAPEST zone that reaches, not the first or the nearest. Zones
 * overlap by design - a business usually sets a small free-delivery radius
 * inside a larger paid one - and charging the higher fee to somebody who
 * qualifies for the lower one because of table order would be a quiet
 * overcharge.
 */
export function findZoneFor(
  destination: { latitude: number; longitude: number },
  zones: readonly DeliveryZone[],
): ZoneMatch | null {
  let best: ZoneMatch | null = null;

  for (const zone of zones) {
    const distance = distanceMetres(destination, { latitude: zone.centreLatitude, longitude: zone.centreLongitude });
    if (distance > zone.radiusMetres) continue;
    if (!best || zone.feeCents < best.zone.feeCents) best = { zone, distanceMetres: distance };
  }

  return best;
}

export type DeliveryCheck =
  | { deliverable: true; zone: DeliveryZone; distanceMetres: number; feeCents: number }
  /** Too far to drive. The operator's board offers collection rather than refusing outright. */
  | { deliverable: false; reason: 'OUT_OF_RANGE'; nearestZoneMetres: number | null }
  /** In range, but the basket is under what this zone will drive for. */
  | { deliverable: false; reason: 'BELOW_MINIMUM'; zone: DeliveryZone; minimumOrderCents: number };

/** The whole question a board asks: can we take this there, and what does it cost. */
export function checkDelivery(
  destination: { latitude: number; longitude: number },
  subtotalCents: number,
  zones: readonly DeliveryZone[],
): DeliveryCheck {
  const match = findZoneFor(destination, zones);

  if (!match) {
    const distances = zones.map((zone) =>
      distanceMetres(destination, { latitude: zone.centreLatitude, longitude: zone.centreLongitude }) - zone.radiusMetres,
    );
    return { deliverable: false, reason: 'OUT_OF_RANGE', nearestZoneMetres: distances.length > 0 ? Math.round(Math.min(...distances)) : null };
  }

  if (subtotalCents < match.zone.minimumOrderCents) {
    return { deliverable: false, reason: 'BELOW_MINIMUM', zone: match.zone, minimumOrderCents: match.zone.minimumOrderCents };
  }

  return { deliverable: true, zone: match.zone, distanceMetres: match.distanceMetres, feeCents: match.zone.feeCents };
}

/**
 * A one-tap turn-by-turn link for the driver, built from the coordinates
 * the customer actually dropped.
 *
 * Coordinates rather than the typed address on purpose: a pin cannot be
 * misspelled, cannot be missing a postcode, and cannot describe a street
 * that exists twice in the same town. This is the whole reason for
 * capturing a pin at order time.
 */
export function navigationUrl(destination: { latitude: number; longitude: number }): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${destination.latitude},${destination.longitude}`;
}
