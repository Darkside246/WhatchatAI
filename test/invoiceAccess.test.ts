import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { pool } from '../src/db/pool.js';
import { createTestBusiness, resetDatabase } from './helpers.js';
import { BUSINESS_ROLES } from '../src/domain/auth/permissions.js';
import {
  canDelegateInvoiceManagement,
  canManageInvoices,
  DELEGABLE_INVOICE_ROLES,
} from '../src/domain/auth/invoiceAccess.js';

/**
 * Who may move money.
 *
 * A security review found every invoice route behind "is signed in" and
 * nothing else, so any member of the business could approve an invoice,
 * mark it paid, send it to a customer, void it or delete it - a VIEWER
 * included, whose entire role is the nine *.view permissions.
 *
 * The fix could have been a one-line permission change, but "who may raise
 * an invoice" is a real difference between businesses: a restaurant where
 * the owner does the books wants it locked down, a property firm with a
 * manager running the office does not. So it is a setting - and a setting
 * that grants access is only safe if the people it grants access TO cannot
 * turn it on. That is what these pin.
 */

const LOCKED = false;
const DELEGATED = true;

describe('with the setting off, which is how every business starts', () => {
  it('lets an owner and an admin manage invoices', () => {
    expect(canManageInvoices('OWNER', LOCKED)).toBe(true);
    expect(canManageInvoices('ADMIN', LOCKED)).toBe(true);
  });

  it('refuses everybody else, which is the hole that was found', () => {
    // The reported shape: a VIEWER approving an invoice and marking it paid.
    for (const role of ['MANAGER', 'SUPERVISOR', 'AGENT', 'MARKETING', 'VIEWER'] as const) {
      expect(canManageInvoices(role, LOCKED), `${role} can manage invoices with the setting off`).toBe(false);
    }
  });
});

describe('with the setting on', () => {
  it('adds the two supervisory roles, because that is what was delegated', () => {
    expect(canManageInvoices('MANAGER', DELEGATED)).toBe(true);
    expect(canManageInvoices('SUPERVISOR', DELEGATED)).toBe(true);
  });

  it('still refuses the front-line roles, however it is set', () => {
    // A delegation widens the circle of trusted people. It never opens the
    // door - an AGENT is a cook or a replier, and a VIEWER is read-only by
    // definition.
    for (const role of ['AGENT', 'MARKETING', 'VIEWER'] as const) {
      expect(canManageInvoices(role, DELEGATED), `${role} got invoice rights from the delegation`).toBe(false);
    }
  });

  it('changes nothing for an owner or admin in either direction', () => {
    for (const delegated of [LOCKED, DELEGATED]) {
      expect(canManageInvoices('OWNER', delegated)).toBe(true);
      expect(canManageInvoices('ADMIN', delegated)).toBe(true);
    }
  });
});

describe('the setting cannot be used to grant yourself access', () => {
  it('is changeable only by the roles it does not delegate to', () => {
    // The one way a delegation setting becomes an escalation: a manager who
    // can switch on manager invoicing has not been delegated anything.
    for (const role of DELEGABLE_INVOICE_ROLES) {
      expect(canDelegateInvoiceManagement(role), `${role} can grant itself invoice rights`).toBe(false);
    }
  });

  it('is changeable by an owner and an admin, and by nobody else at all', () => {
    const allowed = BUSINESS_ROLES.filter((role) => canDelegateInvoiceManagement(role));
    expect([...allowed].sort()).toEqual(['ADMIN', 'OWNER']);
  });
});

describe('the shape of the rule itself', () => {
  it('delegates to the supervisory roles and no others', () => {
    // Named here so widening it is a deliberate edit somebody has to make
    // in two places, not a quiet one-word change.
    expect([...DELEGABLE_INVOICE_ROLES]).toEqual(['MANAGER', 'SUPERVISOR']);
  });

  it('answers for every role the product has, with no gaps', () => {
    // A role added later that nothing decided about would read as false
    // here - which is the safe answer, and this proves it is reached.
    for (const role of BUSINESS_ROLES) {
      expect(typeof canManageInvoices(role, DELEGATED)).toBe('boolean');
      expect(typeof canManageInvoices(role, LOCKED)).toBe('boolean');
    }
  });
});

describe('storing the setting', () => {
  let businessId: string;
  const businesses = new BusinessRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('starts off, so nobody gains access the day this ships', () => {
    // The opposite default would quietly re-open the hole the review closed.
    return businesses.findById(businessId).then((business) => {
      expect(business?.invoiceManageDelegated).toBe(false);
    });
  });

  it('turns on and back off again', async () => {
    const on = await businesses.setInvoiceManageDelegated(businessId, true);
    expect(on?.invoiceManageDelegated).toBe(true);
    expect((await businesses.findById(businessId))?.invoiceManageDelegated).toBe(true);

    const off = await businesses.setInvoiceManageDelegated(businessId, false);
    expect(off?.invoiceManageDelegated).toBe(false);
  });

  it('is one business own decision, never the platform', async () => {
    const other = await createTestBusiness();
    await businesses.setInvoiceManageDelegated(businessId, true);
    expect((await businesses.findById(other))?.invoiceManageDelegated).toBe(false);
  });
});
