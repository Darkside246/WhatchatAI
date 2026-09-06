/**
 * How long WhatsApp shows the recipient a real "typing…" indicator before
 * an AI-generated reply actually sends, and how long to actually wait
 * before dispatching it - never instant, scaled by the reply's own
 * length so a one-word reply and a long, multi-sentence one don't feel
 * identical.
 *
 * Deliberately NOT a literal simulation of real human typing speed.
 * Average phone-typing speed (commonly cited around 40 WPM, roughly 200
 * characters/minute) would make a long reply sit in "typing…" for
 * 20-30+ real seconds - worse for the person waiting than an obviously
 * scripted delay would be. Tuned instead for "clearly not instant, never
 * uncomfortably slow": a stated, revisitable assumption, same honesty
 * convention this app already uses for its pricing/threshold constants
 * (see the AI Token Top-Up plan's own cost-per-token comment) - correct
 * this from real observed customer reactions, not from typing-speed
 * research, if it ever needs tuning.
 */
const MIN_TYPING_DELAY_MS = 800;
const MAX_TYPING_DELAY_MS = 8_000;
const TYPING_MS_PER_CHARACTER = 35;

export function computeTypingDelayMs(replyText: string): number {
  const raw = replyText.length * TYPING_MS_PER_CHARACTER;
  return Math.min(MAX_TYPING_DELAY_MS, Math.max(MIN_TYPING_DELAY_MS, raw));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
