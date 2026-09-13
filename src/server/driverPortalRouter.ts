import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { FoodOperationsRepository } from '../repositories/foodOperationsRepository.js';
import { generateSessionToken, hashSessionToken } from '../services/sessionTokenService.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { DRIVER_ASSIGNMENT_STATES } from '../domain/food/driverAssignment.js';
import { describeRoute, planRoute, type RouteStop } from '../domain/food/deliveryRoute.js';

/**
 * The driver's own portal.
 *
 * Mounted at /api/driver and deliberately NOT under /api/workspace. A driver
 * is not a member of the business: they are one person who needs to see the
 * few orders in their hands, and nothing else about the shop, its takings,
 * its customers or its other drivers. Giving them a workspace role would
 * have meant every existing workspace route was one forgotten permission
 * check away from being theirs.
 *
 * So the boundary is structural. This router has its own principal, its own
 * cookie, and its own repository calls - and every one of those calls is
 * scoped to this driver's own live assignments in SQL rather than filtered
 * afterwards. There is no request shape that widens it.
 */

const repository = new FoodOperationsRepository(pool);
const router = Router();

/**
 * A different cookie name from the workspace's wc_session, on purpose.
 *
 * Sharing the name would mean a driver's phone and an owner's laptop hold
 * the same-named credential, and one middleware reading the other's token is
 * then a one-line mistake away. Different names make that mistake impossible
 * rather than unlikely.
 */
export const DRIVER_COOKIE_NAME = 'aura_driver';

/** A shift. A driver's phone is the least controlled device that will ever hold a credential for this business. */
const SESSION_HOURS = 14;
/** Long enough to read on the road and act on after stopping; short enough that a link left in a thread stops working. */
const LINK_MINUTES = 30;

export interface DriverContext {
  businessId: string;
  driverId: string;
  driverName: string;
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setDriverCookie(req: Request, res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(DRIVER_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: 'Lax',
      maxAgeSeconds: SESSION_HOURS * 3600,
    }),
  );
}

function clearDriverCookie(req: Request, res: Response): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(DRIVER_COOKIE_NAME, '', { httpOnly: true, secure: isSecureRequest(req), maxAgeSeconds: 0 }),
  );
}

async function requireDriver(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = parseCookies(req.headers.cookie)[DRIVER_COOKIE_NAME];
  if (!token) return void res.status(401).json({ error: 'NOT_SIGNED_IN' });

  // One statement decides live, unexpired, and still-employed - there is no
  // window where this router holds a session it has not fully checked.
  const session = await repository.findLiveDriverSession(hashSessionToken(token));
  if (!session) {
    clearDriverCookie(req, res);
    return void res.status(401).json({ error: 'SESSION_EXPIRED' });
  }

  res.locals.driver = session satisfies DriverContext;
  next();
}

/**
 * Turning a sign-in link into a session.
 *
 * Unauthenticated by definition. The token is the whole credential, so it is
 * single-use, short-lived, and checked against a driver who is still active
 * at the moment of redemption rather than at the moment of issue.
 */
router.post('/session', async (req, res) => {
  const parsed = z.object({ token: z.string().min(32).max(200) }).safeParse(req.body);
  // Deliberately the same answer as a token that simply does not work: a
  // different response for "malformed" than for "wrong" tells somebody
  // guessing which half of their guess was right.
  if (!parsed.success) return res.status(401).json({ error: 'LINK_NOT_VALID' });

  const sessionToken = generateSessionToken();
  const redeemed = await repository.redeemDriverSignInToken({
    tokenHash: hashSessionToken(parsed.data.token),
    sessionTokenHash: hashSessionToken(sessionToken),
    sessionExpiresAt: new Date(Date.now() + SESSION_HOURS * 3600 * 1000),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null,
  });
  if (!redeemed) return res.status(401).json({ error: 'LINK_NOT_VALID' });

  setDriverCookie(req, res, sessionToken);
  return res.status(200).json({ ok: true });
});

router.post('/signout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[DRIVER_COOKIE_NAME];
  if (token) await repository.revokeDriverSession(hashSessionToken(token));
  clearDriverCookie(req, res);
  return res.status(200).json({ ok: true });
});

router.get('/me', requireDriver, (_req, res) => {
  const driver = res.locals.driver as DriverContext;
  // Their own name and nothing else. Not the business's name, not its other
  // drivers, not how many orders it has taken today.
  return res.status(200).json({ driver: { id: driver.driverId, name: driver.driverName } });
});

/**
 * The run: what this driver is carrying, in the order to drive it.
 *
 * The route is computed here from the pins the customers dropped - see
 * domain/food/deliveryRoute.ts for why it is arithmetic and not a model.
 * Nothing about a customer is sent anywhere for this.
 */
router.get('/run', requireDriver, async (_req, res) => {
  const driver = res.locals.driver as DriverContext;
  const stops = await repository.listDriverManifest(driver.businessId, driver.driverId);

  const now = Date.now();
  const routeStops: RouteStop[] = stops.map((stop) => ({
    orderId: stop.orderId,
    latitude: stop.deliveryLatitude,
    longitude: stop.deliveryLongitude,
    ageSeconds: Math.max(0, Math.round((now - new Date(stop.placedAt).getTime()) / 1000)),
  }));

  /**
   * Where the run starts.
   *
   * A delivery zone's centre is the shop, which is what this should measure
   * from. Without one there is no anchor, so the oldest located stop becomes
   * it - the ordering is still useful relative to itself, and pretending to
   * a shop position we do not have would put a confident wrong number on the
   * screen.
   */
  const zones = await repository.listZones(driver.businessId);
  const active = zones.find((zone) => zone.active) ?? zones[0];
  const anchor = active
    ? { latitude: active.centreLatitude, longitude: active.centreLongitude }
    : routeStops.find((stop) => stop.latitude !== null && stop.longitude !== null);

  const route =
    anchor && anchor.latitude !== null && anchor.longitude !== null
      ? planRoute({ latitude: anchor.latitude, longitude: anchor.longitude }, routeStops)
      : { stops: routeStops.map((stop, index) => ({ orderId: stop.orderId, position: index + 1, legMetres: null })), totalMetres: null, unlocatedOrderIds: routeStops.map((s) => s.orderId) };

  const position = new Map(route.stops.map((stop) => [stop.orderId, stop]));

  return res.status(200).json({
    driver: { id: driver.driverId, name: driver.driverName },
    summary: describeRoute(route),
    startedFromShop: Boolean(active),
    stops: [...stops]
      .sort((left, right) => (position.get(left.orderId)?.position ?? 0) - (position.get(right.orderId)?.position ?? 0))
      .map((stop) => ({
        ...stop,
        position: position.get(stop.orderId)?.position ?? null,
        legMetres: position.get(stop.orderId)?.legMetres ?? null,
        ageSeconds: Math.max(0, Math.round((now - new Date(stop.placedAt).getTime()) / 1000)),
      })),
  });
});

/**
 * The driver saying what happened to a stop.
 *
 * Scoped by driverId in the repository, so a driver cannot move somebody
 * else's delivery by knowing its id.
 */
const stateSchema = z.object({
  state: z.enum(DRIVER_ASSIGNMENT_STATES),
  // Required by the repository for a failure, because "failed" on its own
  // tells the shop nothing they can act on.
  failureReason: z.string().trim().min(3).max(500).optional(),
  note: z.string().trim().max(500).optional(),
});

router.post('/stops/:deliveryId/state', requireDriver, async (req, res) => {
  const driver = res.locals.driver as DriverContext;
  const deliveryId = String(req.params.deliveryId ?? '');
  if (!z.string().uuid().safeParse(deliveryId).success) return res.status(400).json({ error: 'INVALID_DELIVERY_ID' });

  const parsed = stateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_STATE' });

  try {
    const updated = await repository.moveDelivery(driver.businessId, deliveryId, parsed.data.state, {
      // The scope. Not a filter applied to the result - the repository
      // refuses to read or write another driver's row at all.
      restrictToDriverId: driver.driverId,
      ...(parsed.data.failureReason !== undefined ? { failureReason: parsed.data.failureReason } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    });
    if (!updated) return res.status(404).json({ error: 'STOP_NOT_FOUND' });
    return res.status(200).json({ stop: updated });
  } catch (error) {
    // An illegal move is the driver's screen being out of date - somebody at
    // the shop marked it first - not a fault worth a 500.
    return res.status(409).json({ error: 'STATE_NOT_ALLOWED', message: error instanceof Error ? error.message : 'That is not a move this stop can make.' });
  }
});

export { router as driverPortalRouter, requireDriver, LINK_MINUTES };
