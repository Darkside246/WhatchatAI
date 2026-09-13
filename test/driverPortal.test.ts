import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { generateSessionToken, hashSessionToken } from '../src/services/sessionTokenService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * A driver signing in to see their own run.
 *
 * A driver is not a member of the business, and the whole design rests on
 * that boundary holding. These are the assertions that matter: a session
 * reaches exactly one driver's own live stops, a link is worth one use, and
 * taking somebody off the road ends their access immediately rather than
 * whenever their session happens to expire.
 */
describe('driver portal', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
    await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, null);
  });

  async function signIn(driverId: string) {
    const link = generateSessionToken();
    await repo.issueDriverSignInToken({
      businessId,
      driverId,
      tokenHash: hashSessionToken(link),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      issuedBy: null,
    });
    const session = generateSessionToken();
    const redeemed = await repo.redeemDriverSignInToken({
      tokenHash: hashSessionToken(link),
      sessionTokenHash: hashSessionToken(session),
      sessionExpiresAt: new Date(Date.now() + 14 * 3600 * 1000),
      userAgent: null,
    });
    return { link, session, redeemed };
  }

  async function anAssignedOrder(driverId: string) {
    const order = await repo.createOrder({
      businessId,
      fulfilmentMethod: 'DELIVERY',
      items: [{ menuItemId: null, name: 'Chicken roti', variant: null, quantity: 1, unitPriceCents: 1200, modifiers: [], notes: null }],
      subtotalCents: 1200,
      totalCents: 1200,
      customerName: 'Marcia',
      deliveryAddress: '1 Bay Street',
    });
    const delivery = await repo.assignDriver(businessId, order.id, driverId);
    return { order, delivery };
  }

  describe('signing in', () => {
    it('turns a link into a session', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { session, redeemed } = await signIn(driver.id);

      expect(redeemed).toEqual({ businessId, driverId: driver.id });
      expect(await repo.findLiveDriverSession(hashSessionToken(session))).toMatchObject({
        businessId,
        driverId: driver.id,
        driverName: 'Andre',
      });
    });

    it('spends a link on first use', async () => {
      // A link sits in a WhatsApp thread. One that keeps working is a key
      // anybody who ever saw the thread still holds.
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { link } = await signIn(driver.id);

      const second = await repo.redeemDriverSignInToken({
        tokenHash: hashSessionToken(link),
        sessionTokenHash: hashSessionToken(generateSessionToken()),
        sessionExpiresAt: new Date(Date.now() + 3600 * 1000),
        userAgent: null,
      });
      expect(second).toBeNull();
    });

    it('refuses an expired link', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const link = generateSessionToken();
      await repo.issueDriverSignInToken({
        businessId,
        driverId: driver.id,
        tokenHash: hashSessionToken(link),
        expiresAt: new Date(Date.now() - 1000),
        issuedBy: null,
      });

      expect(
        await repo.redeemDriverSignInToken({
          tokenHash: hashSessionToken(link),
          sessionTokenHash: hashSessionToken(generateSessionToken()),
          sessionExpiresAt: new Date(Date.now() + 3600 * 1000),
          userAgent: null,
        }),
      ).toBeNull();
    });

    it('invalidates the previous link when a new one is issued', async () => {
      // Re-issuing has to replace, not accumulate - otherwise every link
      // ever sent to that driver still opens the door.
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const first = generateSessionToken();
      await repo.issueDriverSignInToken({
        businessId, driverId: driver.id, tokenHash: hashSessionToken(first),
        expiresAt: new Date(Date.now() + 60_000), issuedBy: null,
      });
      const second = generateSessionToken();
      await repo.issueDriverSignInToken({
        businessId, driverId: driver.id, tokenHash: hashSessionToken(second),
        expiresAt: new Date(Date.now() + 60_000), issuedBy: null,
      });

      const usedOld = await repo.redeemDriverSignInToken({
        tokenHash: hashSessionToken(first),
        sessionTokenHash: hashSessionToken(generateSessionToken()),
        sessionExpiresAt: new Date(Date.now() + 3600 * 1000),
        userAgent: null,
      });
      expect(usedOld).toBeNull();
    });

    it('refuses a link for a driver who has been taken off the road', async () => {
      // Checked at redemption, not at issue: a driver can be deactivated
      // between the link being sent and being tapped.
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const link = generateSessionToken();
      await repo.issueDriverSignInToken({
        businessId, driverId: driver.id, tokenHash: hashSessionToken(link),
        expiresAt: new Date(Date.now() + 60_000), issuedBy: null,
      });
      await repo.setDriverActive(businessId, driver.id, false);

      expect(
        await repo.redeemDriverSignInToken({
          tokenHash: hashSessionToken(link),
          sessionTokenHash: hashSessionToken(generateSessionToken()),
          sessionExpiresAt: new Date(Date.now() + 3600 * 1000),
          userAgent: null,
        }),
      ).toBeNull();
    });
  });

  describe('losing access', () => {
    it('ends a live session the moment the driver is deactivated', async () => {
      // The one that matters most: "this person no longer works here" must
      // not leave a working session on their phone carrying every customer
      // address they had been given.
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { session } = await signIn(driver.id);
      expect(await repo.findLiveDriverSession(hashSessionToken(session))).not.toBeNull();

      await repo.setDriverActive(businessId, driver.id, false);

      expect(await repo.findLiveDriverSession(hashSessionToken(session))).toBeNull();
    });

    it('ends a session when the driver signs out', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { session } = await signIn(driver.id);

      await repo.revokeDriverSession(hashSessionToken(session));

      expect(await repo.findLiveDriverSession(hashSessionToken(session))).toBeNull();
    });

    it('treats an unknown token as no session at all', async () => {
      expect(await repo.findLiveDriverSession(hashSessionToken(generateSessionToken()))).toBeNull();
    });
  });

  describe('the run', () => {
    it('shows the driver their own stops, with what they need to make the drop', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { order } = await anAssignedOrder(driver.id);

      const manifest = await repo.listDriverManifest(businessId, driver.id);
      expect(manifest).toHaveLength(1);
      expect(manifest[0]).toMatchObject({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: 'Marcia',
        deliveryAddress: '1 Bay Street',
        state: 'ASSIGNED',
      });
      expect(manifest[0]?.items[0]?.name).toBe('Chicken roti');
    });

    it("never shows one driver another driver's stops", async () => {
      const andre = await repo.createDriver({ businessId, name: 'Andre' });
      const kemar = await repo.createDriver({ businessId, name: 'Kemar' });
      await anAssignedOrder(andre.id);

      expect(await repo.listDriverManifest(businessId, kemar.id)).toEqual([]);
    });

    it("never shows another business's stops", async () => {
      const other = await createTestBusiness('Someone Else');
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      await anAssignedOrder(driver.id);

      expect(await repo.listDriverManifest(other, driver.id)).toEqual([]);
    });

    it('drops a stop off the run once it is delivered', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { delivery } = await anAssignedOrder(driver.id);

      await repo.moveDelivery(businessId, delivery.id, 'COLLECTED', { restrictToDriverId: driver.id });
      expect(await repo.listDriverManifest(businessId, driver.id)).toHaveLength(1);

      await repo.moveDelivery(businessId, delivery.id, 'DELIVERED', { restrictToDriverId: driver.id });
      expect(await repo.listDriverManifest(businessId, driver.id)).toEqual([]);
    });

    it('keeps a failed drop on the run, because it is still in the van', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { delivery } = await anAssignedOrder(driver.id);

      await repo.moveDelivery(businessId, delivery.id, 'COLLECTED', { restrictToDriverId: driver.id });
      await repo.moveDelivery(businessId, delivery.id, 'FAILED', {
        restrictToDriverId: driver.id,
        failureReason: 'Nobody in',
      });

      expect(await repo.listDriverManifest(businessId, driver.id)).toHaveLength(1);
    });
  });

  describe('moving a stop', () => {
    it("refuses to move another driver's stop, even with its real id", async () => {
      // A delivery id is a UUID somebody could hold from an earlier run. The
      // scope is enforced where the row is read and written, not in a route.
      const andre = await repo.createDriver({ businessId, name: 'Andre' });
      const kemar = await repo.createDriver({ businessId, name: 'Kemar' });
      const { delivery } = await anAssignedOrder(andre.id);

      expect(
        await repo.moveDelivery(businessId, delivery.id, 'COLLECTED', { restrictToDriverId: kemar.id }),
      ).toBeNull();
      // And Andre's stop is untouched.
      expect((await repo.findDelivery(businessId, delivery.id))?.state).toBe('ASSIGNED');
    });

    it('still lets the shop move anybody, because an operator legitimately can', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Andre' });
      const { delivery } = await anAssignedOrder(driver.id);

      const moved = await repo.moveDelivery(businessId, delivery.id, 'COLLECTED');
      expect(moved?.state).toBe('COLLECTED');
    });
  });
});
