import type { Queryable } from './types.js';
import { getEncryptionService } from '../security/encryption/index.js';
import type {
  ChannelScope,
  LearningEligibleProvenance,
  WritingTwinSignals,
  WritingTwinSourceTable,
} from '../domain/writingTwin/types.js';

export interface WritingTwinSettingsRecord {
  id: string;
  businessId: string;
  userId: string;
  learningEnabled: boolean;
  historicalBackfillRequestedAt: string | null;
  historicalBackfillCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WritingTwinProfileRecord extends WritingTwinSignals {
  id: string;
  businessId: string;
  userId: string;
  channelScope: ChannelScope;
  versionNumber: number;
  isCurrent: boolean;
  exampleCount: number;
  computedAt: string;
  supersededAt: string | null;
}

export interface WritingTwinStyleExampleRecord {
  id: string;
  businessId: string;
  userId: string;
  channelScope: ChannelScope;
  sourceProvenance: LearningEligibleProvenance;
  /** Decrypted plaintext - never the raw stored envelope. */
  exampleText: string;
  sourceTable: WritingTwinSourceTable;
  sourceRowId: string;
  addedAt: string;
}

export interface WritingTwinRawEventRecord {
  id: string;
  businessId: string;
  userId: string;
  channelScope: Exclude<ChannelScope, 'global'>;
  provenance: LearningEligibleProvenance;
  sourceTable: WritingTwinSourceTable;
  sourceRowId: string;
  /** Decrypted plaintext, null only when provenance is not a correction. */
  aiBaselineText: string | null;
  /** Decrypted plaintext. */
  finalText: string;
  processedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

interface SettingsRow {
  id: string;
  business_id: string;
  user_id: string;
  learning_enabled: boolean;
  historical_backfill_requested_at: string | null;
  historical_backfill_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toSettingsRecord(row: SettingsRow): WritingTwinSettingsRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    learningEnabled: row.learning_enabled,
    historicalBackfillRequestedAt: row.historical_backfill_requested_at,
    historicalBackfillCompletedAt: row.historical_backfill_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ProfileRow {
  id: string;
  business_id: string;
  user_id: string;
  channel_scope: ChannelScope;
  version_number: number;
  is_current: boolean;
  preferred_tone: WritingTwinSignals['preferredTone'];
  formality: WritingTwinSignals['formality'];
  greeting_style: WritingTwinSignals['greetingStyle'];
  sign_off_style: WritingTwinSignals['signOffStyle'];
  avg_sentence_length_bucket: WritingTwinSignals['avgSentenceLengthBucket'];
  punctuation_emphasis: WritingTwinSignals['punctuationEmphasis'];
  emoji_frequency: WritingTwinSignals['emojiFrequency'];
  directness: WritingTwinSignals['directness'];
  question_pattern: WritingTwinSignals['questionPattern'];
  common_phrases: string[];
  common_sign_offs: string[];
  example_count: number;
  computed_at: string;
  superseded_at: string | null;
}

function toProfileRecord(row: ProfileRow): WritingTwinProfileRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    channelScope: row.channel_scope,
    versionNumber: row.version_number,
    isCurrent: row.is_current,
    preferredTone: row.preferred_tone,
    formality: row.formality,
    greetingStyle: row.greeting_style,
    signOffStyle: row.sign_off_style,
    avgSentenceLengthBucket: row.avg_sentence_length_bucket,
    punctuationEmphasis: row.punctuation_emphasis,
    emojiFrequency: row.emoji_frequency,
    directness: row.directness,
    questionPattern: row.question_pattern,
    commonPhrases: row.common_phrases,
    commonSignOffs: row.common_sign_offs,
    exampleCount: row.example_count,
    computedAt: row.computed_at,
    supersededAt: row.superseded_at,
  };
}

interface StyleExampleRow {
  id: string;
  business_id: string;
  user_id: string;
  channel_scope: ChannelScope;
  source_provenance: LearningEligibleProvenance;
  example_text: string;
  source_table: WritingTwinSourceTable;
  source_row_id: string;
  added_at: string;
}

interface RawEventRow {
  id: string;
  business_id: string;
  user_id: string;
  channel_scope: Exclude<ChannelScope, 'global'>;
  provenance: LearningEligibleProvenance;
  source_table: WritingTwinSourceTable;
  source_row_id: string;
  ai_baseline_text: string | null;
  final_text: string;
  processed_at: string | null;
  expires_at: string;
  created_at: string;
}

/**
 * Phase W3. Every method except sweepExpiredRawEvents requires both
 * businessId and userId - there is no generic find-by-id method for any
 * of the five tables, and no method accepts an agentId anywhere. That
 * absence is the fail-closed AI-attribution boundary approved in W2-A/
 * W2-B: an autonomous AI-agent reply path has no way to call into this
 * repository at all, because nothing here has a shape that would accept
 * its identity instead of a real authenticated user's.
 */
export class WritingTwinRepository {
  constructor(private readonly db: Queryable) {}

  // --- Settings ---

  async getSettings(businessId: string, userId: string): Promise<WritingTwinSettingsRecord | null> {
    const { rows } = await this.db.query<SettingsRow>(
      `SELECT * FROM writing_twin_settings WHERE business_id = $1 AND user_id = $2`,
      [businessId, userId],
    );
    return rows[0] ? toSettingsRecord(rows[0]) : null;
  }

  async setLearningEnabled(businessId: string, userId: string, enabled: boolean): Promise<WritingTwinSettingsRecord> {
    const { rows } = await this.db.query<SettingsRow>(
      `INSERT INTO writing_twin_settings (business_id, user_id, learning_enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, user_id) DO UPDATE SET learning_enabled = $3, updated_at = now()
       RETURNING *`,
      [businessId, userId, enabled],
    );
    const row = rows[0];
    if (!row) throw new Error('writing_twin_settings upsert returned no row');
    return toSettingsRecord(row);
  }

  async recordBackfillRequested(businessId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO writing_twin_settings (business_id, user_id, historical_backfill_requested_at)
       VALUES ($1, $2, now())
       ON CONFLICT (business_id, user_id) DO UPDATE SET historical_backfill_requested_at = now(), updated_at = now()`,
      [businessId, userId],
    );
  }

  async recordBackfillCompleted(businessId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE writing_twin_settings SET historical_backfill_completed_at = now(), updated_at = now()
       WHERE business_id = $1 AND user_id = $2`,
      [businessId, userId],
    );
  }

  // --- Tier A: profiles ---

  /** The single "at most one current" row per channel - never inferred from computed_at, always the real is_current flag. */
  async getCurrentProfile(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinProfileRecord | null> {
    const { rows } = await this.db.query<ProfileRow>(
      `SELECT * FROM writing_twin_profiles
       WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3 AND is_current = true`,
      [businessId, userId, channelScope],
    );
    return rows[0] ? toProfileRecord(rows[0]) : null;
  }

  /** Backs the channel fallback hierarchy (channel -> global -> none) - one query, applied in the service layer. */
  async getAllCurrentProfilesForUser(businessId: string, userId: string): Promise<WritingTwinProfileRecord[]> {
    const { rows } = await this.db.query<ProfileRow>(
      `SELECT * FROM writing_twin_profiles WHERE business_id = $1 AND user_id = $2 AND is_current = true`,
      [businessId, userId],
    );
    return rows.map(toProfileRecord);
  }

  /**
   * Compares the profile version's recorded example_count against the
   * live count of surviving derivation rows. A deleted style example
   * cascades its derivation row away, so a live count lower than the
   * recorded example_count means at least one piece of evidence this
   * profile was built from no longer exists - detectable, not assumed.
   */
  async isProfileStale(businessId: string, userId: string, profileVersionId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ example_count: number; live_count: string }>(
      `SELECT p.example_count,
              (SELECT count(*)::text FROM writing_twin_profile_derivations d WHERE d.profile_version_id = p.id) AS live_count
       FROM writing_twin_profiles p
       WHERE p.business_id = $1 AND p.user_id = $2 AND p.id = $3`,
      [businessId, userId, profileVersionId],
    );
    const row = rows[0];
    if (!row) return true; // a nonexistent profile is trivially "not usable"
    return Number(row.live_count) < row.example_count;
  }

  /**
   * Creates a new immutable profile version and, in the same
   * transaction, flips any prior is_current row to false before
   * inserting the new one - the partial unique index would reject a
   * transient moment where two rows are simultaneously current, so the
   * UPDATE must precede the INSERT, both inside one transaction (the
   * caller is responsible for passing a transactional client here, per
   * withTransaction's established re-instantiate-the-repository pattern).
   */
  async createProfileVersion(
    businessId: string,
    userId: string,
    channelScope: ChannelScope,
    signals: WritingTwinSignals,
    derivedFromExampleIds: string[],
  ): Promise<WritingTwinProfileRecord> {
    await this.db.query(
      `UPDATE writing_twin_profiles SET is_current = false, superseded_at = now()
       WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3 AND is_current = true`,
      [businessId, userId, channelScope],
    );

    const { rows: versionRows } = await this.db.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
       FROM writing_twin_profiles WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3`,
      [businessId, userId, channelScope],
    );
    const nextVersion = versionRows[0]?.next_version ?? 1;

    const { rows } = await this.db.query<ProfileRow>(
      `INSERT INTO writing_twin_profiles (
         business_id, user_id, channel_scope, version_number, is_current,
         preferred_tone, formality, greeting_style, sign_off_style,
         avg_sentence_length_bucket, punctuation_emphasis, emoji_frequency,
         directness, question_pattern, common_phrases, common_sign_offs, example_count
       ) VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        businessId,
        userId,
        channelScope,
        nextVersion,
        signals.preferredTone,
        signals.formality,
        signals.greetingStyle,
        signals.signOffStyle,
        signals.avgSentenceLengthBucket,
        signals.punctuationEmphasis,
        signals.emojiFrequency,
        signals.directness,
        signals.questionPattern,
        signals.commonPhrases,
        signals.commonSignOffs,
        derivedFromExampleIds.length,
      ],
    );
    const profile = rows[0];
    if (!profile) throw new Error('writing_twin_profiles insert returned no row');

    if (derivedFromExampleIds.length > 0) {
      const values = derivedFromExampleIds.map((_, index) => `($1, $${index + 2})`).join(', ');
      await this.db.query(
        `INSERT INTO writing_twin_profile_derivations (profile_version_id, style_example_id) VALUES ${values}`,
        [profile.id, ...derivedFromExampleIds],
      );
    }

    return toProfileRecord(profile);
  }

  // --- Tier B: style examples ---

  async countStyleExamples(businessId: string, userId: string, channelScope: ChannelScope): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM writing_twin_style_examples
       WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3`,
      [businessId, userId, channelScope],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async listStyleExamples(businessId: string, userId: string, channelScope: ChannelScope, limit: number): Promise<WritingTwinStyleExampleRecord[]> {
    const { rows } = await this.db.query<StyleExampleRow>(
      `SELECT * FROM writing_twin_style_examples
       WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3
       ORDER BY added_at DESC LIMIT $4`,
      [businessId, userId, channelScope, limit],
    );
    return Promise.all(rows.map((row) => this.toStyleExampleRecord(businessId, row)));
  }

  /**
   * Enforces the cap in a concurrency-safe way: a Postgres advisory
   * transaction lock keyed by (business_id, user_id, channel_scope)
   * serializes every add for that exact triple, so two simultaneous
   * calls that would both otherwise observe "29 examples, room for one
   * more" cannot both insert - the second waits for the first's
   * transaction to commit, then re-counts and correctly finds the cap
   * already reached. The caller must pass a transactional client (see
   * WritingTwinService.recordApprovedExample) so the lock and the
   * count+insert are all part of one transaction and the lock is
   * released automatically on commit/rollback (pg_advisory_xact_lock,
   * not the session-scoped pg_advisory_lock).
   */
  async addStyleExample(
    businessId: string,
    userId: string,
    channelScope: ChannelScope,
    provenance: LearningEligibleProvenance,
    exampleText: string,
    sourceTable: WritingTwinSourceTable,
    sourceRowId: string,
    maxExamplesPerChannel: number,
  ): Promise<WritingTwinStyleExampleRecord | null> {
    await this.db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `writing_twin_examples:${businessId}:${userId}:${channelScope}`,
    ]);

    const currentCount = await this.countStyleExamples(businessId, userId, channelScope);
    if (currentCount >= maxExamplesPerChannel) {
      await this.deleteOldestStyleExample(businessId, userId, channelScope);
    }

    const envelope = await getEncryptionService().encryptField(businessId, exampleText);
    const { rows } = await this.db.query<StyleExampleRow>(
      `INSERT INTO writing_twin_style_examples
         (business_id, user_id, channel_scope, source_provenance, example_text, source_table, source_row_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, user_id, channel_scope, source_table, source_row_id) DO NOTHING
       RETURNING *`,
      [businessId, userId, channelScope, provenance, getEncryptionService().serialize(envelope), sourceTable, sourceRowId],
    );
    const row = rows[0];
    if (!row) return null; // this exact source message was already captured as an example
    return this.toStyleExampleRecord(businessId, row);
  }

  async deleteOldestStyleExample(businessId: string, userId: string, channelScope: ChannelScope): Promise<void> {
    await this.db.query(
      `DELETE FROM writing_twin_style_examples WHERE id = (
         SELECT id FROM writing_twin_style_examples
         WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3
         ORDER BY added_at ASC LIMIT 1
       )`,
      [businessId, userId, channelScope],
    );
  }

  async deleteStyleExample(businessId: string, userId: string, exampleId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM writing_twin_style_examples WHERE id = $1 AND business_id = $2 AND user_id = $3`,
      [exampleId, businessId, userId],
    );
  }

  private async toStyleExampleRecord(businessId: string, row: StyleExampleRow): Promise<WritingTwinStyleExampleRecord> {
    const envelope = getEncryptionService().tryParse(row.example_text);
    const exampleText = envelope ? await getEncryptionService().decryptField(businessId, envelope) : row.example_text;
    return {
      id: row.id,
      businessId: row.business_id,
      userId: row.user_id,
      channelScope: row.channel_scope,
      sourceProvenance: row.source_provenance,
      exampleText,
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      addedAt: row.added_at,
    };
  }

  // --- Tier C: raw events ---

  async recordRawEvent(
    businessId: string,
    userId: string,
    channelScope: Exclude<ChannelScope, 'global'>,
    provenance: LearningEligibleProvenance,
    finalText: string,
    aiBaselineText: string | null,
    sourceTable: WritingTwinSourceTable,
    sourceRowId: string,
    retentionDays: number,
  ): Promise<void> {
    const finalEnvelope = await getEncryptionService().encryptField(businessId, finalText);
    const baselineEnvelope = aiBaselineText !== null ? await getEncryptionService().encryptField(businessId, aiBaselineText) : null;

    await this.db.query(
      `INSERT INTO writing_twin_raw_events
         (business_id, user_id, channel_scope, provenance, source_table, source_row_id, ai_baseline_text, final_text, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' days')::interval)`,
      [
        businessId,
        userId,
        channelScope,
        provenance,
        sourceTable,
        sourceRowId,
        baselineEnvelope ? getEncryptionService().serialize(baselineEnvelope) : null,
        getEncryptionService().serialize(finalEnvelope),
        retentionDays,
      ],
    );
  }

  /**
   * The ONLY method on this repository that reads Tier C content - no
   * other method exposes a raw event to any caller. Filters
   * expires_at > now() unconditionally, independent of whether the
   * sweep has reached an expired row yet: "expired" means ineligible
   * immediately, not merely eligible-for-future-deletion.
   */
  async listUnprocessedRawEvents(businessId: string, userId: string, channelScope: Exclude<ChannelScope, 'global'>): Promise<WritingTwinRawEventRecord[]> {
    const { rows } = await this.db.query<RawEventRow>(
      `SELECT * FROM writing_twin_raw_events
       WHERE business_id = $1 AND user_id = $2 AND channel_scope = $3
         AND processed_at IS NULL AND expires_at > now()`,
      [businessId, userId, channelScope],
    );
    return Promise.all(rows.map((row) => this.toRawEventRecord(businessId, row)));
  }

  async markRawEventProcessed(businessId: string, userId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE writing_twin_raw_events SET processed_at = now() WHERE id = $1 AND business_id = $2 AND user_id = $3`,
      [id, businessId, userId],
    );
  }

  /** The one deliberately tenant-agnostic method - a time-based delete has no "wrong business" failure mode to guard against. */
  async sweepExpiredRawEvents(): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM writing_twin_raw_events WHERE expires_at < now()`);
    return rowCount ?? 0;
  }

  private async toRawEventRecord(businessId: string, row: RawEventRow): Promise<WritingTwinRawEventRecord> {
    const finalEnvelope = getEncryptionService().tryParse(row.final_text);
    const finalText = finalEnvelope ? await getEncryptionService().decryptField(businessId, finalEnvelope) : row.final_text;

    let aiBaselineText: string | null = null;
    if (row.ai_baseline_text) {
      const baselineEnvelope = getEncryptionService().tryParse(row.ai_baseline_text);
      aiBaselineText = baselineEnvelope ? await getEncryptionService().decryptField(businessId, baselineEnvelope) : row.ai_baseline_text;
    }

    return {
      id: row.id,
      businessId: row.business_id,
      userId: row.user_id,
      channelScope: row.channel_scope,
      provenance: row.provenance,
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      aiBaselineText,
      finalText,
      processedAt: row.processed_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  // --- Deletion (see WritingTwinService.deleteAll for the transaction wrapper) ---

  async deleteRawEvents(businessId: string, userId: string): Promise<void> {
    await this.db.query(`DELETE FROM writing_twin_raw_events WHERE business_id = $1 AND user_id = $2`, [businessId, userId]);
  }

  async deleteStyleExamples(businessId: string, userId: string): Promise<void> {
    // Cascades writing_twin_profile_derivations rows referencing these examples automatically.
    await this.db.query(`DELETE FROM writing_twin_style_examples WHERE business_id = $1 AND user_id = $2`, [businessId, userId]);
  }

  async deleteProfiles(businessId: string, userId: string): Promise<void> {
    // Cascades any remaining writing_twin_profile_derivations rows automatically.
    await this.db.query(`DELETE FROM writing_twin_profiles WHERE business_id = $1 AND user_id = $2`, [businessId, userId]);
  }

  async deleteSettings(businessId: string, userId: string): Promise<void> {
    await this.db.query(`DELETE FROM writing_twin_settings WHERE business_id = $1 AND user_id = $2`, [businessId, userId]);
  }
}
