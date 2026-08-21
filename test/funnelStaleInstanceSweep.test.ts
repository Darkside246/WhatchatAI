import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { FunnelRepository } from '../src/repositories/funnelRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { createFunnel, replaceFunnelSteps, setFunnelActive, enrollContact, sweepStaleFunnelInstances } from '../src/services/funnelService.js';
import { createTestAccount, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

async function makeContactWithChat(businessId: string, accountId: string, jid: string) {
  const contactRepo = new WhatsAppContactRepository(pool);
  const chatRepo = new WhatsAppChatRepository(pool);
  const contact = await contactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: jid, jidKind: 'individual', phoneNumber: `+${jid.split('@')[0]}`, pushName: 'Contact' });
  await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: jid, jidKind: 'individual', chatType: 'individual', contactId: contact.id });
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source) VALUES ($1, $2, 'whatsapp_inbound') RETURNING id`, [businessId, contact.id]);
  return rows[0]!.id;
}

/**
 * sweepStaleFunnelInstances is deliberately not "WAITING for a long
 * time" - a WAIT node's own delay can legitimately be days. The real
 * signal is the instance's own recorded resume_at (the moment its
 * delayed funnel_advance job is expected to fire) having passed with the
 * instance still WAITING - see migration 059 and funnelService.ts.
 */
describe('sweepStaleFunnelInstances (real Postgres, resume_at-based staleness, never "WAITING too long")', () => {
  let businessId: string;
  let accountId: string;
  let ownerId: string;
  const funnels = new FunnelRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountId = await createTestAccount(businessId);
  });

  async function enrollWaitingInstance(jid: string) {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Delayed Follow-up', null);
    await replaceFunnelSteps(businessId, funnel.id, [
      { nodeType: 'WAIT', config: { minutes: 60 } },
      { nodeType: 'MESSAGE', config: { text: 'Following up' } },
    ]);
    await setFunnelActive(businessId, funnel.id, true);
    const crmContactId = await makeContactWithChat(businessId, accountId, jid);
    return enrollContact(businessId, funnel.id, crmContactId);
  }

  it('a real WAIT step records a real resume_at timestamp in the future, not just the WAITING status', async () => {
    const instance = await enrollWaitingInstance('15559993001@s.whatsapp.net');
    expect(instance.status).toBe('WAITING');
    expect(instance.resumeAt).not.toBeNull();
    expect(new Date(instance.resumeAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('reconciles an instance whose resume_at passed long ago to FAILED, with a real, honest lastError', async () => {
    const instance = await enrollWaitingInstance('15559993002@s.whatsapp.net');
    await pool.query(`UPDATE funnel_instances SET resume_at = now() - interval '2 hours' WHERE id = $1`, [instance.id]);

    await sweepStaleFunnelInstances();

    const updated = await funnels.findInstanceById(instance.id);
    expect(updated?.status).toBe('FAILED');
    expect(updated?.lastError).toContain('Abandoned mid-wait');
  });

  it('notifies the business so a stuck funnel is visible, not silent', async () => {
    const instance = await enrollWaitingInstance('15559993003@s.whatsapp.net');
    await pool.query(`UPDATE funnel_instances SET resume_at = now() - interval '2 hours' WHERE id = $1`, [instance.id]);

    await sweepStaleFunnelInstances();

    const notifications = new NotificationRepository(pool);
    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'AUTOMATION_FAILURE' && n.targetId === instance.id)).toBe(true);
  });

  it('leaves a WAITING instance whose resume_at is still in the future alone - a long WAIT is not itself a failure', async () => {
    const instance = await enrollWaitingInstance('15559993004@s.whatsapp.net');
    // Simulates a real, legitimately long WAIT node (e.g. "wait 3 days") -
    // resume_at is genuinely in the future, nothing has gone wrong.
    await pool.query(`UPDATE funnel_instances SET resume_at = now() + interval '3 days' WHERE id = $1`, [instance.id]);

    await sweepStaleFunnelInstances();

    const updated = await funnels.findInstanceById(instance.id);
    expect(updated?.status).toBe('WAITING');
    expect(updated?.lastError).toBeNull();
  });

  it('leaves a WAITING instance recently past its resume_at alone (grace window) - a slow worker is not the same as a lost job', async () => {
    const instance = await enrollWaitingInstance('15559993005@s.whatsapp.net');
    // Just past resume_at, well inside the default 600s grace window.
    await pool.query(`UPDATE funnel_instances SET resume_at = now() - interval '30 seconds' WHERE id = $1`, [instance.id]);

    await sweepStaleFunnelInstances();

    const updated = await funnels.findInstanceById(instance.id);
    expect(updated?.status).toBe('WAITING');
  });

  it('never touches an ACTIVE or COMPLETED instance regardless of its resume_at', async () => {
    const funnel = await createFunnel(businessId, accountId, ownerId, 'Instant', null);
    await replaceFunnelSteps(businessId, funnel.id, [{ nodeType: 'ADD_TAG', config: { tag: 'x' } }]);
    await setFunnelActive(businessId, funnel.id, true);
    const crmContactId = await makeContactWithChat(businessId, accountId, '15559993006@s.whatsapp.net');
    const completed = await enrollContact(businessId, funnel.id, crmContactId);
    expect(completed.status).toBe('COMPLETED');

    // Even with a stale-looking resume_at forced onto it, a non-WAITING row must never be touched.
    await pool.query(`UPDATE funnel_instances SET resume_at = now() - interval '2 hours' WHERE id = $1`, [completed.id]);
    await sweepStaleFunnelInstances();

    const updated = await funnels.findInstanceById(completed.id);
    expect(updated?.status).toBe('COMPLETED');
  });
});
