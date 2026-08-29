import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { OperatorCommandService, generatePinSalt, hashPin } from '../src/services/operator/operatorCommandService.js';
import { OperatorModeRepository } from '../src/repositories/operatorModeRepository.js';
import { PropertyOperationsRepository } from '../src/repositories/propertyOperationsRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

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

async function createTestProperty(businessId: string, name: string): Promise<string> {
  const repo = new PropertyOperationsRepository(pool);
  const property = await repo.createProperty({
    id: randomUUID(),
    businessId,
    name,
    propertyType: 'VILLA',
    status: 'ACTIVE',
    addressLine1: null,
    addressLine2: null,
    city: null,
    countryCode: null,
    timezone: null,
    guestInstructions: null,
    emergencyInstructions: null,
  });
  return property.id;
}

describe('OperatorCommandService - "note for [property]: [text]"', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('actually persists the note against the matched property - the stub used to just say "queued" and save nothing', async () => {
    await createTestProperty(businessId, 'Sunset Villa');
    const service = await authenticatedService(businessId, accountId);

    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'note for Sunset Villa: pool filter needs replacing');
    expect(result.reply).toContain('Sunset Villa');
    expect(result.reply).toContain('pool filter needs replacing');
    expect(result.reply).not.toContain('next release');

    const propertyRepo = new PropertyOperationsRepository(pool);
    const [property] = await propertyRepo.findPropertiesByNameForBusiness(businessId, 'Sunset Villa');
    const notes = await propertyRepo.listPropertyNotes(businessId, property!.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toBe('pool filter needs replacing');
    expect(notes[0]!.createdByJid).toContain('12461234567');
  });

  it('never writes to the guest-facing guest_instructions field - internal notes must not leak to customers', async () => {
    const propertyId = await createTestProperty(businessId, 'Ocean Breeze');
    const service = await authenticatedService(businessId, accountId);

    await service.handle(businessId, accountId, OPERATOR_JID, 'note for Ocean Breeze: owner wants weekly check-ins');

    const propertyRepo = new PropertyOperationsRepository(pool);
    const property = await propertyRepo.getProperty(businessId, propertyId);
    expect(property?.guestInstructions).toBeNull();
  });

  it('reports honestly, and saves nothing, when no property matches', async () => {
    const service = await authenticatedService(businessId, accountId);
    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'note for Nonexistent Place: test');
    expect(result.reply).toContain('No property matching');

    const propertyRepo = new PropertyOperationsRepository(pool);
    const matches = await propertyRepo.findPropertiesByNameForBusiness(businessId, 'Nonexistent Place');
    expect(matches).toHaveLength(0);
  });

  it('reports ambiguity rather than guessing when multiple properties match', async () => {
    await createTestProperty(businessId, 'Beach House North');
    await createTestProperty(businessId, 'Beach House South');
    const service = await authenticatedService(businessId, accountId);

    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'note for Beach House: leak reported');
    expect(result.reply).toContain('more than one property');
    expect(result.reply).toContain('Beach House North');
    expect(result.reply).toContain('Beach House South');
  });

  it('tenant isolation - a note cannot be created against another business\'s property', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestProperty(otherBusinessId, 'Other Business Villa');
    const service = await authenticatedService(businessId, accountId);

    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'note for Other Business Villa: should not work');
    expect(result.reply).toContain('No property matching');
  });
});
