import { pool } from '../../db/pool.js';
import {
  BrandDnaRepository,
  BRAND_DNA_FIELDS,
  type BrandDnaField,
  type BrandDnaProfileRecord,
  type BrandDnaAnswerRecord,
} from '../../repositories/brandDnaRepository.js';
import { aiGateway } from '../ai/aiGateway.js';
import {
  SEED_QUESTIONS,
  ESSENTIAL_KEYS,
  MAX_ADAPTIVE_FOLLOW_UPS,
  ADAPTIVE_KEY_PREFIX,
  isAdaptiveKey,
  type BrandDnaQuestion,
} from './brandDnaQuestions.js';
import { screenBrandDnaAnswer } from './sensitiveAnswerGuard.js';

const repository = new BrandDnaRepository(pool);

export class SensitiveAnswerRejectedError extends Error {}
export class BrandDnaNotFoundError extends Error {}

/** Answers shorter than this carry no signal worth building a follow-up from. */
const MIN_USEFUL_ANSWER_CHARS = 3;

export interface BrandDnaFlowState {
  /** The next question, or null when there is nothing left worth asking. */
  question: BrandDnaQuestion | null;
  answeredCount: number;
  totalSeedCount: number;
  /**
   * Whether there is enough to build a useful profile. Drives Aura's own
   * "I have enough to build your initial Brand DNA" - which must be a real
   * statement about the answers given, never a fixed message shown at a
   * fixed step.
   */
  readyToSynthesise: boolean;
}

function nextSeedQuestion(answeredKeys: Set<string>): BrandDnaQuestion | null {
  return SEED_QUESTIONS.find((question) => !answeredKeys.has(question.key)) ?? null;
}

/**
 * Real answers only - a skip is recorded but carries no content, and a
 * two-character answer carries none either. Used both to decide whether
 * there is enough to synthesise and to build the adaptive follow-up.
 */
function substantiveAnswers(answers: BrandDnaAnswerRecord[]): BrandDnaAnswerRecord[] {
  return answers.filter(
    (answer) => !answer.skipped && (answer.answerText ?? '').trim().length >= MIN_USEFUL_ANSWER_CHARS,
  );
}

/**
 * Enough to be useful, rather than enough to be complete.
 *
 * The brief is explicit that the first profile must be useful even from brief
 * answers, and that skipping must not be punished. So this asks for the two
 * essential questions and any three substantive answers - not for the whole
 * flow. An owner who answers the first few questions well and skips the rest
 * still gets a real profile.
 */
function readyToSynthesise(answers: BrandDnaAnswerRecord[]): boolean {
  const substantive = substantiveAnswers(answers);
  const answeredEssentials = ESSENTIAL_KEYS.filter((key) =>
    substantive.some((answer) => answer.questionKey === key),
  );
  return answeredEssentials.length === ESSENTIAL_KEYS.length && substantive.length >= 3;
}

/**
 * Asks the model for ONE follow-up, given what the owner has already said.
 *
 * This is the adaptive part, and the reason the flow is worth more than a
 * form: after "I run a small poultry farm in Barbados" the useful next
 * question is about poultry in Barbados, not the next field in a list.
 *
 * Routed through AiGateway rather than a direct provider call, like every
 * other AI call site in this codebase (scripts/check-ai-call-sites.ts
 * enforces that). Returns null on any failure - the flow then falls through
 * to the remaining seed questions, so an AI outage costs the owner depth,
 * never the ability to finish onboarding.
 */
async function generateAdaptiveQuestion(
  businessId: string,
  answers: BrandDnaAnswerRecord[],
  alreadyAsked: string[],
): Promise<string | null> {
  const transcript = substantiveAnswers(answers)
    .map((answer) => `Q: ${answer.questionText ?? answer.questionKey}\nA: ${answer.answerText}`)
    .join('\n\n');
  if (transcript.length === 0) return null;

  try {
    const response = await aiGateway.generate({
      tenantId: businessId,
      operation: 'brand_dna.follow_up',
      temperature: 0.7,
      maxOutputTokens: 120,
      messages: [
        {
          role: 'system',
          content: [
            'You are helping a business owner describe their brand during a short onboarding.',
            'Read what they have already told you and ask ONE short follow-up question that would',
            'reveal something genuinely useful for marketing and customer conversations - their',
            'positioning, their story, what customers actually value, or what a competitor cannot copy.',
            '',
            'Rules:',
            '- Output ONLY the question. No preamble, no quotes, no numbering.',
            '- One sentence, under 20 words, in plain conversational English.',
            '- Be specific to THEIR business, using their own words and context.',
            '- Never ask for passwords, banking or card details, government identification, or API keys.',
            '- Never ask for personal data about their customers.',
            '- Do not repeat anything already asked.',
            alreadyAsked.length > 0 ? `Already asked: ${alreadyAsked.join(' | ')}` : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
        },
        { role: 'user', content: transcript },
      ],
    });

    const question = response.text.trim().split('\n')[0]?.replace(/^["']|["']$/g, '').trim();
    if (!question || question.length < 8 || question.length > 200) return null;
    return question;
  } catch {
    // Depth is a bonus; finishing onboarding is not. Silent by design - the
    // caller falls back to seed questions and the owner sees no error for
    // something that was never promised.
    return null;
  }
}

/** What to ask next, and whether there is enough to build a profile. */
export async function getFlowState(businessId: string): Promise<BrandDnaFlowState> {
  await repository.ensureProfile(businessId);
  const answers = await repository.listAnswers(businessId);
  const answeredKeys = new Set(answers.map((answer) => answer.questionKey));

  const state: BrandDnaFlowState = {
    question: null,
    answeredCount: answers.length,
    totalSeedCount: SEED_QUESTIONS.length,
    readyToSynthesise: readyToSynthesise(answers),
  };

  // Seeds first: they cover ground no follow-up reliably reaches, and they
  // are what the follow-ups are generated FROM.
  const seed = nextSeedQuestion(answeredKeys);
  if (seed) {
    state.question = seed;
    return state;
  }

  const adaptiveAsked = answers.filter((answer) => isAdaptiveKey(answer.questionKey));
  if (adaptiveAsked.length >= MAX_ADAPTIVE_FOLLOW_UPS) return state;

  const prompt = await generateAdaptiveQuestion(
    businessId,
    answers,
    adaptiveAsked.map((answer) => answer.questionText ?? '').filter((text) => text.length > 0),
  );
  if (!prompt) return state;

  state.question = {
    key: `${ADAPTIVE_KEY_PREFIX}${adaptiveAsked.length + 1}`,
    kind: 'text',
    prompt,
  };
  return state;
}

export interface SubmitAnswerInput {
  businessId: string;
  /** The real dashboard user. See the migration's provenance note. */
  userId: string;
  questionKey: string;
  questionText: string | null;
  answerText: string | null;
  skipped: boolean;
}

export async function submitAnswer(input: SubmitAnswerInput): Promise<BrandDnaFlowState> {
  if (!input.skipped && input.answerText) {
    const verdict = screenBrandDnaAnswer(input.answerText);
    if (!verdict.safe) {
      // Rejected BEFORE any write, so the value never reaches the database
      // even in encrypted form.
      throw new SensitiveAnswerRejectedError(
        `That answer contains ${verdict.reason}. Please leave that out - Aura never needs it, and it should not be stored in a business profile.`,
      );
    }
  }

  await repository.ensureProfile(input.businessId);
  await repository.recordAnswer({
    businessId: input.businessId,
    questionKey: input.questionKey,
    questionText: input.questionText,
    answerText: input.skipped ? null : (input.answerText ?? null),
    skipped: input.skipped,
    answeredByUserId: input.userId,
  });

  return getFlowState(input.businessId);
}

/** The profile shape the model is asked to return, and the only keys accepted back. */
const SYNTHESIS_SHAPE: Record<BrandDnaField, string> = {
  brandIdentity: 'What this business is, in one sentence.',
  ownerPersonality: "The owner's own character and working style.",
  positioning: 'Where this business sits in its market.',
  targetCustomer: 'Who actually buys.',
  customerProblems: 'The problems those customers are trying to solve.',
  competitiveAdvantages: 'Real advantages, only ones the owner stated.',
  brandValues: 'The values that matter most, comma separated.',
  toneOfVoice: 'How Aura should sound. Concrete and directive.',
  preferredVocabulary: 'Words and phrases to favour, comma separated.',
  wordsToAvoid: 'Words, claims or behaviour to avoid, comma separated. Empty if none given.',
  brandPersonality: 'The brand as a character, a few words.',
  marketingPriorities: 'What the owner wants more of, in priority order.',
  socialChannels: 'Channels actually in use, comma separated.',
  contentPreferences: 'The kind of content that suits this brand.',
  customerExpectations: 'What customers expect when they make contact.',
  localContext: 'Location and community context, if any was given.',
  differentiators: 'What genuinely sets them apart.',
  brandStory: 'A short, true story of this business in 2-3 sentences.',
  marketingOpportunities: 'Concrete opportunities visible from what they said.',
  contentAngles: 'Specific content angles worth trying, comma separated.',
  growthOpportunities: 'Plausible growth directions, grounded in their answers.',
};

/**
 * Turns raw answers into the structured profile.
 *
 * The brief's own instruction: do not simply save the answers as raw form
 * data. A profile is worth more than a transcript precisely because it
 * CONNECTS things - "local poultry farm" plus "customers care about
 * freshness" plus "friendly, local" becomes a positioning, an emotional
 * hook and a content angle that none of the three answers state outright.
 *
 * The hard rule, stated to the model and enforced by the shape: derive and
 * interpret, never INVENT. If the owner never mentioned sustainability, the
 * profile does not claim it. A brand profile that fabricates a fact is worse
 * than an empty one, because everything downstream - replies, ads, campaigns
 * - would repeat the fabrication to real customers in the owner's name.
 */
export async function synthesiseProfile(businessId: string): Promise<BrandDnaProfileRecord> {
  const answers = await repository.listAnswers(businessId);
  const substantive = substantiveAnswers(answers);
  if (substantive.length === 0) {
    throw new BrandDnaNotFoundError('There are no answers to build a Brand DNA profile from yet.');
  }

  const transcript = substantive
    .map((answer) => `Q: ${answer.questionText ?? answer.questionKey}\nA: ${answer.answerText}`)
    .join('\n\n');

  const fieldSpec = (Object.entries(SYNTHESIS_SHAPE) as [BrandDnaField, string][])
    .map(([field, description]) => `  "${field}": "${description}"`)
    .join(',\n');

  const response = await aiGateway.generate({
    tenantId: businessId,
    operation: 'brand_dna.synthesis',
    responseFormat: 'json',
    temperature: 0.4,
    maxOutputTokens: 2000,
    messages: [
      {
        role: 'system',
        content: [
          'You build a Brand DNA profile for a business from its owner\'s own answers.',
          '',
          'Return ONLY a JSON object with exactly these keys:',
          '{',
          fieldSpec,
          '}',
          '',
          'Rules that matter more than completeness:',
          '- Derive and connect what the owner said. Do NOT invent facts they did not give you.',
          '- If you have nothing real for a field, return an empty string for it. An empty field is',
          '  correct; a plausible-sounding guess is a fabrication that will be repeated to their',
          '  real customers in their name.',
          '- Never state a credential, price, or personal detail.',
          '- Write in plain English, in the second person where natural ("you sell...").',
          '- Keep each field short: one or two sentences, or a comma-separated list.',
        ].join('\n'),
      },
      { role: 'user', content: transcript },
    ],
  });

  let parsed: Record<string, unknown>;
  try {
    // No salvage attempt here on purpose. AiGateway already strips a
    // markdown code fence centrally and validates that a JSON-formatted
    // request really produced JSON, failing the provider otherwise - so by
    // the time text reaches this line it has been parsed once already.
    // Re-deriving an object out of prose would only reintroduce, locally,
    // the sloppiness the gateway deliberately rejects: a model that answered
    // with commentary rather than a profile has not done the job, and
    // quietly digging an object out of its prose would hide that.
    parsed = JSON.parse(response.text) as Record<string, unknown>;
  } catch {
    throw new Error('The Brand DNA profile could not be built from that response. Please try again.');
  }

  const fields: Partial<Record<BrandDnaField, string | null>> = {};
  for (const field of BRAND_DNA_FIELDS) {
    const value = parsed[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // An empty field is a real answer ("nothing was said about this"), so it
    // is stored as NULL rather than an empty string pretending to be content.
    fields[field] = trimmed.length > 0 ? trimmed : null;
  }

  return repository.updateProfile(businessId, fields, { status: 'complete', markSynthesised: true });
}

export async function getProfile(businessId: string): Promise<BrandDnaProfileRecord | null> {
  return repository.findProfile(businessId);
}

export async function listAnswers(businessId: string): Promise<BrandDnaAnswerRecord[]> {
  return repository.listAnswers(businessId);
}

/** A hand edit by the owner. Never marks the profile as freshly synthesised - it was not. */
export async function editProfile(
  businessId: string,
  fields: Partial<Record<BrandDnaField, string | null>>,
): Promise<BrandDnaProfileRecord> {
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string') continue;
    const verdict = screenBrandDnaAnswer(value);
    if (!verdict.safe) {
      throw new SensitiveAnswerRejectedError(
        `That edit contains ${verdict.reason}. Please leave that out of your brand profile.`,
      );
    }
  }
  const existing = await repository.findProfile(businessId);
  if (!existing) throw new BrandDnaNotFoundError('No Brand DNA profile exists for this business yet.');
  return repository.updateProfile(businessId, fields);
}

export async function resetProfile(businessId: string): Promise<void> {
  await repository.ensureProfile(businessId);
  await repository.reset(businessId);
}

export function isSensitiveAnswerRejectedError(error: unknown): error is SensitiveAnswerRejectedError {
  return error instanceof SensitiveAnswerRejectedError;
}

export function isBrandDnaNotFoundError(error: unknown): error is BrandDnaNotFoundError {
  return error instanceof BrandDnaNotFoundError;
}
