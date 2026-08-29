import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { OperatorCommandService, generatePinSalt, hashPin } from '../src/services/operator/operatorCommandService.js';
import { OperatorModeRepository } from '../src/repositories/operatorModeRepository.js';
import { ReminderRepository } from '../src/repositories/reminderRepository.js';
import { aiGateway, type RegisteredAiProvider } from '../src/services/ai/aiGateway.js';
import { createTestAccount, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
let ownerCounter = 0;

const OPERATOR_JID = '12461234567@s.whatsapp.net';
const PIN = '1234';

async function setupOperator(businessId: string): Promise<void> {
  const opRepo = new OperatorModeRepository(pool);
  const salt = generatePinSalt();
  await opRepo.upsertSettings({
    businessId,
    operatorWaJid: OPERATOR_JID,
    pinSalt: salt,
    pinHash: hashPin(PIN, salt),
    pinN: 16384,
    pinR: 8,
    pinP: 1,
    enabled: true,
  });
}

async function authenticatedService(businessId: string, accountId: string): Promise<OperatorCommandService> {
  await setupOperator(businessId);
  const service = new OperatorCommandService(pool);
  await service.handle(businessId, accountId, OPERATOR_JID, 'anything');
  await service.handle(businessId, accountId, OPERATOR_JID, PIN);
  return service;
}

/**
 * Grants a product account + entitlement so the entitled-path tests don't
 * depend on real billing setup. 'property' is already seeded by
 * 906_product_accounts_and_entitlements.sql, so this looks it up rather
 * than re-inserting it.
 */
async function grantAssistantEntitlement(businessId: string, ownerUserId: string): Promise<void> {
  const { rows: catalog } = await pool.query<{ id: string }>(`SELECT id FROM product_catalog WHERE product_key = 'property'`);
  const { rows: account } = await pool.query<{ id: string }>(
    `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name) VALUES ($1, $2, $3, 'ACTIVE', 'test') RETURNING id`,
    [businessId, catalog[0]!.id, ownerUserId],
  );
  await pool.query(
    `INSERT INTO product_entitlements (product_account_id, entitlement_key, is_enabled, source) VALUES ($1, 'ai_personal_assistant', true, 'PLAN')`,
    [account[0]!.id],
  );
}

describe('OperatorCommandService - named AI assistant mode', () => {
  let businessId: string;
  let ownerId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerCounter += 1;
    const owner = await register(
      { email: `assistant-owner-${ownerCounter}@example.com`, password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountId = await createTestAccount(businessId);
  });

  describe('set assistant name to [name]', () => {
    it('saves a valid name', async () => {
      const service = await authenticatedService(businessId, accountId);
      const result = await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to Aria');
      expect(result.reply).toContain('Aria');

      const settings = await new OperatorModeRepository(pool).getSettings(businessId);
      expect(settings?.assistantName).toBe('Aria');
    });

    it('rejects a name that collides with a reserved exit phrase', async () => {
      const service = await authenticatedService(businessId, accountId);
      const result = await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to bye');
      expect(result.reply).toContain('reserved exit phrase');

      const settings = await new OperatorModeRepository(pool).getSettings(businessId);
      expect(settings?.assistantName).toBeNull();
    });

    it('rejects a name that includes a leading slash', async () => {
      const service = await authenticatedService(businessId, accountId);
      const result = await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to /Aria');
      expect(result.reply).toContain('Do not include the "/"');
    });
  });

  describe('/<name> trigger', () => {
    it('does nothing (falls through to normal commands) when no assistant name is set', async () => {
      const service = await authenticatedService(businessId, accountId);
      const result = await service.handle(businessId, accountId, OPERATOR_JID, '/Aria');
      // No assistant configured yet - "/Aria" is not a recognised command either, so UNKNOWN.
      expect(result.reply).toContain("didn't understand");
    });

    it('refuses to enter assistant mode when the business lacks the entitlement', async () => {
      const service = await authenticatedService(businessId, accountId);
      await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to Aria');

      const result = await service.handle(businessId, accountId, OPERATOR_JID, '/Aria');
      expect(result.reply).toContain("isn't included in your current plan");

      const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
      expect(session?.interactionMode).toBe('COMMAND'); // never entered
    });

    it('enters assistant mode when entitled, matching the name case-insensitively', async () => {
      await grantAssistantEntitlement(businessId, ownerId);
      const service = await authenticatedService(businessId, accountId);
      await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to Aria');

      const result = await service.handle(businessId, accountId, OPERATOR_JID, '/aria');
      expect(result.reply).toContain('Aria');

      const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
      expect(session?.interactionMode).toBe('ASSISTANT');
    });

    it('does not trigger on a message that merely starts with the name plus other text', async () => {
      await grantAssistantEntitlement(businessId, ownerId);
      const service = await authenticatedService(businessId, accountId);
      await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to Aria');

      await service.handle(businessId, accountId, OPERATOR_JID, '/Aria please help me');
      const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
      expect(session?.interactionMode).toBe('COMMAND'); // exact match only
    });
  });

  describe('exit phrases', () => {
    for (const phrase of ['/bye', '/later', '/exit', '/BYE']) {
      it(`"${phrase}" leaves assistant mode back to COMMAND`, async () => {
        await grantAssistantEntitlement(businessId, ownerId);
        const service = await authenticatedService(businessId, accountId);
        await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to Aria');
        await service.handle(businessId, accountId, OPERATOR_JID, '/Aria');

        const result = await service.handle(businessId, accountId, OPERATOR_JID, phrase);
        expect(result.reply).toContain('Leaving');

        const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
        expect(session?.interactionMode).toBe('COMMAND');
      });
    }

    it('a rigid command word like "bye" (no slash) still logs out entirely, unaffected by assistant mode', async () => {
      const service = await authenticatedService(businessId, accountId);
      const result = await service.handle(businessId, accountId, OPERATOR_JID, 'bye');
      expect(result.reply).toContain('ended');

      const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
      expect(session).toBeNull();
    });
  });

  describe('natural-language routing (fake provider, no real Gemini call)', () => {
    let fakeProvider: RegisteredAiProvider;

    beforeEach(() => {
      fakeProvider = {
        name: 'fake-assistant-test',
        model: 'fake-model',
        priority: 1,
        async capabilities() {
          return { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: true };
        },
        async generate(input) {
          // First call: the model "decides" to create a reminder. Second call
          // (pendingToolCalls present): the model gives its final answer.
          if (!input.pendingToolCalls?.length) {
            return {
              provider: this.name,
              text: '',
              toolCalls: [{ name: 'create_reminder', args: { message: 'Reorder towels', dueAtIso: new Date(Date.now() + 3_600_000).toISOString() } }],
            };
          }
          return { provider: this.name, text: "Got it, I'll remind you." };
        },
      };
      aiGateway.register(fakeProvider);
    });

    afterEach(() => {
      aiGateway.unregister(fakeProvider.name);
    });

    it('routes free text through the AI and executes the create_reminder tool call it returns', async () => {
      await grantAssistantEntitlement(businessId, ownerId);
      const service = await authenticatedService(businessId, accountId);
      await service.handle(businessId, accountId, OPERATOR_JID, 'set assistant name to Aria');
      await service.handle(businessId, accountId, OPERATOR_JID, '/Aria');

      const result = await service.handle(businessId, accountId, OPERATOR_JID, 'remind me to reorder towels in an hour');
      expect(result.reply).toContain("I'll remind you");

      const reminders = await new ReminderRepository(pool).listUpcoming(businessId);
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.message).toBe('Reorder towels');
      expect(reminders[0]!.notifyJid).toBe(OPERATOR_JID);
    });
  });
});
