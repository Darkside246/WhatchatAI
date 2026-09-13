import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Who takes the order.
 *
 * The agent has been able to read the menu, price an order and put a
 * ticket in front of a kitchen since the food vertical was built - handed
 * those tools automatically the moment the business had a menu row. There
 * was no setting, so there was no answer to "where do I set that up?" and
 * no way to turn it off for a Saturday night.
 *
 * The one thing these have to protect above all: a business that has never
 * opened the screen keeps exactly the behaviour it already had. A migration
 * that quietly switched somebody's ordering line off over a weekend would
 * be the worse mistake by a distance.
 */

describe('the order-taking setting', () => {
  let businessId: string;
  let repository: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    repository = new FoodOperationsRepository(pool);
  });

  it('defaults to FULL - what every existing business already has', async () => {
    expect((await repository.getSettings(businessId)).aiOrderTaking).toBe('FULL');
  });

  it('stores the owner\'s choice', async () => {
    await repository.saveSettings(businessId, { aiOrderTaking: 'QUOTE_ONLY' }, null);
    expect((await repository.getSettings(businessId)).aiOrderTaking).toBe('QUOTE_ONLY');
  });

  it('survives a save of some entirely unrelated setting', async () => {
    // saveSettings rewrites the whole row. A patch that mentions only the
    // table-service flag must not quietly put order-taking back to FULL -
    // which is precisely the shape of bug that turns a deliberate "you
    // take every order" back into an assistant sending tickets.
    await repository.saveSettings(businessId, { aiOrderTaking: 'OFF' }, null);
    await repository.saveSettings(businessId, { tableServiceEnabled: true }, null);

    const settings = await repository.getSettings(businessId);
    expect(settings.aiOrderTaking).toBe('OFF');
    expect(settings.tableServiceEnabled).toBe(true);
  });

  it('keeps the payment gate and the rest of the row intact when only this changes', async () => {
    await repository.saveSettings(businessId, { paymentRequiredBeforeKitchen: false, qcPhotoRequired: true }, null);
    await repository.saveSettings(businessId, { aiOrderTaking: 'QUOTE_ONLY' }, null);

    const settings = await repository.getSettings(businessId);
    expect(settings.paymentRequiredBeforeKitchen).toBe(false);
    expect(settings.qcPhotoRequired).toBe(true);
    expect(settings.aiOrderTaking).toBe('QUOTE_ONLY');
  });

  it('starts with no house rules and no prep time, rather than inventing either', async () => {
    // A default sentence here would be this app putting words in an
    // owner's mouth about their own kitchen, and a default prep time would
    // be a promise they never made.
    const settings = await repository.getSettings(businessId);
    expect(settings.orderTakingInstructions).toBeNull();
    expect(settings.typicalPrepMinutes).toBeNull();
  });

  it('stores the house rules verbatim', async () => {
    const rules = 'We need an hour on anything from the grill.\nNo substitutions on the combos.';
    await repository.saveSettings(businessId, { orderTakingInstructions: rules }, null);
    expect((await repository.getSettings(businessId)).orderTakingInstructions).toBe(rules);
  });

  it('keeps the house rules when the order-taking mode changes', async () => {
    await repository.saveSettings(businessId, { orderTakingInstructions: 'No substitutions.' }, null);
    await repository.saveSettings(businessId, { aiOrderTaking: 'QUOTE_ONLY' }, null);
    expect((await repository.getSettings(businessId)).orderTakingInstructions).toBe('No substitutions.');
  });

  it('stores a prep time and lets it be cleared back to unknown', async () => {
    await repository.saveSettings(businessId, { typicalPrepMinutes: 25 }, null);
    expect((await repository.getSettings(businessId)).typicalPrepMinutes).toBe(25);

    await repository.saveSettings(businessId, { typicalPrepMinutes: null }, null);
    expect((await repository.getSettings(businessId)).typicalPrepMinutes).toBeNull();
  });

  it('refuses a prep time that is not a real promise', async () => {
    await expect(repository.saveSettings(businessId, { typicalPrepMinutes: 0 }, null)).rejects.toThrow();
    await expect(repository.saveSettings(businessId, { typicalPrepMinutes: -5 }, null)).rejects.toThrow();
    await expect(repository.saveSettings(businessId, { typicalPrepMinutes: 10_000 }, null)).rejects.toThrow();
  });

  it('refuses a value that is not one of the three', async () => {
    // The check constraint is the last line: the route validates it too,
    // but a constraint that only exists in one of the two places is a
    // constraint somebody will eventually route around.
    await expect(
      repository.saveSettings(businessId, { aiOrderTaking: 'SOMETIMES' as never }, null),
    ).rejects.toThrow();
  });
});
