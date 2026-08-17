import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAiEngineStatus } from '../src/services/aiEngineStatusService.js';

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/index.ts'),
  'utf8',
);

/**
 * Express applies `app.use(prefix, requireAuth)` only to routes declared
 * AFTER it. A route added above that line is served with no authentication
 * at all, while still looking guarded at a glance because it carries
 * requireWorkspaceContext - which only compares businesses when a session
 * already exists.
 *
 * This caught a real bug: /api/workspace/ai-engines was first added next to
 * the public health routes, ~350 lines above the requireAuth mount.
 */
describe('route registration order (auth mounts guard everything after them)', () => {
  for (const prefix of ['/api/workspace', '/api/whatsapp']) {
    it(`declares every ${prefix} route after its requireAuth mount`, () => {
      const mountIndex = serverSource.indexOf(`app.use('${prefix}', requireAuth);`);
      expect(mountIndex, `no requireAuth mount found for ${prefix}`).toBeGreaterThan(-1);

      const routePattern = new RegExp(`app\\.(get|post|patch|put|delete)\\(\\s*'(${prefix}[^']*)'`, 'g');
      const early: string[] = [];
      for (const match of serverSource.matchAll(routePattern)) {
        // Routes carrying requireAuth explicitly are self-guarded and may
        // legitimately appear before the blanket mount.
        const declaration = serverSource.slice(match.index ?? 0, (match.index ?? 0) + 400);
        if (declaration.includes('requireAuth')) continue;
        if ((match.index ?? 0) < mountIndex) early.push(`${match[1]?.toUpperCase()} ${match[2]}`);
      }

      expect(early, `these ${prefix} routes are registered before requireAuth and are therefore unauthenticated`).toEqual([]);
    });
  }
});

describe('aiEngineStatusService (honest engine reporting, never a fabricated green)', () => {
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalGoose = process.env.GOOSE_SERVICE_URL;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOSE_SERVICE_URL;
  });

  afterEach(() => {
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
    if (originalGoose === undefined) delete process.env.GOOSE_SERVICE_URL;
    else process.env.GOOSE_SERVICE_URL = originalGoose;
  });

  it('reports both engines unconfigured and canGenerate=false when nothing is set up', async () => {
    const status = await getAiEngineStatus();

    const gemini = status.engines.find((engine) => engine.id === 'gemini');
    const goose = status.engines.find((engine) => engine.id === 'goose');

    expect(gemini?.state).toBe('not_configured');
    expect(goose?.state).toBe('not_configured');
    // The whole point: an operator must be able to see that no AI reply can
    // be produced, rather than discovering it from a customer.
    expect(status.canGenerate).toBe(false);
  });

  it('reports Gemini as configured - never as "available", which we have not proven', async () => {
    process.env.GEMINI_API_KEY = 'test-key-not-used-for-any-real-call';

    const status = await getAiEngineStatus();
    const gemini = status.engines.find((engine) => engine.id === 'gemini');

    expect(gemini?.state).toBe('configured');
    expect(gemini?.checkedBy).toBe('configuration');
    expect(status.canGenerate).toBe(true);
  });

  it('marks an unreachable Goose service unavailable with a real reason, not silently healthy', async () => {
    // Port 1 is reserved and never listening, so this is a genuine failed probe.
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:1';

    const status = await getAiEngineStatus();
    const goose = status.engines.find((engine) => engine.id === 'goose');

    expect(goose?.state).toBe('unavailable');
    expect(goose?.checkedBy).toBe('live_probe');
    expect(goose?.reason).toBeTruthy();
    expect(status.canGenerate).toBe(false);
  });
});
