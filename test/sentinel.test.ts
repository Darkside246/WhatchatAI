import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { redisClient } from '../src/redis/client.js';
import { runSentinel } from '../src/security/sentinel/sentinel.js';
import { evaluateHeuristicShield } from '../src/security/sentinel/heuristicShield.js';
import { evaluateAiSentinel } from '../src/security/sentinel/aiSentinel.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('Tiered Security Sentinel (real heuristics, real Redis rate limit, real Postgres audit log)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  describe('Stage 1: heuristic shield', () => {
    it('blocks a known malicious short-link pattern', async () => {
      const verdict = await evaluateHeuristicShield({
        senderJid: `stage1-link-${Date.now()}@s.whatsapp.net`,
        textContent: 'Check this out https://bit.ly/free-prize-now',
        mimetype: null,
        fileName: null,
      });
      expect(verdict.safe).toBe(false);
    });

    it('blocks a spam signature', async () => {
      const verdict = await evaluateHeuristicShield({
        senderJid: `stage1-spam-${Date.now()}@s.whatsapp.net`,
        textContent: "Congratulations, you've won! Claim your prize now.",
        mimetype: null,
        fileName: null,
      });
      expect(verdict.safe).toBe(false);
    });

    it('blocks an executable MIME type payload', async () => {
      const verdict = await evaluateHeuristicShield({
        senderJid: `stage1-exe-${Date.now()}@s.whatsapp.net`,
        textContent: null,
        mimetype: 'application/x-msdownload',
        fileName: 'invoice.exe',
      });
      expect(verdict.safe).toBe(false);
    });

    it('blocks oversized text payloads', async () => {
      const verdict = await evaluateHeuristicShield({
        senderJid: `stage1-size-${Date.now()}@s.whatsapp.net`,
        textContent: 'a'.repeat(10_001),
        mimetype: null,
        fileName: null,
      });
      expect(verdict.safe).toBe(false);
    });

    it('allows ordinary text', async () => {
      const verdict = await evaluateHeuristicShield({
        senderJid: `stage1-ok-${Date.now()}@s.whatsapp.net`,
        textContent: 'Hi, what are your opening hours today?',
        mimetype: null,
        fileName: null,
      });
      expect(verdict.safe).toBe(true);
    });

    it('enforces a real Redis token-bucket rate limit of 10 messages / 10s per sender', async () => {
      const senderJid = `stage1-ratelimit-${Date.now()}@s.whatsapp.net`;

      for (let i = 0; i < 10; i += 1) {
        const verdict = await evaluateHeuristicShield({
          senderJid,
          textContent: `message number ${i}`,
          mimetype: null,
          fileName: null,
        });
        expect(verdict.safe).toBe(true);
      }

      const eleventh = await evaluateHeuristicShield({
        senderJid,
        textContent: 'one too many',
        mimetype: null,
        fileName: null,
      });
      expect(eleventh.safe).toBe(false);
      expect(eleventh.reason).toContain('Rate limit exceeded');

      const key = `sentinel:ratelimit:${senderJid}`;
      const ttl = await redisClient.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });
  });

  describe('Stage 2: AI sentinel (real GEMINI_API_KEY state in this environment)', () => {
    it('never fabricates a safe verdict when the AI stage cannot run', async () => {
      const verdict = await evaluateAiSentinel('some real message text');
      // This environment has no GEMINI_API_KEY configured - assert the honest
      // "unavailable" outcome rather than assuming a live API call succeeds.
      if (!process.env.GEMINI_API_KEY) {
        expect(verdict.status).toBe('unavailable');
      } else {
        expect(['safe', 'unsafe', 'unavailable']).toContain(verdict.status);
      }
    });
  });

  describe('orchestration: runSentinel + real security_audit_logs writes', () => {
    it('blocks at Stage 1 and writes a sentinel_heuristic_block audit row without leaking message text', async () => {
      const verdict = await runSentinel({
        businessId,
        whatsappAccountId: accountId,
        senderJid: `orch-block-${Date.now()}@s.whatsapp.net`,
        textContent: 'Wire transfer required immediately, click https://bit.ly/urgent',
        mimetype: null,
        fileName: null,
      });

      expect(verdict.allowed).toBe(false);
      expect(verdict.eventType).toBe('sentinel_heuristic_block');

      const auditLog = new SecurityAuditLogRepository(pool);
      const recent = await auditLog.listRecent(businessId, 5);
      expect(recent[0]?.eventType).toBe('sentinel_heuristic_block');
      expect(recent[0]?.severity).toBe('warning');
      expect(JSON.stringify(recent[0]?.rawMetadata)).not.toContain('Wire transfer');
    });

    it('passes clean text through Stage 1 and honestly logs Stage 2 unavailability when unconfigured', async () => {
      const verdict = await runSentinel({
        businessId,
        whatsappAccountId: accountId,
        senderJid: `orch-pass-${Date.now()}@s.whatsapp.net`,
        textContent: 'Hello, I would like to book an appointment.',
        mimetype: null,
        fileName: null,
      });

      const auditLog = new SecurityAuditLogRepository(pool);
      const recent = await auditLog.listRecent(businessId, 5);

      if (!process.env.GEMINI_API_KEY) {
        expect(verdict.allowed).toBe(true);
        expect(verdict.eventType).toBe('sentinel_ai_unavailable');
        expect(recent[0]?.eventType).toBe('sentinel_ai_unavailable');
      } else {
        expect(['sentinel_pass', 'sentinel_ai_block', 'sentinel_ai_unavailable']).toContain(verdict.eventType);
      }
    });

    it('allows media with no text content through on Stage 1 clearance alone', async () => {
      const verdict = await runSentinel({
        businessId,
        whatsappAccountId: accountId,
        senderJid: `orch-media-${Date.now()}@s.whatsapp.net`,
        textContent: null,
        mimetype: 'image/jpeg',
        fileName: 'photo.jpg',
      });

      expect(verdict.allowed).toBe(true);
      expect(verdict.eventType).toBe('sentinel_pass');
    });
  });
});
