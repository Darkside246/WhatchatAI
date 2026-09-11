/**
 * The seed questions for Brand DNA onboarding.
 *
 * DELIBERATELY SHORT. The brief this was built from listed roughly thirty
 * fields across seven screens, and also said the onboarding must not feel
 * like a thirty-question survey. Those are only compatible if questions are
 * COMBINED and the depth comes from adaptive follow-ups instead - so one
 * question here asks for the business name, what it sells and who buys,
 * because a person can answer all three in one sentence and asking them
 * separately buys nothing but three more screens.
 *
 * Four of the eight are one-tap multi-selects, so the real typing burden is
 * four short free-text answers. Everything else the profile needs is
 * derived, either by the adaptive follow-ups or by synthesis.
 *
 * Every question is skippable. A skipped question is recorded rather than
 * dropped (see the migration), so it is never re-asked and a sparse profile
 * is still built from whatever was given.
 */

export type BrandDnaQuestionKind = 'text' | 'choice';

export interface BrandDnaQuestion {
  /** Stable token, never the prose - see the migration's note on question_key. */
  key: string;
  kind: BrandDnaQuestionKind;
  /** What the owner is actually asked. Adaptive follow-ups supply their own. */
  prompt: string;
  /** Shown under the prompt as a hint. Kept short; a long helper is a sign the question is doing too much. */
  helper?: string;
  options?: string[];
  multi?: boolean;
  /** True for the handful without which no useful profile can be built at all. */
  essential?: boolean;
}

export const SEED_QUESTIONS: BrandDnaQuestion[] = [
  {
    key: 'business_basics',
    kind: 'text',
    prompt: 'Tell me your business name, what you sell, and who normally buys from you.',
    helper: 'One or two sentences is plenty.',
    essential: true,
  },
  {
    key: 'differentiator',
    kind: 'text',
    // The highest-value question in the whole flow: it is the one whose
    // answer cannot be guessed from any other, and the one that turns a
    // generic profile into a specific one.
    prompt: 'What makes your business different from others doing the same thing?',
    helper: 'The real reason someone picks you.',
    essential: true,
  },
  {
    key: 'brand_values',
    kind: 'choice',
    multi: true,
    prompt: 'Which of these matter most to your brand?',
    options: [
      'Quality',
      'Price',
      'Convenience',
      'Trust',
      'Local / community',
      'Speed',
      'Personal service',
      'Innovation',
      'Sustainability',
      'Premium experience',
    ],
  },
  {
    key: 'voice',
    kind: 'choice',
    multi: true,
    prompt: 'How should I sound when I represent you?',
    options: [
      'Friendly',
      'Professional',
      'Casual',
      'Confident',
      'Funny',
      'Warm',
      'Straight to the point',
      'Luxury / polished',
      'Local / conversational',
    ],
  },
  {
    key: 'customer_problem',
    kind: 'text',
    prompt: 'What problem are you solving for your customers?',
    helper: 'And what usually makes someone choose you over someone else?',
  },
  {
    key: 'marketing_goals',
    kind: 'choice',
    multi: true,
    prompt: 'What do you want more of?',
    options: [
      'New customers',
      'Repeat customers',
      'Social media engagement',
      'Sales',
      'Leads',
      'Brand awareness',
      'Website traffic',
      'Customer loyalty',
      'Reviews / referrals',
    ],
  },
  {
    key: 'channels',
    kind: 'choice',
    multi: true,
    prompt: 'Where do you market your business today?',
    options: ['WhatsApp', 'Instagram', 'Facebook', 'TikTok', 'Google', 'Website', 'Email', 'Events / local community'],
  },
  {
    key: 'words_to_avoid',
    kind: 'text',
    prompt: 'Anything I should never say or do when representing you?',
    helper: 'Words, phrases, claims, or a tone that is not you. Skip if nothing comes to mind.',
  },
];

/**
 * How many adaptive follow-ups may be asked on top of the seeds.
 *
 * Bounded on purpose. The follow-ups are where the genuinely valuable
 * material comes from - "what makes your poultry different from what
 * customers normally find in Barbados?" reveals more than any checkbox - but
 * an unbounded chain of them recreates exactly the long survey this flow
 * exists to avoid.
 */
export const MAX_ADAPTIVE_FOLLOW_UPS = 4;

/** Seed keys that must be answered (not skipped) before a profile is worth synthesising. */
export const ESSENTIAL_KEYS = SEED_QUESTIONS.filter((question) => question.essential).map((question) => question.key);

/** Adaptive questions get keys in this namespace, so they are never confused with a seed. */
export const ADAPTIVE_KEY_PREFIX = 'adaptive_';

export function isAdaptiveKey(key: string): boolean {
  return key.startsWith(ADAPTIVE_KEY_PREFIX);
}
