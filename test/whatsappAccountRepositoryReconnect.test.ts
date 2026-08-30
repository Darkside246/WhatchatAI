import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppAccountRepository.findActiveByBusiness (multi-tenant requireWorkspaceContext lookup)', () => {
  it('returns null for a business with no real WhatsApp account yet', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    expect(await repository.findActiveByBusiness(businessId)).toBeNull();
  });

  it('finds the account regardless of live connection_status - chat history lives in Postgres independent of socket state', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    const account = await repository.upsertConnected({
      businessId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Test',
      connectionStatus: 'CONNECTED',
    });
    await repository.markDisconnected(account.id, 'DISCONNECTED');

    const found = await repository.findActiveByBusiness(businessId);
    expect(found?.id).toBe(account.id);
  });

  it('never returns a soft-deleted account', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    const account = await repository.upsertConnected({
      businessId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Test',
      connectionStatus: 'CONNECTED',
    });
    await pool.query('UPDATE whatsapp_accounts SET deleted_at = now() WHERE id = $1', [account.id]);

    expect(await repository.findActiveByBusiness(businessId)).toBeNull();
  });
});

describe('WhatsAppAccountRepository.listReconnectableBusinesses (boot-time reconnection)', () => {
  it('returns nothing when no business has ever connected', async () => {
    await resetDatabase();
    const repository = new WhatsAppAccountRepository(pool);
    expect(await repository.listReconnectableBusinesses()).toEqual([]);
  });

  it('lists a business with a real, non-logged-out account', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    await repository.upsertConnected({
      businessId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Test',
      connectionStatus: 'CONNECTED',
    });

    expect(await repository.listReconnectableBusinesses()).toEqual([businessId]);
  });

  it('excludes a business whose account was explicitly logged out', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    const account = await repository.upsertConnected({
      businessId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Test',
      connectionStatus: 'CONNECTED',
    });
    await repository.markDisconnected(account.id, 'LOGGED_OUT');

    expect(await repository.listReconnectableBusinesses()).toEqual([]);
  });

  it('excludes a soft-deleted account', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    const account = await repository.upsertConnected({
      businessId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Test',
      connectionStatus: 'CONNECTED',
    });
    await pool.query('UPDATE whatsapp_accounts SET deleted_at = now() WHERE id = $1', [account.id]);

    expect(await repository.listReconnectableBusinesses()).toEqual([]);
  });

  it('returns exactly one row per business (DISTINCT ON), even with multiple historical account rows', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new WhatsAppAccountRepository(pool);
    await repository.upsertConnected({
      businessId,
      whatsappJid: '15550001111@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550001111',
      pushName: 'Old',
      connectionStatus: 'DISCONNECTED',
    });
    await repository.upsertConnected({
      businessId,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550002222',
      pushName: 'Newer',
      connectionStatus: 'CONNECTED',
    });

    const businessIds = await repository.listReconnectableBusinesses();
    expect(businessIds).toEqual([businessId]);
  });
});
