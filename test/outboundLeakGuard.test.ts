import { describe, expect, it } from 'vitest';
import { runOutboundLeakGuard } from '../src/security/sentinel/outboundLeakGuard.js';

describe('Outbound Leak Guard (real Stage 1 matching; real GEMINI_API_KEY state in this environment for Stage 2)', () => {
  describe('Stage 1: deterministic protected-fact matching', () => {
    it('blocks an exact reproduction of a protected fact', async () => {
      const verdict = await runOutboundLeakGuard(
        'Nah that was probably Alex on your phone!',
        ['Alex', 'Rex'],
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.eventType).toBe('ai_output_leak_blocked');
      expect(verdict.reason).toContain('Alex');
    });

    it('blocks a case- and whitespace-normalized match', async () => {
      const verdict = await runOutboundLeakGuard(
        'yeah it was    ALEX   lol',
        ['Alex'],
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.eventType).toBe('ai_output_leak_blocked');
    });

    it('blocks a fact appearing as a substring inside unrelated text - deliberately favors recall over precision', async () => {
      const verdict = await runOutboundLeakGuard(
        'My favorite school subject is math, at The Lodge School actually',
        ['The Lodge School'],
      );
      expect(verdict.allowed).toBe(false);
    });

    it('ignores a protected fact under 3 characters - too short to be a meaningful signal', async () => {
      const verdict = await runOutboundLeakGuard('ok sure, no problem', ['ok']);
      // Falls through to Stage 2 (skipped here since protectedFacts becomes
      // effectively meaningless) - what matters is Stage 1 alone never blocks on it.
      expect(verdict.eventType).not.toBe('ai_output_leak_blocked');
    });

    it('never blocks ordinary text with no protected facts configured, and skips Stage 2 entirely', async () => {
      const verdict = await runOutboundLeakGuard('Sure, we open at 9am tomorrow.', []);
      expect(verdict.allowed).toBe(true);
      expect(verdict.eventType).toBe('ai_output_leak_pass');
    });

    it('never blocks clean text when protected facts are configured but none appear', async () => {
      const verdict = await runOutboundLeakGuard('Sure, we open at 9am tomorrow.', ['Alex', 'Rex']);
      if (!process.env.GEMINI_API_KEY) {
        expect(verdict.allowed).toBe(true);
        expect(verdict.eventType).toBe('ai_output_leak_check_unavailable');
      } else {
        expect(['ai_output_leak_pass', 'ai_output_leak_check_unavailable']).toContain(verdict.eventType);
      }
    });
  });

  describe('Stage 2: AI semantic check (honest unavailability, never a fabricated verdict)', () => {
    it('never fabricates a pass or a block when the AI stage cannot run - Stage 1 clean text stays allowed, logged as an honest coverage gap', async () => {
      // Forces the key-absent condition regardless of this machine's own .env
      // (test/globalSetup.ts loads dotenv, and a real key may genuinely be
      // configured here) - otherwise this test silently stops asserting the
      // "AI stage cannot run" path it's named for and instead makes a real,
      // flaky live Gemini call that can exceed vitest's 15s testTimeout.
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      try {
        const verdict = await runOutboundLeakGuard('Totally unrelated reply text.', ['Alex']);
        expect(verdict.allowed).toBe(true);
        expect(verdict.eventType).toBe('ai_output_leak_check_unavailable');
        expect(verdict.reason).toContain('GEMINI_API_KEY');
      } finally {
        if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
      }
    });

    it('Stage 1 blocking is independent of Stage 2 availability - a real match blocks even with no Gemini key configured', async () => {
      const verdict = await runOutboundLeakGuard('It was Alex, don\'t tell anyone', ['Alex']);
      expect(verdict.allowed).toBe(false);
      expect(verdict.eventType).toBe('ai_output_leak_blocked');
    });
  });
});
