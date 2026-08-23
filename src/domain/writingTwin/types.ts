/**
 * Phase W3: shared Writing Twin vocabulary, mirroring the CHECK
 * constraints in migration 069_writing_twin.sql exactly - a value here
 * that the database would reject is a bug in this file, not a looser
 * contract than the schema.
 */

export type ChannelScope = 'global' | 'email' | 'whatsapp';

/**
 * The three learning-eligible provenance states (W1-B's five-state
 * model). 'ai_generated_unchanged' and 'unknown_or_ambiguous' are
 * deliberately absent from this type - there is no TypeScript value that
 * could represent them here, matching the database's CHECK constraint
 * making them impossible to insert.
 */
export type LearningEligibleProvenance = 'human_authored' | 'ai_generated_then_edited' | 'explicitly_approved';

export type WritingTwinSourceTable = 'email_messages' | 'whatsapp_outbound_messages';

export type PreferredTone = 'concise' | 'balanced' | 'detailed';
export type Formality = 'casual' | 'neutral' | 'formal';
export type GreetingOrSignOffStyle = 'none' | 'minimal' | 'warm';
export type SentenceLengthBucket = 'short' | 'medium' | 'long';
export type PunctuationEmphasis = 'low' | 'moderate' | 'high';
export type EmojiFrequency = 'none' | 'low' | 'moderate' | 'high';
export type Directness = 'direct' | 'balanced' | 'hedged';
export type QuestionPattern = 'rare' | 'occasional' | 'frequent';

/** The schema-bound Tier A signal shape - every field is a bounded enum or a capped array, never free text. */
export interface WritingTwinSignals {
  preferredTone: PreferredTone | null;
  formality: Formality | null;
  greetingStyle: GreetingOrSignOffStyle | null;
  signOffStyle: GreetingOrSignOffStyle | null;
  avgSentenceLengthBucket: SentenceLengthBucket | null;
  punctuationEmphasis: PunctuationEmphasis | null;
  emojiFrequency: EmojiFrequency | null;
  directness: Directness | null;
  questionPattern: QuestionPattern | null;
  /** At most 8 elements, each at most 80 characters - enforced again at the database layer, not only here. */
  commonPhrases: string[];
  /** At most 5 elements, each at most 40 characters - enforced again at the database layer, not only here. */
  commonSignOffs: string[];
}
