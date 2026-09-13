import { describe, expect, it } from 'vitest';
import { elapsedSeconds, slaBand, slaClock } from '../src/domain/food/orderLifecycle.js';

/**
 * Whose delay is it.
 *
 * The clock ran from the moment an order was placed, always. For a business
 * that takes payment before the kitchen starts, that counted the time the
 * order spent waiting on the CUSTOMER - so a slow payer turned into a red
 * ticket and a breached SLA, and the kitchen was blamed for time it was
 * never given. Worse, it hollowed out the one number on the board that is
 * supposed to mean "we are behind": once some of the red is other people's
 * money, none of the red means anything.
 *
 * So where payment gates the kitchen, the clock starts when the money
 * arrives. Everywhere else nothing changes at all.
 */

const PLACED = '2026-09-13T12:00:00.000Z';
const PAID = '2026-09-13T12:30:00.000Z';
const NOW = new Date('2026-09-13T12:40:00.000Z');

describe('an order waiting on the customer', () => {
  const waiting = { placedAt: PLACED, paymentState: 'UNPAID', paidAt: null };

  it('has not started its clock at all', () => {
    expect(slaClock(waiting).startedAt).toBeNull();
  });

  it('says it is waiting, which is not the same as being on time', () => {
    expect(slaClock(waiting).waitingForPayment).toBe(true);
  });

  it('shows no elapsed time rather than forty minutes of somebody else delay', () => {
    expect(elapsedSeconds({ ...waiting, stage: 'NEW', closedAt: null }, NOW)).toBe(0);
  });

  it('cannot breach while it has not started', () => {
    // The failure that made the board's colours meaningless: every slow
    // payer eventually went red.
    const elapsed = elapsedSeconds({ ...waiting, stage: 'NEW', closedAt: null }, new Date('2026-09-14T12:00:00.000Z'));
    expect(slaBand(elapsed)).toBe('ON_TIME');
  });
});

describe('once the money arrives', () => {
  const paid = { placedAt: PLACED, paymentState: 'PAID', paidAt: PAID };

  it('starts the clock then, not when the order was placed', () => {
    expect(slaClock(paid).startedAt).toBe(PAID);
  });

  it('counts only the kitchen time', () => {
    // Ten minutes since payment, not forty since the order.
    expect(elapsedSeconds({ ...paid, stage: 'IN_KITCHEN', closedAt: null }, NOW)).toBe(600);
  });

  it('is no longer waiting', () => {
    expect(slaClock(paid).waitingForPayment).toBe(false);
  });

  it('never starts the clock in the past for a prepayment reconciled afterwards', () => {
    // Money recorded against an order that was placed later. Taking the
    // earlier of the two would hand the kitchen a head start it never had.
    const prepaid = { placedAt: PAID, paymentState: 'PAID', paidAt: PLACED };
    expect(slaClock(prepaid).startedAt).toBe(PAID);
  });
});

describe('a business that does not wait for money', () => {
  it('runs from placement, exactly as it always has', () => {
    const open = { placedAt: PLACED, paymentState: 'NOT_REQUIRED', paidAt: null };
    expect(slaClock(open).startedAt).toBe(PLACED);
    expect(elapsedSeconds({ ...open, stage: 'IN_KITCHEN', closedAt: null }, NOW)).toBe(2_400);
  });

  it('does the same for a customer with terms', () => {
    // The regular who settles weekly is not making the kitchen wait.
    const terms = { placedAt: PLACED, paymentState: 'WAIVED', paidAt: null };
    expect(slaClock(terms).startedAt).toBe(PLACED);
    expect(slaClock(terms).waitingForPayment).toBe(false);
  });
});

describe('what has not changed', () => {
  it('still stops at completion rather than reddening forever in history', () => {
    const done = {
      placedAt: PLACED,
      paymentState: 'PAID',
      paidAt: PAID,
      stage: 'COMPLETED' as const,
      closedAt: '2026-09-13T12:35:00.000Z',
    };
    expect(elapsedSeconds(done, NOW)).toBe(300);
  });

  it('keeps the old behaviour for a caller that knows nothing about payment', () => {
    // paymentState absent means a caller predating any of this, and it
    // must keep measuring from placement.
    expect(elapsedSeconds({ placedAt: PLACED, stage: 'NEW', closedAt: null }, NOW)).toBe(2_400);
  });

  it('still refuses a timestamp that is not one', () => {
    expect(elapsedSeconds({ placedAt: 'not a date', stage: 'NEW', closedAt: null }, NOW)).toBe(0);
  });
});
