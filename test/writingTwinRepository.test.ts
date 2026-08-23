import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import { WritingTwinRepository } from '../src/repositories/writingTwinRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Phase W3 adversarial suite (repository/schema layer). Every claim here
 * is proven directly against the real migration 069_writing_twin.sql
 * constraints and the real WritingTwinRepository methods - never mocked.
 */
describe('WritingTwinRepository (real Postgres, W2-B structural boundaries)', () => {
  let repo: WritingTwinRepository;
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    repo = new WritingTwinRepository(pool);
    businessId = await createTestBusiness('Twin Business');
    userId = await createTestUser(businessId);
  });

  it('1. composite FK rejects a real business_id + real user_id that is not an actual membership', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    // userId is a member of businessId, not otherBusinessId - the pairing itself must be rejected.
    await expect(
      pool.query('INSERT INTO writing_twin_settings (business_id, user_id) VALUES ($1, $2)', [otherBusinessId, userId]),
    ).rejects.toThrow(/foreign key/i);
  });

  it('2. removing a business membership cascades to delete every Writing Twin row for that pair, and no others', async () => {
    const otherUserId = await createTestUser(businessId);
    await repo.setLearningEnabled(businessId, userId, true);
    await repo.setLearningEnabled(businessId, otherUserId, true);

    const { rows: membershipRows } = await pool.query<{ id: string }>(
      'SELECT id FROM business_memberships WHERE business_id = $1 AND user_id = $2',
      [businessId, userId],
    );
    await pool.query('DELETE FROM business_memberships WHERE id = $1', [membershipRows[0]?.id]);

    expect(await repo.getSettings(businessId, userId)).toBeNull();
    expect(await repo.getSettings(businessId, otherUserId)).not.toBeNull();
  });

  it('3. the partial unique index rejects a second is_current=true profile for the same (business, user, channel)', async () => {
    await pool.query(
      `INSERT INTO writing_twin_profiles (business_id, user_id, channel_scope, version_number, is_current) VALUES ($1, $2, 'email', 1, true)`,
      [businessId, userId],
    );
    await expect(
      pool.query(
        `INSERT INTO writing_twin_profiles (business_id, user_id, channel_scope, version_number, is_current) VALUES ($1, $2, 'email', 2, true)`,
        [businessId, userId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('4. provenance CHECK rejects both disallowed states on writing_twin_style_examples', async () => {
    for (const badProvenance of ['ai_generated_unchanged', 'unknown_or_ambiguous']) {
      await expect(
        pool.query(
          `INSERT INTO writing_twin_style_examples (business_id, user_id, channel_scope, source_provenance, example_text, source_table, source_row_id)
           VALUES ($1, $2, 'email', $3, 'x', 'email_messages', $4)`,
          [businessId, userId, badProvenance, crypto.randomUUID()],
        ),
      ).rejects.toThrow(/check constraint|violates/i);
    }
  });

  it('5. the raw_events baseline/provenance CHECK rejects a correction with no baseline and a non-correction with a baseline', async () => {
    await expect(
      pool.query(
        `INSERT INTO writing_twin_raw_events (business_id, user_id, channel_scope, provenance, source_table, source_row_id, final_text, expires_at)
         VALUES ($1, $2, 'email', 'ai_generated_then_edited', 'email_messages', $3, 'final', now() + interval '1 day')`,
        [businessId, userId, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/check constraint|violates/i);

    await expect(
      pool.query(
        `INSERT INTO writing_twin_raw_events (business_id, user_id, channel_scope, provenance, source_table, source_row_id, ai_baseline_text, final_text, expires_at)
         VALUES ($1, $2, 'email', 'human_authored', 'email_messages', $3, 'should not be here', 'final', now() + interval '1 day')`,
        [businessId, userId, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it('6. deleting a style example cascades its profile_derivations row, without touching the profile itself', async () => {
    const profile = await repo.createProfileVersion(businessId, userId, 'email', emptySignals(), []);
    const example = await repo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Real example text.', 'email_messages', crypto.randomUUID(), 30);
    await pool.query('INSERT INTO writing_twin_profile_derivations (profile_version_id, style_example_id) VALUES ($1, $2)', [
      profile.id,
      example?.id,
    ]);

    await repo.deleteStyleExample(businessId, userId, example!.id);

    const { rows } = await pool.query('SELECT * FROM writing_twin_profile_derivations WHERE profile_version_id = $1', [profile.id]);
    expect(rows).toHaveLength(0);
    expect(await repo.getCurrentProfile(businessId, userId, 'email')).not.toBeNull();
  });

  it('7. createProfileVersion atomically supersedes the prior current version - never two current rows, never zero', async () => {
    const v1 = await repo.createProfileVersion(businessId, userId, 'email', emptySignals(), []);
    expect(v1.isCurrent).toBe(true);
    expect(v1.versionNumber).toBe(1);

    const v2 = await repo.createProfileVersion(businessId, userId, 'email', { ...emptySignals(), preferredTone: 'concise' }, []);
    expect(v2.isCurrent).toBe(true);
    expect(v2.versionNumber).toBe(2);

    const { rows: currentRows } = await pool.query(
      `SELECT count(*)::int AS count FROM writing_twin_profiles WHERE business_id = $1 AND user_id = $2 AND channel_scope = 'email' AND is_current = true`,
      [businessId, userId],
    );
    expect(currentRows[0].count).toBe(1);

    const { rows: v1Row } = await pool.query('SELECT is_current, superseded_at FROM writing_twin_profiles WHERE id = $1', [v1.id]);
    expect(v1Row[0].is_current).toBe(false);
    expect(v1Row[0].superseded_at).not.toBeNull();
  });

  it('8. isProfileStale is false right after creation and true once an underlying example is deleted', async () => {
    const example = await repo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Real example.', 'email_messages', crypto.randomUUID(), 30);
    const profile = await repo.createProfileVersion(businessId, userId, 'email', emptySignals(), [example!.id]);

    expect(await repo.isProfileStale(businessId, userId, profile.id)).toBe(false);

    await repo.deleteStyleExample(businessId, userId, example!.id);

    expect(await repo.isProfileStale(businessId, userId, profile.id)).toBe(true);
  });

  it('9. profile/settings/example lookups never leak across business or user boundaries', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherUserId = await createTestUser(otherBusinessId);

    await repo.createProfileVersion(businessId, userId, 'email', { ...emptySignals(), preferredTone: 'concise' }, []);
    await repo.createProfileVersion(otherBusinessId, otherUserId, 'email', { ...emptySignals(), preferredTone: 'detailed' }, []);

    const mine = await repo.getCurrentProfile(businessId, userId, 'email');
    const theirs = await repo.getCurrentProfile(otherBusinessId, otherUserId, 'email');
    expect(mine?.preferredTone).toBe('concise');
    expect(theirs?.preferredTone).toBe('detailed');

    // A cross-pairing lookup (real business, real user, but not their real pairing) must return nothing.
    expect(await repo.getCurrentProfile(businessId, otherUserId, 'email')).toBeNull();
    expect(await repo.getCurrentProfile(otherBusinessId, userId, 'email')).toBeNull();
  });

  it('10. the example cap is enforced with oldest-first rotation once the cap is reached', async () => {
    for (let i = 0; i < 3; i += 1) {
      await repo.addStyleExample(businessId, userId, 'email', 'human_authored', `Example ${i}`, 'email_messages', crypto.randomUUID(), 3);
    }
    expect(await repo.countStyleExamples(businessId, userId, 'email')).toBe(3);

    await repo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Example newest', 'email_messages', crypto.randomUUID(), 3);

    const remaining = await repo.listStyleExamples(businessId, userId, 'email', 10);
    expect(remaining).toHaveLength(3);
    expect(remaining.some((e) => e.exampleText === 'Example 0')).toBe(false); // oldest evicted
    expect(remaining.some((e) => e.exampleText === 'Example newest')).toBe(true);
  });

  it('11. concurrent additions near the cap never jointly exceed it - the advisory lock serializes them', async () => {
    // Fill to exactly one below the cap.
    for (let i = 0; i < 2; i += 1) {
      await repo.addStyleExample(businessId, userId, 'email', 'human_authored', `Seed ${i}`, 'email_messages', crypto.randomUUID(), 3);
    }
    expect(await repo.countStyleExamples(businessId, userId, 'email')).toBe(2);

    // Two concurrent transactions both attempting to add the 3rd/4th example -
    // without the advisory lock, both could observe count=2 and both insert,
    // producing 4 examples against a cap of 3.
    await Promise.all([
      withTransaction(async (client) => {
        const txRepo = new WritingTwinRepository(client);
        await txRepo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Concurrent A', 'email_messages', crypto.randomUUID(), 3);
      }),
      withTransaction(async (client) => {
        const txRepo = new WritingTwinRepository(client);
        await txRepo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Concurrent B', 'email_messages', crypto.randomUUID(), 3);
      }),
    ]);

    // Cap enforcement rotates on overflow rather than rejecting, so the
    // count must never exceed the cap regardless of how the two
    // concurrent adds interleaved.
    expect(await repo.countStyleExamples(businessId, userId, 'email')).toBeLessThanOrEqual(3);
  });

  it('12. raw event text is encrypted at rest - the stored column value is not the plaintext', async () => {
    await repo.recordRawEvent(businessId, userId, 'email', 'human_authored', 'A secret real message.', null, 'email_messages', crypto.randomUUID(), 60);

    const { rows } = await pool.query<{ final_text: string }>(
      `SELECT final_text FROM writing_twin_raw_events WHERE business_id = $1 AND user_id = $2`,
      [businessId, userId],
    );
    expect(rows[0]?.final_text).not.toContain('A secret real message.');

    const [decrypted] = await repo.listUnprocessedRawEvents(businessId, userId, 'email');
    expect(decrypted?.finalText).toBe('A secret real message.');
  });

  it('13. listUnprocessedRawEvents never returns a row past its expires_at, even before the sweep reaches it', async () => {
    await repo.recordRawEvent(businessId, userId, 'email', 'human_authored', 'Should be invisible once expired.', null, 'email_messages', crypto.randomUUID(), 60);
    // Force expiry into the past directly - simulates "expired but not yet swept."
    await pool.query(`UPDATE writing_twin_raw_events SET expires_at = now() - interval '1 hour' WHERE business_id = $1 AND user_id = $2`, [
      businessId,
      userId,
    ]);

    const results = await repo.listUnprocessedRawEvents(businessId, userId, 'email');
    expect(results).toEqual([]);
  });

  it('14. sweepExpiredRawEvents deletes only rows past expires_at, regardless of processed_at, and leaves live rows untouched', async () => {
    await repo.recordRawEvent(businessId, userId, 'email', 'human_authored', 'Expired unprocessed.', null, 'email_messages', crypto.randomUUID(), 60);
    await repo.recordRawEvent(businessId, userId, 'email', 'human_authored', 'Expired processed.', null, 'email_messages', crypto.randomUUID(), 60);
    await repo.recordRawEvent(businessId, userId, 'email', 'human_authored', 'Still live.', null, 'email_messages', crypto.randomUUID(), 60);

    await pool.query(`UPDATE writing_twin_raw_events SET expires_at = now() - interval '1 hour' WHERE business_id = $1 AND user_id = $2`, [
      businessId,
      userId,
    ]);
    // Restore one row to "still live" and mark another "expired but processed."
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM writing_twin_raw_events WHERE business_id = $1 ORDER BY created_at', [businessId]);
    await pool.query('UPDATE writing_twin_raw_events SET expires_at = now() + interval \'1 day\' WHERE id = $1', [rows[2]?.id]);
    await pool.query('UPDATE writing_twin_raw_events SET processed_at = now() WHERE id = $1', [rows[1]?.id]);

    const deletedCount = await repo.sweepExpiredRawEvents();
    expect(deletedCount).toBeGreaterThanOrEqual(2);

    const { rows: remaining } = await pool.query('SELECT id FROM writing_twin_raw_events WHERE business_id = $1', [businessId]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(rows[2]?.id);
  });

  it('15. no public WritingTwinRepository method accepts an agentId parameter, and none is a generic unscoped lookup (structural check on the real source file)', async () => {
    const source = await readFile(new URL('../src/repositories/writingTwinRepository.ts', import.meta.url), 'utf8');
    // Matches an actual parameter declaration (agentId: ...), not prose
    // mentioning the concept in a comment explaining why it's absent.
    expect(source).not.toMatch(/\bagentId\s*:/);
    expect(source).not.toMatch(/\bidentityId\s*:/);
    expect(source).not.toMatch(/async\s+findById\s*\(/);
    expect(source).not.toMatch(/async\s+getById\s*\(/);
  });
});

function emptySignals() {
  return {
    preferredTone: null,
    formality: null,
    greetingStyle: null,
    signOffStyle: null,
    avgSentenceLengthBucket: null,
    punctuationEmphasis: null,
    emojiFrequency: null,
    directness: null,
    questionPattern: null,
    commonPhrases: [],
    commonSignOffs: [],
  };
}
