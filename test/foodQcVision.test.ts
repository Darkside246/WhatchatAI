import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository, QcPhotoRequiredError } from '../src/repositories/foodOperationsRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';
import { classifyQcObservation, needsASecondLook, raisedFindings } from '../src/domain/food/qcFindings.js';
import { buildQcPrompt, parseObservation } from '../src/services/food/qcVisionCheck.js';
import type { FoodOrderLine } from '../src/repositories/foodOperationsRepository.js';

function line(overrides: Partial<FoodOrderLine> = {}): FoodOrderLine {
  return {
    menuItemId: null,
    name: 'Burger',
    variant: null,
    quantity: 1,
    unitPriceCents: 1800,
    modifiers: [],
    notes: null,
    ...overrides,
  };
}

describe('reading a photo of an order at the pass', () => {
  describe('what a photograph can establish', () => {
    /** The signal that is actually reliable, and the reason the feature exists. */
    it('flags something visible that the order excluded', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'ketchup', action: 'remove', priceDeltaCents: 0 }] })],
        { visible: ['beef patty', 'ketchup', 'sesame bun'], portionsInFrame: 1 },
      );

      expect(raisedFindings(findings)).toHaveLength(1);
      expect(raisedFindings(findings)[0]).toMatchObject({ kind: 'CONTRADICTION', line: 'Burger' });
      expect(needsASecondLook(findings)).toBe(true);
    });

    /**
     * The whole design rests on this. Food hides under buns and lids, so a
     * thing that was ordered and cannot be seen is not a fault - it is
     * recorded and never shown. An agent that says "I cannot see the
     * bacon" on every order is an agent nobody looks at by Friday.
     */
    it('never raises anything for something it simply could not see', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'bacon', action: 'add', priceDeltaCents: 250 }] })],
        { visible: ['sesame bun', 'lettuce'], portionsInFrame: 1 },
      );

      expect(raisedFindings(findings)).toHaveLength(0);
      expect(needsASecondLook(findings)).toBe(false);
    });

    /** An "on the side" is in a tub the camera may never see into. */
    it('never raises anything for a side order it cannot see into', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'garlic mayo', action: 'on_side', priceDeltaCents: 100 }] })],
        { visible: ['burger', 'paper bag'], portionsInFrame: 1 },
      );

      expect(raisedFindings(findings)).toHaveLength(0);
    });

    /** Recorded rather than never produced, so the check has an honest account of itself. */
    it('keeps the unverifiable finding in the record even though nobody is shown it', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'onions', action: 'remove', priceDeltaCents: 0 }] })],
        { visible: ['beef patty', 'cheese'], portionsInFrame: 1 },
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe('UNVERIFIABLE');
      expect(raisedFindings(findings)).toHaveLength(0);
    });
  });

  describe('matching what the camera named against what the order excluded', () => {
    /** An order says "no onions"; a camera says "red onion". Same thing. */
    it('matches across plurals and adjectives', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'onions', action: 'remove', priceDeltaCents: 0 }] })],
        { visible: ['sliced red onion'], portionsInFrame: null },
      );
      expect(raisedFindings(findings)).toHaveLength(1);
    });

    it('matches a specific cheese against a plain one', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'cheese', action: 'remove', priceDeltaCents: 0 }] })],
        { visible: ['melted cheddar cheese'], portionsInFrame: null },
      );
      expect(raisedFindings(findings)).toHaveLength(1);
    });

    /**
     * The false alarm that would get this switched off in a week: "no ham"
     * must not fire on a hamburger bun.
     */
    it('does not fire on a word that merely contains the excluded one', () => {
      const findings = classifyQcObservation(
        [line({ modifiers: [{ name: 'ham', action: 'remove', priceDeltaCents: 0 }] })],
        { visible: ['hamburger bun', 'beef patty'], portionsInFrame: null },
      );
      expect(raisedFindings(findings)).toHaveLength(0);
    });
  });

  describe('counting', () => {
    it('asks about a count that does not match', () => {
      const findings = classifyQcObservation([line({ quantity: 3 })], { visible: ['burger'], portionsInFrame: 2 });
      expect(raisedFindings(findings)).toHaveLength(1);
      expect(raisedFindings(findings)[0]?.kind).toBe('COUNT');
    });

    it('says nothing when the count agrees', () => {
      const findings = classifyQcObservation([line({ quantity: 2 })], { visible: ['burger'], portionsInFrame: 2 });
      expect(raisedFindings(findings)).toHaveLength(0);
    });

    /** "I cannot tell how many" is a normal answer, not a failure. */
    it('says nothing when the model could not count', () => {
      const findings = classifyQcObservation([line({ quantity: 2 })], { visible: ['burger'], portionsInFrame: null });
      expect(raisedFindings(findings)).toHaveLength(0);
    });
  });

  describe('the prompt', () => {
    /**
     * The PII rule, enforced by the shape of the function rather than by a
     * guard: buildQcPrompt is handed order lines and nothing else, so
     * there is no customer name, number or address for it to include.
     */
    it('is built from the food alone', () => {
      const prompt = buildQcPrompt([
        line({ name: 'Double burger', quantity: 2, modifiers: [{ name: 'onions', action: 'remove', priceDeltaCents: 0 }] }),
      ]);

      expect(prompt).toContain('2 x Double burger');
      expect(prompt).toContain('WITHOUT onions');
      // Nothing that could identify a person is even reachable from here.
      expect(prompt).not.toMatch(/phone|address|customer name|order #|\+\d{6,}/i);
    });

    /** Without this the model volunteers "I cannot see the cheese" on every order. */
    it('tells the model never to report something as missing', () => {
      expect(buildQcPrompt([line()])).toContain('NEVER report that something is missing');
    });

    /** A side-on photo sees into the layers; a top-down one sees a bun. */
    it('asks it to look into the layers rather than only at the top', () => {
      expect(buildQcPrompt([line()])).toContain('at the edges of a bun, in the layers of a sandwich');
    });
  });

  describe('reading the answer back', () => {
    it('takes a well-formed answer', () => {
      expect(parseObservation('{"visible":["ketchup","bun"],"portionsInFrame":2}')).toEqual({
        visible: ['ketchup', 'bun'],
        portionsInFrame: 2,
      });
    });

    /** A check that cannot read the photo finds nothing. It never blocks an order. */
    it('degrades to an empty observation rather than throwing', () => {
      for (const answer of ['not json at all', '', 'null', '[]', '{"visible":"ketchup"}']) {
        expect(parseObservation(answer)).toEqual({ visible: [], portionsInFrame: null });
      }
    });

    it('drops entries that are not usable strings', () => {
      expect(parseObservation('{"visible":["ketchup", 7, "  ", null, "bun"],"portionsInFrame":-1}')).toEqual({
        visible: ['ketchup', 'bun'],
        portionsInFrame: null,
      });
    });
  });
});

describe('the photo gate at the pass (real Postgres)', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
    // Off, so these tests are about the photo gate and nothing else.
    await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, null);
  });

  async function anOrderAtThePass() {
    const order = await repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [line({ name: 'Chicken roti', quantity: 2, unitPriceCents: 1200 })],
      subtotalCents: 2400,
      totalCents: 2400,
    });
    await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
    await repo.moveToStage(businessId, order.id, 'QUALITY_CHECK');
    return order;
  }

  /** Help a business opts into, never a step imposed on a kitchen that never asked for one. */
  it('is off until a business turns it on', async () => {
    const settings = await repo.getSettings(businessId);
    expect(settings.qcPhotoRequired).toBe(false);
    expect(settings.qcVisionEnabled).toBe(false);

    const order = await anOrderAtThePass();
    expect((await repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP'))?.stage).toBe('READY_FOR_PICKUP');
  });

  it('holds an order at the pass until it has been photographed', async () => {
    await repo.saveSettings(businessId, { qcPhotoRequired: true }, null);
    const order = await anOrderAtThePass();

    await expect(repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP')).rejects.toBeInstanceOf(QcPhotoRequiredError);

    await repo.recordQcCheck({ businessId, orderId: order.id, observation: { visible: [], portionsInFrame: null }, findings: [] });
    expect((await repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP'))?.stage).toBe('READY_FOR_PICKUP');
  });

  /**
   * The gate is on the way OUT of the pass only. A ticket must always be
   * able to REACH the pass, or the board backs up behind a camera.
   */
  it('never stops a ticket reaching the pass', async () => {
    await repo.saveSettings(businessId, { qcPhotoRequired: true }, null);
    const order = await repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [line()],
      subtotalCents: 1800,
      totalCents: 1800,
    });

    await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
    expect((await repo.moveToStage(businessId, order.id, 'QUALITY_CHECK'))?.stage).toBe('QUALITY_CHECK');
  });

  /** A broken camera or a queue out of the door. Attributable, so it stays the exception. */
  it('can be overridden with a reason, and the reason is recorded on the move', async () => {
    await repo.saveSettings(businessId, { qcPhotoRequired: true }, null);
    const order = await anOrderAtThePass();

    const moved = await repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP', {
      overrideQcPhoto: { reason: 'camera is broken' },
    });
    expect(moved?.stage).toBe('READY_FOR_PICKUP');

    const events = await repo.listEvents(businessId, order.id);
    expect(events.some((event) => event.note?.includes('camera is broken'))).toBe(true);
  });

  /** A finding nobody saw and a finding somebody looked at and dismissed are different facts. */
  it('records what a photo found, and what somebody did about it', async () => {
    const order = await anOrderAtThePass();
    const check = await repo.recordQcCheck({
      businessId,
      orderId: order.id,
      observation: { visible: ['ketchup'], portionsInFrame: 1 },
      findings: [
        { kind: 'CONTRADICTION', line: 'Burger', message: 'Burger was ordered without ketchup, but ketchup is visible.' },
        { kind: 'UNVERIFIABLE', line: 'Burger', message: 'Could not confirm the bacon.' },
      ],
    });

    // Both stored; only one of them counts as something a person was shown.
    expect(check.findings).toHaveLength(2);
    expect(check.raisedCount).toBe(1);

    expect(await repo.acknowledgeQcCheck(businessId, check.id, null, 'wiped it off')).toBe(true);
    // Acknowledging twice is not a second decision.
    expect(await repo.acknowledgeQcCheck(businessId, check.id, null, null)).toBe(false);

    const [stored] = await repo.listQcChecks(businessId, order.id);
    expect(stored?.acknowledgedAt).not.toBeNull();
    expect(stored?.acknowledgementNote).toBe('wiped it off');
  });

  it('does not show one business another\'s checks', async () => {
    const order = await anOrderAtThePass();
    await repo.recordQcCheck({ businessId, orderId: order.id, observation: {}, findings: [] });

    const otherBusinessId = await createTestBusiness('Someone Else');
    expect(await repo.listQcChecks(otherBusinessId, order.id)).toHaveLength(0);
    expect(await repo.hasQcCheck(otherBusinessId, order.id)).toBe(false);
  });
});
