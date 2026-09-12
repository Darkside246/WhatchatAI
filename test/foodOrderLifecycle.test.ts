import { describe, expect, it } from 'vitest';
import {
  FOOD_ORDER_STAGES,
  OPEN_STAGES,
  allowedNextStages,
  bumpTarget,
  canTransition,
  elapsedSeconds,
  isOpenStage,
  slaBand,
  stageAfterQualityCheck,
  type FoodOrderStage,
} from '../src/domain/food/orderLifecycle.js';

describe('how an order moves through the kitchen', () => {
  it('runs the whole way for a collection order', () => {
    let stage: FoodOrderStage = 'NEW';
    for (const next of ['IN_KITCHEN', 'QUALITY_CHECK', 'READY_FOR_PICKUP', 'COMPLETED'] as const) {
      expect(canTransition(stage, next)).toBe(true);
      stage = next;
    }
  });

  it('runs the whole way for a delivery order', () => {
    let stage: FoodOrderStage = 'NEW';
    for (const next of ['IN_KITCHEN', 'QUALITY_CHECK', 'OUT_FOR_DELIVERY', 'COMPLETED'] as const) {
      expect(canTransition(stage, next)).toBe(true);
      stage = next;
    }
  });

  /** The branch is decided by what the customer asked for, never by whoever is on the pass. */
  it('branches at the pass on how the customer wanted it', () => {
    expect(stageAfterQualityCheck('DELIVERY')).toBe('OUT_FOR_DELIVERY');
    expect(stageAfterQualityCheck('PICKUP')).toBe('READY_FOR_PICKUP');
  });

  describe('goes backwards only where a real kitchen needs it', () => {
    /** An expediter who finds a missing side sends the ticket back to the line. */
    it('from the pass back to the line', () => {
      expect(canTransition('QUALITY_CHECK', 'IN_KITCHEN')).toBe(true);
    });

    /** A bump bar pressed by accident has to be undoable. */
    it('from the line back to a ticket not yet accepted', () => {
      expect(canTransition('IN_KITCHEN', 'NEW')).toBe(true);
    });

    it('from a counter that has not been collected from yet', () => {
      expect(canTransition('READY_FOR_PICKUP', 'QUALITY_CHECK')).toBe(true);
    });

    /**
     * But never once the food has physically left. A driver cannot
     * un-leave, and a board that said otherwise would be lying about where
     * the food is.
     */
    it('never once a driver has it', () => {
      expect(canTransition('OUT_FOR_DELIVERY', 'QUALITY_CHECK')).toBe(false);
      expect(canTransition('OUT_FOR_DELIVERY', 'IN_KITCHEN')).toBe(false);
      // Cancelling stays possible, because a delivery can genuinely fail.
      expect(canTransition('OUT_FOR_DELIVERY', 'CANCELLED')).toBe(true);
    });
  });

  it('lets nothing out of a finished order', () => {
    expect(allowedNextStages('COMPLETED')).toEqual([]);
    expect(allowedNextStages('CANCELLED')).toEqual([]);
  });

  it('can be cancelled from anywhere it is still live', () => {
    for (const stage of OPEN_STAGES) expect(canTransition(stage, 'CANCELLED')).toBe(true);
  });

  it('knows which stages are still somebody\'s job', () => {
    expect(FOOD_ORDER_STAGES.filter(isOpenStage)).toEqual([...OPEN_STAGES]);
    expect(isOpenStage('COMPLETED')).toBe(false);
    expect(isOpenStage('CANCELLED')).toBe(false);
  });
});

describe('the bump button', () => {
  /** One gesture, the same at every station - which is how a line actually works. */
  it('moves a collection order one station at a time', () => {
    expect(bumpTarget('NEW', 'PICKUP')).toBe('IN_KITCHEN');
    expect(bumpTarget('IN_KITCHEN', 'PICKUP')).toBe('QUALITY_CHECK');
    expect(bumpTarget('QUALITY_CHECK', 'PICKUP')).toBe('READY_FOR_PICKUP');
    expect(bumpTarget('READY_FOR_PICKUP', 'PICKUP')).toBe('COMPLETED');
  });

  it('sends a delivery order to a driver instead of the counter', () => {
    expect(bumpTarget('QUALITY_CHECK', 'DELIVERY')).toBe('OUT_FOR_DELIVERY');
    expect(bumpTarget('OUT_FOR_DELIVERY', 'DELIVERY')).toBe('COMPLETED');
  });

  it('has nothing left to do on a finished order', () => {
    expect(bumpTarget('COMPLETED', 'PICKUP')).toBeNull();
    expect(bumpTarget('CANCELLED', 'DELIVERY')).toBeNull();
  });

  it('only ever proposes a legal move', () => {
    for (const stage of FOOD_ORDER_STAGES) {
      for (const fulfilment of ['PICKUP', 'DELIVERY'] as const) {
        const target = bumpTarget(stage, fulfilment);
        if (target) expect(canTransition(stage, target)).toBe(true);
      }
    }
  });
});

describe('the SLA clock', () => {
  it('uses the bands a kitchen screen has always used', () => {
    expect(slaBand(0)).toBe('ON_TIME');
    expect(slaBand(9 * 60 + 59)).toBe('ON_TIME');
    expect(slaBand(10 * 60)).toBe('WARNING');
    expect(slaBand(14 * 60 + 59)).toBe('WARNING');
    expect(slaBand(15 * 60)).toBe('BREACHED');
  });

  it('honours a business that cooks to a different clock', () => {
    expect(slaBand(6 * 60, { warningSeconds: 5 * 60, breachSeconds: 8 * 60 })).toBe('WARNING');
    expect(slaBand(9 * 60, { warningSeconds: 5 * 60, breachSeconds: 8 * 60 })).toBe('BREACHED');
  });

  /**
   * Measured from when the customer placed it, not from when the kitchen
   * accepted it. A ticket that sat unnoticed for eight minutes is already
   * eight minutes late to the customer, and a clock starting at acceptance
   * would hide exactly the delay worth seeing.
   */
  it('counts from when the customer ordered, not from when the kitchen noticed', () => {
    const now = new Date('2026-09-12T12:20:00Z');
    const order = { placedAt: '2026-09-12T12:00:00Z', stage: 'IN_KITCHEN' as const, closedAt: null };
    expect(elapsedSeconds(order, now)).toBe(20 * 60);
    expect(slaBand(elapsedSeconds(order, now))).toBe('BREACHED');
  });

  /** A finished order does not go on turning redder in a history view. */
  it('stops when the order is finished', () => {
    const now = new Date('2026-09-12T18:00:00Z');
    const order = { placedAt: '2026-09-12T12:00:00Z', stage: 'COMPLETED' as const, closedAt: '2026-09-12T12:12:00Z' };
    expect(elapsedSeconds(order, now)).toBe(12 * 60);
  });

  it('never reports a negative age, whatever the clocks say', () => {
    const order = { placedAt: '2026-09-12T12:00:00Z', stage: 'NEW' as const, closedAt: null };
    expect(elapsedSeconds(order, new Date('2026-09-12T11:00:00Z'))).toBe(0);
  });
});
