import { redisClient } from '../../redis/client.js';
import { normalizeMimeType } from '../../domain/whatsapp/mimeType.js';

export interface HeuristicShieldVerdict {
  safe: boolean;
  reason: string | null;
}

export interface HeuristicShieldInput {
  senderJid: string;
  textContent: string | null;
  mimetype: string | null;
  fileName: string | null;
}

const MAX_TEXT_LENGTH = 10_000;

// Known executable / installer MIME types and extensions - never treated as an inert document.
const EXECUTABLE_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-sh',
  'application/x-bat',
  'application/x-apple-diskimage',
  'application/vnd.android.package-archive',
  'application/java-archive',
]);

const EXECUTABLE_EXTENSIONS = /\.(exe|msi|bat|cmd|sh|apk|jar|com|scr|vbs|ps1|dll|app|dmg)$/i;

// Spam / phishing signature patterns. Intentionally simple and fast (Stage 1 must stay under ~5ms) -
// ambiguous cases are left for the Stage 2 AI sentinel, not adjudicated here.
const MALICIOUS_LINK_PATTERNS: RegExp[] = [
  /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly)\/\S+/i,
  /https?:\/\/\S*\.(zip|mov|xyz|top|work|click|country)\/\S*/i,
  /https?:\/\/[^\s/]+@[^\s]+/i, // credential-embedded / lookalike URLs
];

const SPAM_SIGNATURE_PATTERNS: RegExp[] = [
  /\b(free\s+money|claim\s+your\s+prize|you('|’)ve\s+won|verify\s+your\s+account\s+now|urgent[!:]?\s+account\s+suspended)\b/i,
  /\b(wire\s+transfer|crypto\s+giveaway|double\s+your\s+(bitcoin|btc|crypto))\b/i,
];

function checkExecutablePayload(input: HeuristicShieldInput): string | null {
  // normalizeMimeType strips any `;param=value` suffix (and lowercases) -
  // without it, a payload declaring e.g. "application/x-msdownload;
  // charset=utf-8" would silently bypass this exact-match check, since
  // real WhatsApp/Baileys mimetypes (and a sender who wants to evade this
  // check) can carry parameters the sender fully controls.
  if (input.mimetype && EXECUTABLE_MIME_TYPES.has(normalizeMimeType(input.mimetype))) {
    return `Blocked executable MIME type: ${input.mimetype}`;
  }
  if (input.fileName && EXECUTABLE_EXTENSIONS.test(input.fileName)) {
    return `Blocked executable file extension: ${input.fileName}`;
  }
  return null;
}

function checkPayloadSize(textContent: string | null): string | null {
  if (textContent && textContent.length > MAX_TEXT_LENGTH) {
    return `Text payload exceeds max length (${textContent.length} > ${MAX_TEXT_LENGTH})`;
  }
  return null;
}

function checkMaliciousLinks(textContent: string | null): string | null {
  if (!textContent) return null;
  for (const pattern of MALICIOUS_LINK_PATTERNS) {
    if (pattern.test(textContent)) return `Matched malicious link pattern: ${pattern.source}`;
  }
  return null;
}

function checkSpamSignatures(textContent: string | null): string | null {
  if (!textContent) return null;
  for (const pattern of SPAM_SIGNATURE_PATTERNS) {
    if (pattern.test(textContent)) return `Matched spam signature pattern: ${pattern.source}`;
  }
  return null;
}

const RATE_LIMIT_MAX_MESSAGES = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10;
const RATE_LIMIT_KEY_PREFIX = 'sentinel:ratelimit:';

/**
 * Real Redis-backed token-bucket-style rate limit: INCR a per-sender counter
 * keyed to a fixed window and set its TTL on first hit. Max 10 messages per
 * 10s per sender. This is a live Redis round trip (not in-memory), so it
 * belongs in Stage 1 but is not sub-millisecond like the regex checks.
 */
async function checkRateLimit(senderJid: string): Promise<string | null> {
  const key = `${RATE_LIMIT_KEY_PREFIX}${senderJid}`;
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, RATE_LIMIT_WINDOW_SECONDS);
  }
  if (count > RATE_LIMIT_MAX_MESSAGES) {
    return `Rate limit exceeded: ${count} messages within ${RATE_LIMIT_WINDOW_SECONDS}s (max ${RATE_LIMIT_MAX_MESSAGES})`;
  }
  return null;
}

/** Stage 1 of the Tiered Security Sentinel: local heuristics + real Redis rate limiting, evaluated before Stage 2 AI. */
export async function evaluateHeuristicShield(input: HeuristicShieldInput): Promise<HeuristicShieldVerdict> {
  const staticFailure =
    checkExecutablePayload(input) ??
    checkPayloadSize(input.textContent) ??
    checkMaliciousLinks(input.textContent) ??
    checkSpamSignatures(input.textContent);

  if (staticFailure) return { safe: false, reason: staticFailure };

  const rateLimitFailure = await checkRateLimit(input.senderJid);
  if (rateLimitFailure) return { safe: false, reason: rateLimitFailure };

  return { safe: true, reason: null };
}
