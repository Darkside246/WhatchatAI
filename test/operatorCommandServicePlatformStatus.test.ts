import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { OperatorCommandService, generatePinSalt, hashPin } from '../src/services/operator/operatorCommandService.js';
import { OperatorModeRepository } from '../src/repositories/operatorModeRepository.js';
import { createTestAccount, createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const OPERATOR_JID = '12461234567@s.whatsapp.net';
const PIN = '1234';

async function authenticatedService(businessId: string, accountId: string): Promise<OperatorCommandService> {
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

  const service = new OperatorCommandService(pool);
  await service.handle(businessId, accountId, OPERATOR_JID, 'anything'); // issues the PIN challenge
  await service.handle(businessId, accountId, OPERATOR_JID, PIN); // authenticates
  return service;
}

describe('OperatorCommandService - "platform status" (developer-only, cross-business)', () => {
  it('gives a business owned by a platform DEVELOPER real cross-business counts and uptime', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const userId = await createTestUser(businessId);
    await pool.query(`UPDATE users SET platform_role = 'DEVELOPER' WHERE id = $1`, [userId]);

    // A second, unrelated business - proves the count is real and platform-wide, not scoped to the caller's own business.
    await createTestBusiness('Other Business');

    const service = await authenticatedService(businessId, accountId);
    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'platform status');

    expect(result.reply).toContain('Platform Status');
    expect(result.reply).toContain('Businesses: 2');
    expect(result.reply).toContain('WhatsApp connections: 1 active, 0 inactive');
    expect(result.reply).toMatch(/Server uptime: [\d.]+h/);
  });

  it('never reveals the command exists to a business with no platform DEVELOPER member', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    await createTestUser(businessId); // regular CLIENT, never promoted

    const service = await authenticatedService(businessId, accountId);
    const unknownResult = await service.handle(businessId, accountId, OPERATOR_JID, 'blah blah not a command');
    const platformResult = await service.handle(businessId, accountId, OPERATOR_JID, 'platform status');

    // Same generic "I didn't understand" shape as any unrecognized command - it
    // echoes back whatever text was sent, so compare the surrounding template,
    // not exact equality, and confirm it never leaks that this command exists.
    expect(platformResult.reply).toContain(`I didn't understand: _"platform status"_`);
    expect(platformResult.reply).toContain('Send *help* for a list of commands.');
    expect(unknownResult.reply).toContain(`I didn't understand: _"blah blah not a command"_`);
    expect(platformResult.reply).not.toContain('Platform Status');
  });
});
