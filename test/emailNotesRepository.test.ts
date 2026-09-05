import { describe, expect, it } from 'vitest';
import { queryAsTenant } from '../src/db/pool.js';
import { EmailNotesRepository } from '../src/repositories/emailNotesRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

describe('EmailNotesRepository (real Postgres) - notes + the Reminders card built from remindAt', () => {
  it('creates and lists a plain note with no remindAt', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const repo = new EmailNotesRepository(queryAsTenant(businessId));

    const note = await repo.create(businessId, userId, 'Follow up with the vendor');
    expect(note.remindAt).toBeNull();

    const notes = await repo.list(businessId, userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe('Follow up with the vendor');
  });

  it('listUpcomingReminders returns only notes with a real remindAt, soonest first', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const repo = new EmailNotesRepository(queryAsTenant(businessId));

    await repo.create(businessId, userId, 'No due date - never a reminder');
    await repo.create(businessId, userId, 'Due later', new Date(Date.now() + 2 * 86_400_000).toISOString());
    await repo.create(businessId, userId, 'Due sooner', new Date(Date.now() + 86_400_000).toISOString());

    const reminders = await repo.listUpcomingReminders(businessId, userId);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]?.body).toBe('Due sooner');
    expect(reminders[1]?.body).toBe('Due later');
  });

  it('a user only ever sees their own notes, even within the same business', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const otherUserId = await createTestUser(businessId);
    const repo = new EmailNotesRepository(queryAsTenant(businessId));

    await repo.create(businessId, userId, 'Mine');
    await repo.create(businessId, otherUserId, 'Theirs');

    expect(await repo.list(businessId, userId)).toHaveLength(1);
    expect(await repo.list(businessId, otherUserId)).toHaveLength(1);
  });

  it('delete only removes the caller\'s own note', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const otherUserId = await createTestUser(businessId);
    const repo = new EmailNotesRepository(queryAsTenant(businessId));

    const note = await repo.create(businessId, otherUserId, 'Not yours');
    expect(await repo.delete(businessId, userId, note.id)).toBe(false);
    expect(await repo.delete(businessId, otherUserId, note.id)).toBe(true);
  });
});
