import { getEncryptionService } from '../security/encryption/index.js';
import type { Queryable } from './types.js';

/**
 * The synthesised profile fields, in one place.
 *
 * Exported as a real array rather than only a type because three separate
 * things need to iterate the actual field list at runtime - the repository's
 * own encrypt/decrypt loops, the synthesis prompt, and the edit route's
 * validation. Deriving all three from one list is what stops a field being
 * added to the table and then silently never encrypted, never synthesised,
 * or never editable.
 */
export const BRAND_DNA_FIELDS = [
  'brandIdentity',
  'ownerPersonality',
  'positioning',
  'targetCustomer',
  'customerProblems',
  'competitiveAdvantages',
  'brandValues',
  'toneOfVoice',
  'preferredVocabulary',
  'wordsToAvoid',
  'brandPersonality',
  'marketingPriorities',
  'socialChannels',
  'contentPreferences',
  'customerExpectations',
  'localContext',
  'differentiators',
  'brandStory',
  'marketingOpportunities',
  'contentAngles',
  'growthOpportunities',
] as const;

export type BrandDnaField = (typeof BRAND_DNA_FIELDS)[number];

/** camelCase field -> real column name. Built once from the list above so the two cannot drift. */
const COLUMN_OF: Record<BrandDnaField, string> = Object.fromEntries(
  BRAND_DNA_FIELDS.map((field) => [field, field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]),
) as Record<BrandDnaField, string>;

export type BrandDnaStatus = 'in_progress' | 'complete';

export type BrandDnaProfileRecord = {
  businessId: string;
  status: BrandDnaStatus;
  synthesisedAt: string | null;
  createdAt: string;
  updatedAt: string;
} & { [K in BrandDnaField]: string | null };

export interface BrandDnaAnswerRecord {
  id: string;
  businessId: string;
  questionKey: string;
  questionText: string | null;
  answerText: string | null;
  skipped: boolean;
  answeredByUserId: string;
  createdAt: string;
}

export interface RecordAnswerInput {
  businessId: string;
  questionKey: string;
  questionText: string | null;
  answerText: string | null;
  skipped: boolean;
  /**
   * The real dashboard user answering. Required, and deliberately not
   * defaultable: this is the provenance guarantee that keeps a customer's
   * WhatsApp message from ever becoming a fact about the business. A caller
   * that cannot name a user has no business writing here.
   */
  answeredByUserId: string;
}

async function decryptField(businessId: string, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const envelope = getEncryptionService().tryParse(value);
  // Not an envelope: a plaintext value written before encryption existed,
  // or a test fixture. Returned as-is rather than thrown away - losing the
  // owner's own words would be worse than reading a legacy row.
  if (!envelope) return value;
  return getEncryptionService().decryptField(businessId, envelope);
}

async function encryptField(businessId: string, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const envelope = await getEncryptionService().encryptField(businessId, value);
  return getEncryptionService().serialize(envelope);
}

export class BrandDnaRepository {
  constructor(private readonly db: Queryable) {}

  private async toProfile(row: Record<string, unknown>): Promise<BrandDnaProfileRecord> {
    const businessId = String(row.business_id);
    const decrypted = await Promise.all(
      BRAND_DNA_FIELDS.map(async (field) => {
        const raw = row[COLUMN_OF[field]];
        return [field, await decryptField(businessId, raw === null || raw === undefined ? null : String(raw))] as const;
      }),
    );
    return {
      businessId,
      status: row.status as BrandDnaStatus,
      synthesisedAt: row.synthesised_at ? new Date(row.synthesised_at as string).toISOString() : null,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      ...(Object.fromEntries(decrypted) as { [K in BrandDnaField]: string | null }),
    };
  }

  async findProfile(businessId: string): Promise<BrandDnaProfileRecord | null> {
    const { rows } = await this.db.query('SELECT * FROM brand_dna_profiles WHERE business_id = $1', [businessId]);
    if (rows.length === 0) return null;
    return this.toProfile(rows[0] as Record<string, unknown>);
  }

  /** Creates the row on first use. Idempotent, so starting the flow twice is harmless. */
  async ensureProfile(businessId: string): Promise<BrandDnaProfileRecord> {
    await this.db.query(
      `INSERT INTO brand_dna_profiles (business_id) VALUES ($1)
       ON CONFLICT (business_id) DO NOTHING`,
      [businessId],
    );
    const profile = await this.findProfile(businessId);
    if (!profile) throw new Error('Failed to create a Brand DNA profile.');
    return profile;
  }

  /**
   * Writes some or all synthesised fields. Only the fields actually passed
   * are touched, so an owner's hand-edit of one field is never clobbered by
   * a later partial write.
   *
   * `markSynthesised` separates "the AI rebuilt this profile" from "a person
   * edited one field", which is what lets the UI honestly say whether the
   * profile reflects the current answers.
   */
  async updateProfile(
    businessId: string,
    fields: Partial<Record<BrandDnaField, string | null>>,
    options: { status?: BrandDnaStatus; markSynthesised?: boolean } = {},
  ): Promise<BrandDnaProfileRecord> {
    const assignments: string[] = ['updated_at = now()'];
    const values: unknown[] = [businessId];

    for (const [field, value] of Object.entries(fields) as [BrandDnaField, string | null][]) {
      if (!BRAND_DNA_FIELDS.includes(field)) continue;
      values.push(await encryptField(businessId, value));
      assignments.push(`${COLUMN_OF[field]} = $${values.length}`);
    }
    if (options.status) {
      values.push(options.status);
      assignments.push(`status = $${values.length}`);
    }
    if (options.markSynthesised) assignments.push('synthesised_at = now()');

    await this.db.query(
      `UPDATE brand_dna_profiles SET ${assignments.join(', ')} WHERE business_id = $1`,
      values,
    );
    const profile = await this.findProfile(businessId);
    if (!profile) throw new Error('Brand DNA profile not found.');
    return profile;
  }

  private async toAnswer(row: Record<string, unknown>): Promise<BrandDnaAnswerRecord> {
    const businessId = String(row.business_id);
    const [questionText, answerText] = await Promise.all([
      decryptField(businessId, row.question_text === null ? null : String(row.question_text)),
      decryptField(businessId, row.answer_text === null ? null : String(row.answer_text)),
    ]);
    return {
      id: String(row.id),
      businessId,
      questionKey: String(row.question_key),
      questionText,
      answerText,
      skipped: Boolean(row.skipped),
      answeredByUserId: String(row.answered_by_user_id),
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }

  /**
   * Upsert by (business, question): re-answering replaces the previous
   * answer rather than appending a contradictory second row that synthesis
   * would then have to arbitrate between.
   */
  async recordAnswer(input: RecordAnswerInput): Promise<BrandDnaAnswerRecord> {
    const [questionText, answerText] = await Promise.all([
      encryptField(input.businessId, input.questionText),
      encryptField(input.businessId, input.answerText),
    ]);
    const { rows } = await this.db.query(
      `INSERT INTO brand_dna_answers
         (business_id, question_key, question_text, answer_text, skipped, answered_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, question_key) DO UPDATE
         SET question_text = EXCLUDED.question_text,
             answer_text = EXCLUDED.answer_text,
             skipped = EXCLUDED.skipped,
             answered_by_user_id = EXCLUDED.answered_by_user_id,
             created_at = now()
       RETURNING *`,
      [input.businessId, input.questionKey, questionText, answerText, input.skipped, input.answeredByUserId],
    );
    return this.toAnswer(rows[0] as Record<string, unknown>);
  }

  async listAnswers(businessId: string): Promise<BrandDnaAnswerRecord[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM brand_dna_answers WHERE business_id = $1 ORDER BY created_at ASC',
      [businessId],
    );
    return Promise.all((rows as Record<string, unknown>[]).map((row) => this.toAnswer(row)));
  }

  /** Every question already put to this owner - answered or skipped - so the flow never re-asks one. */
  async listAnsweredKeys(businessId: string): Promise<Set<string>> {
    const { rows } = await this.db.query('SELECT question_key FROM brand_dna_answers WHERE business_id = $1', [
      businessId,
    ]);
    return new Set((rows as { question_key: string }[]).map((row) => row.question_key));
  }

  /** Starting over. Deletes answers and clears the synthesised profile, leaving the row itself in place. */
  async reset(businessId: string): Promise<void> {
    await this.db.query('DELETE FROM brand_dna_answers WHERE business_id = $1', [businessId]);
    const cleared = BRAND_DNA_FIELDS.map((field) => `${COLUMN_OF[field]} = NULL`).join(', ');
    await this.db.query(
      `UPDATE brand_dna_profiles
          SET ${cleared}, status = 'in_progress', synthesised_at = NULL, updated_at = now()
        WHERE business_id = $1`,
      [businessId],
    );
  }
}
