import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import {
  createFunnel,
  replaceFunnelSteps,
  setFunnelActive,
  enrollContact,
  getFunnel,
  cancelFunnelInstance,
  isInvalidFunnelStepError,
  isAlreadyEnrolledError,
} from '../src/services/funnelService.js';
import { createTestAccount, resetDatabase } from './helpers.js';
import { isEntitlementDeniedError } from '../src/services/workspaceService.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

async function makeContactWithChat(businessId: string, accountId: string, jid: string) {
  const contactRepo = new WhatsAppContactRepository(pool);
  const chatRepo = new WhatsAppChatRepository(pool);
  const contact = await contactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: jid, jidKind: 'individual', phoneNumber: `+${jid.split('@')[0]}`, pushName: 'Contact' });
  await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: jid, jidKind: 'individual', chatType: 'individual', contactId: contact.id });
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source) VALUES ($1, $2, 'whatsapp_inbound') RETURNING id`, [businessId, contact.id]);
  return rows[0]!.id;
}

describe('funnelService (real step execution, real backend actions only)', () => {
  let businessId: string;
  let accountId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountId = await createTestAccount(businessId);
  });

  it('cannot activate a funnel with no steps, and cannot edit steps while active', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Welcome Series', null);
    await expect(setFunnelActive(businessId, funnel.id, true)).rejects.toThrow();

    await replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'MESSAGE', config: { text: 'Hi!' } }]);
    const active = await setFunnelActive(businessId, funnel.id, true);
    expect(active.isActive).toBe(true);

    await expect(replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'MESSAGE', config: { text: 'Edited' } }])).rejects.toThrow();
    try {
      await replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'MESSAGE', config: { text: 'Edited' } }]);
    } catch (error) {
      expect(isInvalidFunnelStepError(error)).toBe(true);
    }
  });

  it('enforces the real per-plan max_active_funnels entitlement - a new business defaults to the Starter plan (limit 1)', async () => {
    const first = await createFunnel(businessId, accountId, ownerId, 'Funnel 1', null);
    await replaceFunnelSteps(businessId, first.id, [{ nodeType: 'MESSAGE', config: { text: 'Hi' } }]);
    await setFunnelActive(businessId, first.id, true);

    const second = await createFunnel(businessId, accountId, ownerId, 'Funnel 2', null);
    await replaceFunnelSteps(businessId, second.id, [{ nodeType: 'MESSAGE', config: { text: 'Hi' } }]);
    await expect(setFunnelActive(businessId, second.id, true)).rejects.toThrow();
    try {
      await setFunnelActive(businessId, second.id, true);
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) expect(error.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
    }
  });

  it('validates step config per node type - rejects a MESSAGE step with no text and a CONDITION with an out-of-range target', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Bad Steps', null);
    await expect(replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'MESSAGE', config: {} }])).rejects.toThrow();
    await expect(
      replaceFunnelSteps(businessId, funnel.id, [
        { nodeType: 'CONDITION', config: { field: 'stage', equals: 'x', matchStepPosition: 5 } },
      ]),
    ).rejects.toThrow();
  });

  it('enrolling a contact runs real steps: a MESSAGE step actually queues a real outbound message, then the funnel completes', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Welcome Series', null);
    await replaceFunnelSteps(businessId, funnel.id, [
      { nodeType: 'MESSAGE', config: { text: 'Welcome!' } },
      { nodeType: 'ADD_TAG', config: { tag: 'onboarded' } },
    ]);
    await setFunnelActive(businessId, funnel.id, true);

    const crmContactId = await makeContactWithChat(businessId, accountId, '15559991001@s.whatsapp.net');
    const instance = await enrollContact(businessId, funnel.id, crmContactId);
    expect(instance.status).toBe('COMPLETED');
    expect(instance.currentPosition).toBe(2);

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM whatsapp_outbound_messages WHERE business_id = $1', [businessId]);
    expect(Number(rows[0]!.count)).toBe(1);

    const { rows: tagRows } = await pool.query<{ tags: string[] }>('SELECT tags FROM crm_contacts WHERE id = $1', [crmContactId]);
    expect(tagRows[0]!.tags).toContain('onboarded');
  });

  it('a WAIT step pauses the instance in WAITING status rather than fabricating completion', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Delayed Follow-up', null);
    await replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'WAIT', config: { minutes: 60 } }, { nodeType: 'MESSAGE', config: { text: 'Following up' } }]);
    await setFunnelActive(businessId, funnel.id, true);

    const crmContactId = await makeContactWithChat(businessId, accountId, '15559991002@s.whatsapp.net');
    const instance = await enrollContact(businessId, funnel.id, crmContactId);
    expect(instance.status).toBe('WAITING');
    expect(instance.currentPosition).toBe(1);
  });

  it('refuses to enroll the same contact twice, and refuses a contact with no existing conversation', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'x', null);
    await replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'ADD_TAG', config: { tag: 'x' } }]);
    await setFunnelActive(businessId, funnel.id, true);

    const crmContactId = await makeContactWithChat(businessId, accountId, '15559991003@s.whatsapp.net');
    await enrollContact(businessId, funnel.id, crmContactId);
    await expect(enrollContact(businessId, funnel.id, crmContactId)).rejects.toThrow();
    try {
      await enrollContact(businessId, funnel.id, crmContactId);
    } catch (error) {
      expect(isAlreadyEnrolledError(error)).toBe(true);
    }

    const { rows } = await pool.query<{ id: string }>(`INSERT INTO crm_contacts (business_id, source) VALUES ($1, 'manual') RETURNING id`, [businessId]);
    await expect(enrollContact(businessId, funnel.id, rows[0]!.id)).rejects.toThrow();
  });

  it('a CONDITION step branches based on real CRM data', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Branching', null);
    await replaceFunnelSteps(businessId, funnel.id, [
      { nodeType: 'CONDITION', config: { field: 'stage', equals: 'qualified', matchStepPosition: 2, elseStepPosition: 1 } },
      { nodeType: 'ADD_TAG', config: { tag: 'not-qualified' } },
      { nodeType: 'ADD_TAG', config: { tag: 'qualified-path' } },
    ]);
    await setFunnelActive(businessId, funnel.id, true);

    const crmContactId = await makeContactWithChat(businessId, accountId, '15559991004@s.whatsapp.net');
    await pool.query('UPDATE crm_contacts SET stage = $2 WHERE id = $1', [crmContactId, 'qualified']);

    const instance = await enrollContact(businessId, funnel.id, crmContactId);
    expect(instance.status).toBe('COMPLETED');
    const { rows } = await pool.query<{ tags: string[] }>('SELECT tags FROM crm_contacts WHERE id = $1', [crmContactId]);
    expect(rows[0]!.tags).toContain('qualified-path');
    expect(rows[0]!.tags).not.toContain('not-qualified');
  });

  it('validates the new WAIT-until-local-time shape without breaking the original minutes-based validation', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Time-based wait', null);

    // Neither minutes nor untilLocalTime - still rejected exactly like before this feature existed.
    await expect(replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'WAIT', config: {} }])).rejects.toThrow();

    // A malformed local time string is rejected.
    await expect(
      replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'WAIT', config: { untilLocalTime: '25:99' } }]),
    ).rejects.toThrow();

    // An invalid weekday name is rejected.
    await expect(
      replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'WAIT', config: { untilLocalTime: '09:00', untilDayOfWeek: 'FUNDAY' } }]),
    ).rejects.toThrow();

    // A valid untilLocalTime (with no weekday) is accepted.
    await expect(
      replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'WAIT', config: { untilLocalTime: '09:00' } }]),
    ).resolves.toBeDefined();
  });

  it('a WAIT-until-local-time step pauses the instance in WAITING, resolved against the business timezone', async () => {
    await pool.query('UPDATE businesses SET timezone = $2 WHERE id = $1', [businessId, 'America/New_York']);

    const funnel = await createFunnel(businessId, accountId, ownerId, 'Morning follow-up', null);
    await replaceFunnelSteps(businessId, funnel.id, [
      { nodeType: 'WAIT', config: { untilLocalTime: '09:00' } },
      { nodeType: 'MESSAGE', config: { text: 'Good morning!' } },
    ]);
    await setFunnelActive(businessId, funnel.id, true);

    const crmContactId = await makeContactWithChat(businessId, accountId, '15559991006@s.whatsapp.net');
    const instance = await enrollContact(businessId, funnel.id, crmContactId);
    expect(instance.status).toBe('WAITING');
    expect(instance.currentPosition).toBe(1);
  });

  it('cancelling a running instance stops it for real', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'x', null);
    await replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'WAIT', config: { minutes: 60 } }]);
    await setFunnelActive(businessId, funnel.id, true);
    const crmContactId = await makeContactWithChat(businessId, accountId, '15559991005@s.whatsapp.net');
    const instance = await enrollContact(businessId, funnel.id, crmContactId);

    const cancelled = await cancelFunnelInstance(businessId, funnel.id, instance.id);
    expect(cancelled.status).toBe('CANCELLED');

    const detail = await getFunnel(businessId, funnel.id);
    expect(detail.counts.cancelled).toBe(1);
  });
});
