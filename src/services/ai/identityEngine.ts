/**
 * Sections 14-24 (Identity & Name Discovery Engine) of the AURA master
 * directive - a real, evidence-based name resolution and usage engine.
 * Deliberately does NOT assume a WhatsApp display name is a person's real
 * name (Section 14's own explicit rule). Deliberately deterministic, not
 * an AI call - the same "deterministic where safer" reasoning as
 * conversationIntentClassifier.ts.
 *
 * Covers: within-conversation name resolution and repetition protection,
 * Section 23 (manually-saved contact names - a staff member's own
 * correction/confirmation in the CRM, crm_contacts.manual_display_name,
 * migration 968), Section 20 (cross-conversation preferred-name
 * carry-over - see conversationStateWriter.ts's applyCustomerMemoryUpdate
 * and customerMemoryRepository.ts's preferredName field), and Section 19's
 * important-moment cooldown override (below).
 */

import type { CustomerReadiness } from '../../repositories/conversationStateRepository.js';

/** Section 16's classification set, narrowed to what this engine can actually distinguish from the real sources it has - never a source-blind guess. */
export type NameConfidence =
  | 'STAFF_CONFIRMED_NAME'
  | 'CONFIRMED_PREFERRED_NAME'
  | 'LIKELY_REAL_NAME'
  | 'POSSIBLE_REAL_NAME'
  | 'NICKNAME'
  | 'USERNAME'
  | 'BUSINESS_NAME'
  | 'UNKNOWN';

export interface NameEvidence {
  name: string;
  confidence: NameConfidence;
}

export interface NameSources {
  /** Tier 1 (Section 23): a staff member manually corrected or confirmed this contact's real name in the CRM - the single most trustworthy source, outranking even the customer's own self-reported preferred name (a human caught something the automatic sources got wrong). */
  staffConfirmedName?: string | null | undefined;
  /** Tier 2 (Section 15): the customer explicitly stated this, confirmed via update_conversation_memory. The only other tier that ever reaches this level of confidence. */
  confirmedPreferredName?: string | null | undefined;
  /** Tier 3/4: WhatsApp's own verification, not self-reported by the contact to us directly - more trustworthy than a push name, still not a customer-confirmed preference. */
  verifiedName?: string | null | undefined;
  businessName?: string | null | undefined;
  /** Tier 5: freely-mutable, platform display name - the least trustworthy real-looking source (Section 14's own warning: "WhatsApp display name = real name" must never be assumed). */
  pushName?: string | null | undefined;
  username?: string | null | undefined;
  shortName?: string | null | undefined;
}

/**
 * Section 15 (Name Source Hierarchy) + Section 16 (classification): picks
 * the single best-evidenced name, never blending multiple sources into one
 * fabricated identity. Returns null (never a phone number, never an empty
 * string) when nothing real is known - Section 18's usage algorithm treats
 * "no evidence" as its own decision, not a reason to fall back to a raw
 * phone number as a greeting.
 */
export function resolveNameEvidence(sources: NameSources): NameEvidence | null {
  const trimmed = (value: string | null | undefined): string | null => {
    const t = value?.trim();
    return t ? t : null;
  };

  const staffConfirmedName = trimmed(sources.staffConfirmedName);
  if (staffConfirmedName) return { name: staffConfirmedName, confidence: 'STAFF_CONFIRMED_NAME' };

  const confirmedPreferredName = trimmed(sources.confirmedPreferredName);
  if (confirmedPreferredName) return { name: confirmedPreferredName, confidence: 'CONFIRMED_PREFERRED_NAME' };

  const verifiedName = trimmed(sources.verifiedName);
  if (verifiedName) return { name: verifiedName, confidence: 'LIKELY_REAL_NAME' };

  const businessName = trimmed(sources.businessName);
  if (businessName) return { name: businessName, confidence: 'BUSINESS_NAME' };

  const pushName = trimmed(sources.pushName);
  if (pushName) return { name: pushName, confidence: 'POSSIBLE_REAL_NAME' };

  const username = trimmed(sources.username);
  if (username) return { name: username, confidence: 'USERNAME' };

  const shortName = trimmed(sources.shortName);
  if (shortName) return { name: shortName, confidence: 'NICKNAME' };

  return null;
}

export type NameUsageDecision = 'DO_NOT_USE_NAME' | 'USE_NAME_NATURALLY';

/**
 * Personalisation Budget (directive §27): a real, business-configurable
 * 5-level setting replacing what used to be one hardcoded cooldown
 * constant. Level 3 (Natural) preserves the exact original 15-minute
 * value, so an unconfigured business (the DB default) behaves identically
 * to before this setting existed - this is a genuine behavior change only
 * once a business actually moves the slider. Level 5 (Very frequent) is
 * zero, not a tiny nonzero number - "use it whenever there's evidence" is
 * a real, distinct choice from "almost never wait," not an approximation
 * of it.
 */
export const NAME_USAGE_COOLDOWN_MINUTES: Record<number, number> = {
  1: 60, // Minimal
  2: 30, // Low
  3: 15, // Natural (default) - the original hardcoded cooldown value this replaces
  4: 5,  // Frequent
  5: 0,  // Very frequent
};

export const DEFAULT_NAME_USAGE_LEVEL = 3;

/**
 * Section 19's adaptive exception: the only readiness level that
 * represents a real reassurance/emotional moment worth overriding
 * repetition-avoidance for - a customer already re-classified as URGENT
 * (Section 10's own real signal) is exactly the moment personal address
 * matters more than not repeating the name too soon. Deliberately just
 * this one level, not PRIORITY-adjacent ones - a genuine exception, not a
 * broadening of when the cooldown applies.
 */
const IMPORTANT_MOMENT_READINESS: CustomerReadiness = 'URGENT';

export interface ShouldUseNameInput {
  evidence: NameEvidence | null;
  /** ISO timestamp of the last reply that actually used this name in this conversation, or null if it never has. */
  lastNameUsedAt: string | null;
  /** Section 19: this conversation's own last-assessed readiness (Section 10) - URGENT bypasses the cooldown entirely. Optional and defaults to no override, so every existing caller is unaffected until it opts in. */
  customerReadiness?: CustomerReadiness | null;
  /** Personalisation Budget (directive §27): the business's own configured level (1-5, see NAME_USAGE_COOLDOWN_MINUTES). Optional and defaults to DEFAULT_NAME_USAGE_LEVEL (Natural), so an existing caller that hasn't wired the business's real setting through yet keeps the original behavior. */
  nameUsageLevel?: number;
  /** Master on/off switch (businesses.name_usage_enabled). Optional and defaults to true so an existing caller that hasn't wired the business's real setting through yet keeps the original behavior. When false, the name is withheld unless customerAskedForName is also true for this reply. */
  nameUsageEnabled?: boolean;
  /** Real, deterministic signal (see customerAskedToUseName below) that the customer's own latest message asked to be addressed by name - the one exception to nameUsageEnabled === false, and it bypasses the cooldown too, same as the URGENT override. */
  customerAskedForName?: boolean;
  /** Injectable for tests; defaults to the real current time. */
  now?: Date;
}

/**
 * Deterministic keyword detection of a customer explicitly asking to be
 * called by name - the one carve-out when name usage is otherwise turned
 * off entirely. Deliberately narrow and phrase-based (same "deterministic
 * where safer" reasoning as the rest of this module) rather than an AI
 * call just to answer this one yes/no question. False negatives here just
 * mean the name stays withheld, which is the safe direction for an
 * explicitly-off setting; it never fabricates a customer request.
 */
export function customerAskedToUseName(messageText: string): boolean {
  return /\b(call me|use my name|say my name|address me)\b/i.test(messageText);
}

/**
 * Section 18 (Name Usage Algorithm), narrowed to the real signals this
 * engine has: confidence, recency, and (Section 19) an important-moment
 * override. A raw phone-number fallback (evidence === null) never gets
 * used as a name - greeting someone by their own phone number reads as
 * robotic, not personal. First use in a conversation is always natural;
 * after that, a real time-based cooldown (now business-configurable via
 * the Personalisation Budget, directive §27) rather than using the name
 * on every single turn - except a genuine reassurance moment (URGENT
 * readiness), which bypasses the cooldown outright regardless of level.
 */
export function shouldUseName(input: ShouldUseNameInput): NameUsageDecision {
  if (!input.evidence) return 'DO_NOT_USE_NAME';
  if (input.nameUsageEnabled === false) {
    return input.customerAskedForName ? 'USE_NAME_NATURALLY' : 'DO_NOT_USE_NAME';
  }
  if (input.customerReadiness === IMPORTANT_MOMENT_READINESS) return 'USE_NAME_NATURALLY';
  if (!input.lastNameUsedAt) return 'USE_NAME_NATURALLY';

  const cooldownMinutes = NAME_USAGE_COOLDOWN_MINUTES[input.nameUsageLevel ?? DEFAULT_NAME_USAGE_LEVEL] ?? NAME_USAGE_COOLDOWN_MINUTES[DEFAULT_NAME_USAGE_LEVEL]!;
  const now = input.now ?? new Date();
  const minutesSinceLastUse = (now.getTime() - new Date(input.lastNameUsedAt).getTime()) / 60_000;
  return minutesSinceLastUse >= cooldownMinutes ? 'USE_NAME_NATURALLY' : 'DO_NOT_USE_NAME';
}

/** Real, deterministic detection of whether a just-generated reply actually used the resolved name - word-boundary matched so "Ann" doesn't false-positive inside "Anniversary". Drives Section 19's cooldown from what really went out, never from what the model claims it did. */
export function replyUsesName(replyText: string, evidence: NameEvidence | null): boolean {
  if (!evidence) return false;
  const escaped = evidence.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(replyText);
}
