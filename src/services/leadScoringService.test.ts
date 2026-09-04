import { describe, expect, it } from 'vitest';
import { computeLeadScore, AUTO_QUALIFY_THRESHOLD } from './leadScoringService.js';

describe('computeLeadScore (pure - no I/O)', () => {
  const recentActivity = new Date().toISOString();

  it('scores an URGENT, near-terminal-funnel-stage contact with real engagement near the top of the range', () => {
    const score = computeLeadScore({ customerReadiness: 'URGENT', funnelStage: 'BOOKED', messageCount: 20, lastActivityAt: recentActivity });
    expect(score).toBeGreaterThanOrEqual(AUTO_QUALIFY_THRESHOLD);
    expect(score).toBeGreaterThan(80);
  });

  it('scores a NOT_READY, brand-new-stage contact with no engagement at the bottom of the range', () => {
    const score = computeLeadScore({ customerReadiness: 'NOT_READY', funnelStage: 'NEW', messageCount: 0, lastActivityAt: recentActivity });
    expect(score).toBeLessThan(10);
  });

  it('falls back to engagement-only when no conversation_state has ever been written', () => {
    const score = computeLeadScore({ customerReadiness: null, funnelStage: null, messageCount: 10, lastActivityAt: recentActivity });
    expect(score).toBe(50); // 10/20 messages = 50%
  });

  it('applies the cold-lead penalty when the contact has gone quiet for over 30 days', () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const warm = computeLeadScore({ customerReadiness: 'INTERESTED', funnelStage: 'QUALIFIED', messageCount: 5, lastActivityAt: recentActivity });
    const cold = computeLeadScore({ customerReadiness: 'INTERESTED', funnelStage: 'QUALIFIED', messageCount: 5, lastActivityAt: old });
    expect(cold).toBeLessThan(warm);
  });

  it('treats a never-active contact (no lastActivityAt at all) as cold, never as neutral', () => {
    const withActivity = computeLeadScore({ customerReadiness: 'INTERESTED', funnelStage: 'QUALIFIED', messageCount: 5, lastActivityAt: recentActivity });
    const noActivity = computeLeadScore({ customerReadiness: 'INTERESTED', funnelStage: 'QUALIFIED', messageCount: 5, lastActivityAt: null });
    expect(noActivity).toBeLessThan(withActivity);
  });

  it('never exceeds 100 or goes below 0, regardless of input combination', () => {
    const max = computeLeadScore({ customerReadiness: 'URGENT', funnelStage: 'CUSTOMER', messageCount: 999, lastActivityAt: recentActivity });
    const min = computeLeadScore({ customerReadiness: 'NOT_READY', funnelStage: 'NEW', messageCount: 0, lastActivityAt: null });
    expect(max).toBeLessThanOrEqual(100);
    expect(min).toBeGreaterThanOrEqual(0);
  });

  it('weighs readiness and funnel stage together, not either one alone, when both are known', () => {
    const readinessOnly = computeLeadScore({ customerReadiness: 'URGENT', funnelStage: null, messageCount: 0, lastActivityAt: recentActivity });
    const both = computeLeadScore({ customerReadiness: 'URGENT', funnelStage: 'NEW', messageCount: 0, lastActivityAt: recentActivity });
    // A URGENT readiness paired with a brand-new funnel stage should score lower than readiness alone, since the funnel signal pulls it down.
    expect(both).toBeLessThan(readinessOnly);
  });
});
