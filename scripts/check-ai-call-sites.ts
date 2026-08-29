// Guards against a "mystery sixth call site" ever happening again. This is
// the P5 call-site inventory (see the blueprint audit) made mechanically
// enforceable: every file that imports getGeminiClient() directly must be
// listed here, with an explicit reason. New business code that reaches
// Gemini directly - bypassing AiGateway's provider registry, timeouts,
// circuit breakers, and failover - fails CI instead of being discovered
// months later by another archaeology pass through the codebase.
//
// Two kinds of entries:
//   'migrate-to-gateway' - a real caller that P5 should move onto AiGateway.
//     Remove the entry once that file no longer imports getGeminiClient()
//     directly. P5 is done, by this script's own definition, when this
//     category is empty.
//   'permanent-exception' - a deliberate, permanent architectural decision
//     to bypass AiGateway, with the reason stated inline. aiSentinel is
//     the canonical example: a security classifier must fail closed to
//     'unavailable', never silently inherit cross-provider failover onto a
//     model with different safety tuning nobody explicitly chose.
//
// Pure filesystem scan, no DB/Redis dependency - safe to run as an early,
// fast CI step before the real test suite spins up services.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

type AllowlistReason = 'migrate-to-gateway' | 'permanent-exception';

interface AllowlistEntry {
  reason: AllowlistReason;
  note: string;
}

const ALLOWLIST: Record<string, AllowlistEntry> = {
  'src/services/geminiClient.ts': {
    reason: 'permanent-exception',
    note: 'Defines getGeminiClient() itself - not a caller.',
  },
  'src/services/ai/providerAdapters.ts': {
    reason: 'permanent-exception',
    note: "AiGateway's own GeminiProvider - the one sanctioned place the gateway itself reaches the client.",
  },
  'src/security/sentinel/aiSentinel.ts': {
    reason: 'permanent-exception',
    note: 'Security classifier - must fail closed to "unavailable", never silently inherit cross-provider failover onto a model with different safety tuning.',
  },
  'src/services/aiEngineStatusService.ts': {
    reason: 'permanent-exception',
    note: 'Diagnostics only (settings-page connectivity check) - not a business AI path.',
  },
  'src/services/aiReplyService.ts': {
    reason: 'migrate-to-gateway',
    note: 'PATH A - production WhatsApp replies. AiGateway now supports tool-calling (P5.3) and a same-provider reduced-request retry equivalent to this file\'s 400-retry fallback - the migration itself (P5.4) is a deliberate, separately-audited swap of the live path, not yet done.',
  },
};

// replySuggestionService.ts, marketingAiService.ts, and emailService.ts were
// migrated onto AiGateway and removed from this list - they no longer
// import getGeminiClient() directly. aiReplyService is the one remaining
// entry; P5 is complete by this check once it reads empty too.

const IMPORT_PATTERN = /\bgetGeminiClient\s*\(/;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'web') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function main(): void {
  const files = walk(SRC_ROOT);
  const unexpected: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relative = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');
    if (!IMPORT_PATTERN.test(content)) continue;

    seen.add(relative);
    if (!ALLOWLIST[relative]) {
      unexpected.push(relative);
    }
  }

  if (unexpected.length > 0) {
    console.error('❌ New direct getGeminiClient() call site(s) found, not in the allowlist:\n');
    for (const file of unexpected) {
      console.error(`   ${file}`);
    }
    console.error(
      '\nEvery Gemini call should go through AiGateway (src/services/ai/aiGateway.ts) unless there is a ' +
        'deliberate, documented reason not to (see scripts/check-ai-call-sites.ts). If this is a real, ' +
        'considered exception, add it to ALLOWLIST with a reason. If not, route the call through AiGateway instead.',
    );
    process.exit(1);
  }

  const migrating = Object.entries(ALLOWLIST).filter(([file, entry]) => entry.reason === 'migrate-to-gateway' && seen.has(file));
  const stale = Object.entries(ALLOWLIST).filter(([file]) => !seen.has(file));

  console.log('✓ No unexpected direct Gemini call sites.');
  if (migrating.length > 0) {
    console.log(`\n${migrating.length} call site(s) still pending P5 migration to AiGateway:`);
    for (const [file, entry] of migrating) console.log(`   ${file} - ${entry.note}`);
  } else {
    console.log('\nAll "migrate-to-gateway" call sites are clear - P5 consolidation is complete by this check.');
  }
  if (stale.length > 0) {
    console.log(`\nNote: ${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer found in the codebase - safe to remove:`);
    for (const [file] of stale) console.log(`   ${file}`);
  }
}

main();
