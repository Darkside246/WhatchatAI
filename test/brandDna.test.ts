import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BrandDnaRepository, BRAND_DNA_FIELDS } from '../src/repositories/brandDnaRepository.js';
import { screenBrandDnaAnswer } from '../src/services/brandDna/sensitiveAnswerGuard.js';
import { SEED_QUESTIONS, MAX_ADAPTIVE_FOLLOW_UPS, isAdaptiveKey } from '../src/services/brandDna/brandDnaQuestions.js';
import {
  getFlowState,
  submitAnswer,
  synthesiseProfile,
  editProfile,
  getProfile,
  resetProfile,
  isSensitiveAnswerRejectedError,
} from '../src/services/brandDna/brandDnaService.js';
import { aiGateway } from '../src/services/ai/aiGateway.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * A fake provider on the shared AiGateway, so the adaptive follow-up and the
 * synthesis step are exercised through the REAL gateway path rather than a
 * mocked service boundary - the same approach aiReplyServiceRetry uses.
 */
function registerFakeProvider(name: string, reply: () => string) {
  aiGateway.register({
    name,
    model: `${name}-model`,
    priority: 1,
    async capabilities() {
      return { text: true, vision: false, audio: false, video: false, documents: false };
    },
    async generate() {
      return { provider: name, model: `${name}-model`, text: reply() };
    },
  });
  return () => aiGateway.unregister(name);
}

describe('Brand DNA (real Postgres)', () => {
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    userId = await createTestUser(businessId);
  });

  describe('the sensitive-answer guard', () => {
    it('allows ordinary brand answers, including ones containing numbers', () => {
      for (const answer of [
        'We sell fresh local poultry to families in Barbados.',
        'Friendly, warm, local. We have been going since 1998.',
        'Our customers care about freshness and knowing where their food comes from.',
        'Order reference 4000123456789012 was our busiest day.',
      ]) {
        expect(screenBrandDnaAnswer(answer).safe, answer).toBe(true);
      }
    });

    it('refuses credentials, card numbers and government identifiers', () => {
      const cases: [string, string][] = [
        ['my password is hunter2please', 'password'],
        ['the wifi passcode: chicken123', 'password'],
        ['card 4111 1111 1111 1111', 'payment card'],
        ['sk-abcdefghijklmnopqrstuvwxyz123456', 'API secret'],
        ['AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q', 'Google API key'],
        ['our SSN is 123-45-6789', 'government identification'],
        ['cvv: 123', 'card security code'],
        ['-----BEGIN RSA PRIVATE KEY-----', 'private key'],
      ];
      for (const [answer, expectation] of cases) {
        const verdict = screenBrandDnaAnswer(answer);
        expect(verdict.safe, answer).toBe(false);
        expect(verdict.reason, answer).toContain(expectation);
      }
    });

    it('never quotes the matched secret back in the reason it gives', () => {
      const verdict = screenBrandDnaAnswer('my password is hunter2please');
      expect(verdict.safe).toBe(false);
      expect(verdict.reason).not.toContain('hunter2please');
    });

    it('does not mistake a long non-card number for a payment card', () => {
      // Fails Luhn, so it is an ordinary reference number, not a card.
      expect(screenBrandDnaAnswer('invoice 1234567890123456').safe).toBe(true);
    });
  });

  describe('the flow', () => {
    it('starts with the first seed question and never repeats one already answered', async () => {
      const first = await getFlowState(businessId);
      expect(first.question?.key).toBe(SEED_QUESTIONS[0]!.key);

      const after = await submitAnswer({
        businessId,
        userId,
        questionKey: SEED_QUESTIONS[0]!.key,
        questionText: SEED_QUESTIONS[0]!.prompt,
        answerText: 'Bajan Fresh Poultry. We sell fresh local chicken to families and small restaurants.',
        skipped: false,
      });
      expect(after.question?.key).toBe(SEED_QUESTIONS[1]!.key);
      expect(after.answeredCount).toBe(1);
    });

    it('records a skip rather than dropping it, so the question is never asked again', async () => {
      const key = SEED_QUESTIONS[0]!.key;
      const after = await submitAnswer({
        businessId,
        userId,
        questionKey: key,
        questionText: SEED_QUESTIONS[0]!.prompt,
        answerText: null,
        skipped: true,
      });
      expect(after.question?.key).not.toBe(key);

      const rows = await new BrandDnaRepository(pool).listAnswers(businessId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.skipped).toBe(true);
      expect(rows[0]!.answerText).toBeNull();
    });

    it('refuses an answer containing a credential BEFORE it is ever written to the database', async () => {
      await expect(
        submitAnswer({
          businessId,
          userId,
          questionKey: SEED_QUESTIONS[0]!.key,
          questionText: SEED_QUESTIONS[0]!.prompt,
          answerText: 'our admin password is hunter2please',
          skipped: false,
        }),
      ).rejects.toSatisfy(isSensitiveAnswerRejectedError);

      const { rows } = await pool.query('SELECT count(*) AS count FROM brand_dna_answers WHERE business_id = $1', [
        businessId,
      ]);
      expect(Number(rows[0].count)).toBe(0);
    });

    it('re-answering a question replaces the answer instead of leaving two contradictory rows', async () => {
      const key = SEED_QUESTIONS[0]!.key;
      for (const text of ['We sell chicken.', 'We sell fresh local chicken and eggs.']) {
        await submitAnswer({ businessId, userId, questionKey: key, questionText: 'q', answerText: text, skipped: false });
      }
      const rows = await new BrandDnaRepository(pool).listAnswers(businessId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.answerText).toBe('We sell fresh local chicken and eggs.');
    });

    it('is not ready to synthesise until the essential questions have real answers', async () => {
      const skipAll = async () => {
        for (const question of SEED_QUESTIONS) {
          await submitAnswer({
            businessId,
            userId,
            questionKey: question.key,
            questionText: question.prompt,
            answerText: null,
            skipped: true,
          });
        }
      };
      await skipAll();
      const state = await getFlowState(businessId);
      expect(state.readyToSynthesise).toBe(false);
    });
  });

  describe('provenance', () => {
    /**
     * The guarantee the whole design rests on: a customer's words can never
     * become a fact about the business. There is no code path from an
     * inbound message to this table, and the column that would have to carry
     * it is NOT NULL and references a real dashboard user.
     */
    it('requires a real user on every answer - the database refuses a row without one', async () => {
      await expect(
        pool.query(
          `INSERT INTO brand_dna_answers (business_id, question_key, answer_text, skipped, answered_by_user_id)
           VALUES ($1, 'smuggled', 'the customer said we are the cheapest', false, NULL)`,
          [businessId],
        ),
      ).rejects.toThrow();
    });

    it('stores the answering user on every recorded answer', async () => {
      await submitAnswer({
        businessId,
        userId,
        questionKey: SEED_QUESTIONS[0]!.key,
        questionText: 'q',
        answerText: 'We sell fresh local chicken.',
        skipped: false,
      });
      const rows = await new BrandDnaRepository(pool).listAnswers(businessId);
      expect(rows[0]!.answeredByUserId).toBe(userId);
    });
  });

  describe('encryption at rest', () => {
    it('stores answers as envelopes - a raw SELECT reveals neither the question nor the answer', async () => {
      const secretish = 'Our hatchery process is what competitors cannot copy.';
      await submitAnswer({
        businessId,
        userId,
        questionKey: SEED_QUESTIONS[1]!.key,
        questionText: 'What makes you different?',
        answerText: secretish,
        skipped: false,
      });

      const { rows } = await pool.query(
        'SELECT question_text, answer_text FROM brand_dna_answers WHERE business_id = $1',
        [businessId],
      );
      expect(rows[0].answer_text).not.toContain('hatchery');
      expect(rows[0].answer_text).not.toBe(secretish);
      expect(rows[0].question_text).not.toContain('different');

      // And it still round-trips back to the real text through the repository.
      const decrypted = await new BrandDnaRepository(pool).listAnswers(businessId);
      expect(decrypted[0]!.answerText).toBe(secretish);
    });

    it('stores the synthesised profile encrypted too', async () => {
      await new BrandDnaRepository(pool).ensureProfile(businessId);
      await new BrandDnaRepository(pool).updateProfile(businessId, {
        positioning: 'Local, trusted, family-run poultry.',
      });
      const { rows } = await pool.query('SELECT positioning FROM brand_dna_profiles WHERE business_id = $1', [
        businessId,
      ]);
      expect(rows[0].positioning).not.toContain('family-run');
      expect((await getProfile(businessId))?.positioning).toBe('Local, trusted, family-run poultry.');
    });
  });

  describe('adaptive follow-ups', () => {
    async function answerAllSeeds() {
      for (const question of SEED_QUESTIONS) {
        await submitAnswer({
          businessId,
          userId,
          questionKey: question.key,
          questionText: question.prompt,
          answerText: 'We run a small family poultry farm in Barbados selling fresh chicken to local families.',
          skipped: false,
        });
      }
    }

    it('asks a model-generated follow-up once the seeds are done', async () => {
      const unregister = registerFakeProvider(
        'fake-brand-dna',
        () => 'What makes your poultry different from what customers normally find in Barbados?',
      );
      try {
        await answerAllSeeds();
        const state = await getFlowState(businessId);
        expect(state.question).not.toBeNull();
        expect(isAdaptiveKey(state.question!.key)).toBe(true);
        expect(state.question!.prompt).toContain('Barbados');
      } finally {
        unregister();
      }
    });

    it('stops after the bounded number of follow-ups rather than asking forever', async () => {
      const unregister = registerFakeProvider('fake-brand-dna', () => 'What else makes you different?');
      try {
        await answerAllSeeds();
        for (let i = 1; i <= MAX_ADAPTIVE_FOLLOW_UPS; i += 1) {
          const state = await getFlowState(businessId);
          expect(state.question, `follow-up ${i} should exist`).not.toBeNull();
          await submitAnswer({
            businessId,
            userId,
            questionKey: state.question!.key,
            questionText: state.question!.prompt,
            answerText: 'Freshness and personal service.',
            skipped: false,
          });
        }
        expect((await getFlowState(businessId)).question).toBeNull();
      } finally {
        unregister();
      }
    });

    it('finishes onboarding honestly when no AI provider is available at all', async () => {
      // No provider registered: the gateway throws, and the flow must treat
      // depth as a bonus rather than failing the whole onboarding.
      await answerAllSeeds();
      const state = await getFlowState(businessId);
      expect(state.question).toBeNull();
      expect(state.readyToSynthesise).toBe(true);
    });
  });

  describe('synthesis', () => {
    async function seedRealAnswers() {
      const answers: Record<string, string> = {
        business_basics: 'Bajan Fresh Poultry. Fresh local chicken sold to families and small restaurants.',
        differentiator: 'Our birds are raised and processed on the same day customers collect them.',
        customer_problem: 'People cannot find genuinely fresh local chicken at supermarket prices.',
      };
      for (const [key, text] of Object.entries(answers)) {
        await submitAnswer({ businessId, userId, questionKey: key, questionText: key, answerText: text, skipped: false });
      }
    }

    it('builds a structured profile from the answers and marks it complete', async () => {
      const unregister = registerFakeProvider('fake-brand-dna', () =>
        JSON.stringify({
          brandIdentity: 'A family poultry farm selling same-day fresh chicken.',
          positioning: 'Local, fresh, trusted.',
          toneOfVoice: 'Warm, plain-spoken, Bajan.',
          wordsToAvoid: '',
          differentiators: 'Same-day processing.',
        }),
      );
      try {
        await seedRealAnswers();
        const profile = await synthesiseProfile(businessId);
        expect(profile.status).toBe('complete');
        expect(profile.positioning).toBe('Local, fresh, trusted.');
        expect(profile.toneOfVoice).toBe('Warm, plain-spoken, Bajan.');
        expect(profile.synthesisedAt).not.toBeNull();
      } finally {
        unregister();
      }
    });

    it('stores an empty field as NULL rather than an empty string pretending to be content', async () => {
      const unregister = registerFakeProvider('fake-brand-dna', () =>
        JSON.stringify({ positioning: 'Local and fresh.', wordsToAvoid: '   ' }),
      );
      try {
        await seedRealAnswers();
        const profile = await synthesiseProfile(businessId);
        expect(profile.wordsToAvoid).toBeNull();
      } finally {
        unregister();
      }
    });

    it('ignores keys the model invented that are not real profile fields', async () => {
      const unregister = registerFakeProvider('fake-brand-dna', () =>
        JSON.stringify({ positioning: 'Local and fresh.', revenueEstimate: '$400,000', ownerHomeAddress: 'somewhere' }),
      );
      try {
        await seedRealAnswers();
        const profile = await synthesiseProfile(businessId);
        expect(profile.positioning).toBe('Local and fresh.');
        expect(Object.keys(profile)).not.toContain('revenueEstimate');
        expect(Object.keys(profile)).not.toContain('ownerHomeAddress');
      } finally {
        unregister();
      }
    });

    it('still works when a provider wraps the object in a markdown code fence', async () => {
      // AiGateway strips the fence centrally, for every provider and every
      // caller, so synthesis needs no salvage logic of its own.
      const unregister = registerFakeProvider(
        'fake-brand-dna',
        () => '```json\n{"positioning":"Local and fresh."}\n```',
      );
      try {
        await seedRealAnswers();
        expect((await synthesiseProfile(businessId)).positioning).toBe('Local and fresh.');
      } finally {
        unregister();
      }
    });

    it('fails loudly when a provider answers with prose instead of a profile, rather than digging an object out of it', async () => {
      // The gateway rejects a JSON-formatted request that did not produce
      // JSON. Deliberate: a model that replied with commentary has not done
      // the job, and silently salvaging an object from its prose would hide
      // that a profile was built from something the model was not really
      // asked to produce.
      const unregister = registerFakeProvider(
        'fake-brand-dna',
        () => 'Here is the profile: {"positioning":"Local and fresh."} Hope that helps.',
      );
      try {
        await seedRealAnswers();
        await expect(synthesiseProfile(businessId)).rejects.toThrow();
        // And nothing half-built was written.
        expect((await getProfile(businessId))?.status).toBe('in_progress');
      } finally {
        unregister();
      }
    });

    it('refuses to build a profile when there is nothing real to build it from', async () => {
      await expect(synthesiseProfile(businessId)).rejects.toThrow(/no answers/i);
    });
  });

  describe('editing and resetting', () => {
    it('an owner edit changes only the field given and does not claim the profile was re-synthesised', async () => {
      const repository = new BrandDnaRepository(pool);
      await repository.ensureProfile(businessId);
      await repository.updateProfile(
        businessId,
        { positioning: 'Local and fresh.', toneOfVoice: 'Warm.' },
        { markSynthesised: true },
      );
      const before = await getProfile(businessId);

      const after = await editProfile(businessId, { toneOfVoice: 'Warm and direct.' });
      expect(after.toneOfVoice).toBe('Warm and direct.');
      expect(after.positioning).toBe('Local and fresh.');
      expect(after.synthesisedAt).toBe(before!.synthesisedAt);
    });

    it('refuses an edit containing a credential', async () => {
      await new BrandDnaRepository(pool).ensureProfile(businessId);
      await expect(editProfile(businessId, { brandStory: 'our portal password is hunter2please' })).rejects.toSatisfy(
        isSensitiveAnswerRejectedError,
      );
    });

    it('reset clears every profile field and every answer, back to in_progress', async () => {
      await submitAnswer({
        businessId,
        userId,
        questionKey: SEED_QUESTIONS[0]!.key,
        questionText: 'q',
        answerText: 'We sell chicken.',
        skipped: false,
      });
      await new BrandDnaRepository(pool).updateProfile(businessId, { positioning: 'Local.' }, { status: 'complete' });

      await resetProfile(businessId);

      const profile = await getProfile(businessId);
      expect(profile?.status).toBe('in_progress');
      for (const field of BRAND_DNA_FIELDS) expect(profile?.[field], field).toBeNull();
      expect(await new BrandDnaRepository(pool).listAnswers(businessId)).toHaveLength(0);
    });
  });
});
