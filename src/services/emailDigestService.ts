/**
 * Email Redesign Phase D: the AI daily-suggestions card. A real Gemini
 * call, but deliberately bounded on every axis that controls cost/risk:
 * at most a handful of already-synced subjects/snippets (never full
 * bodies, never sent anywhere else), cached once per business per
 * calendar day (EmailAiSuggestionsRepository), and rate-limited the same
 * way the AI Agents page's own test-connection gate already is. Never
 * regenerated silently on a page load - only on an explicit request past
 * the cache's staleness.
 */

import { queryAsTenant } from '../db/pool.js';
import { EmailOAuthRepository } from '../repositories/emailOAuthRepository.js';
import { EmailAiSuggestionsRepository } from '../repositories/emailAiSuggestionsRepository.js';
import { aiGateway } from './ai/aiGateway.js';

const MAX_SUBJECTS_CONSIDERED = 15;

export type EmailDigestResult =
  | { status: 'ok'; suggestions: string[]; generatedOn: string; cached: boolean }
  | { status: 'unavailable'; reason: string };

async function gatherRecentSubjects(businessId: string): Promise<{ from: string; subject: string; snippet: string }[]> {
  const oauthRepository = new EmailOAuthRepository(queryAsTenant(businessId));
  const accounts = await oauthRepository.listByBusiness(businessId);
  const items: { from: string; subject: string; snippet: string }[] = [];
  for (const account of accounts) {
    const unread = await oauthRepository.listMessages(account.id, { unreadOnly: true, limit: MAX_SUBJECTS_CONSIDERED });
    for (const message of unread) {
      items.push({
        from: message.fromName ?? message.fromAddress ?? 'unknown sender',
        subject: message.subject ?? '(no subject)',
        // Snippet only, never bodyText/bodyHtml - a real, deliberate bound on what this feature ever sends to an LLM.
        snippet: (message.snippet ?? '').slice(0, 200),
      });
    }
  }
  return items.slice(0, MAX_SUBJECTS_CONSIDERED);
}

export async function getCachedDigest(businessId: string): Promise<EmailDigestResult> {
  const suggestionsRepository = new EmailAiSuggestionsRepository(queryAsTenant(businessId));
  const cached = await suggestionsRepository.getForToday(businessId);
  if (cached) return { status: 'ok', suggestions: cached.suggestions, generatedOn: cached.generatedOn, cached: true };
  return { status: 'ok', suggestions: [], generatedOn: new Date().toISOString().slice(0, 10), cached: false };
}

/** Regenerates today's digest regardless of whether one already exists - the caller (route) is what enforces the rate limit, not this function. */
export async function regenerateDigest(businessId: string): Promise<EmailDigestResult> {
  const items = await gatherRecentSubjects(businessId);
  if (items.length === 0) {
    const suggestionsRepository = new EmailAiSuggestionsRepository(queryAsTenant(businessId));
    const saved = await suggestionsRepository.upsertForToday(businessId, []);
    return { status: 'ok', suggestions: [], generatedOn: saved.generatedOn, cached: false };
  }

  const summary = items.map((item, i) => `${i + 1}. From ${item.from} — "${item.subject}" — ${item.snippet}`).join('\n');
  const systemInstruction = [
    'You help a small business owner triage their unread email.',
    'You are given only subject lines and short snippets, never full email bodies.',
    'Write up to 3 short, real, actionable suggestions (max ~15 words each) about what to do with these unread emails.',
    'Never invent facts not present in the subjects/snippets. Never mention specific dollar amounts or dates unless they literally appear below.',
    'Respond as a JSON array of strings only, e.g. ["...", "..."]. If nothing is actionable, respond with [].',
  ].join('\n');

  try {
    const response = await aiGateway.generate({
      tenantId: businessId,
      operation: 'email.digest',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: summary },
      ],
      responseFormat: 'json',
      maxOutputTokens: 300,
    });

    let suggestions: string[] = [];
    try {
      const parsed: unknown = JSON.parse(response.text);
      if (Array.isArray(parsed)) suggestions = parsed.filter((s): s is string => typeof s === 'string').slice(0, 3);
    } catch {
      return { status: 'unavailable', reason: 'The model returned an unparseable response.' };
    }

    const suggestionsRepository = new EmailAiSuggestionsRepository(queryAsTenant(businessId));
    const saved = await suggestionsRepository.upsertForToday(businessId, suggestions);
    return { status: 'ok', suggestions: saved.suggestions, generatedOn: saved.generatedOn, cached: false };
  } catch (error) {
    return { status: 'unavailable', reason: `Digest generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
