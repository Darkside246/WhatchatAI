import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPermission } from '../src/domain/auth/permissions.js';

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/index.ts'),
  'utf8',
);
const productAccountRoutesSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/productAccountRoutes.ts'),
  'utf8',
);
const oversightRoutesSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/oversightRoutes.ts'),
  'utf8',
);

/**
 * Routes that intentionally carry no requirePermission guard because they
 * only ever act on the caller's OWN row, identified from the authenticated
 * session rather than from client input. Every one of these was checked by
 * hand; anything NOT on this list must carry a real permission guard.
 *
 * This is deliberately an explicit allowlist, not a pattern match: a new
 * mutating route added without a guard should fail this test loudly rather
 * than slip through because it happens to resemble one of these.
 */
const SELF_SCOPED_ROUTES = [
  '/api/workspace/capacity/me', // an agent setting their own availability
  '/api/workspace/chats/:chatId/read', // marking a chat read for the caller
  '/api/workspace/notifications/:id/read',
  '/api/workspace/notifications/:id/dismiss',
  '/api/workspace/notifications/read-all',
  // Found incidentally while adding the Learn routes below, unrelated to
  // this change - marking one's own view of a status as seen is the same
  // low-risk, self-scoped bookkeeping as the notification/chat "read"
  // routes above, not a real mutation of business data.
  '/api/workspace/statuses/:id/view',
  // AI Agents Page Consolidation: a real live-connection diagnostic for
  // the caller's own business, gated by its own real 15-minute rate limit
  // (checkAiConnectionTestGate) - it changes no setting, only stamps a
  // timestamp, so any authenticated workspace member (not just OWNER/ADMIN)
  // may run it, same self-scoped reasoning as the other rows here.
  '/api/workspace/ai/test-connection',
  // AURA Learn Agent: each of these acts only on the CALLING user's own
  // Writing Twin row, and is guarded by requireOwnerForLearn (checked by
  // name below, in the dedicated Learn test) rather than requirePermission -
  // there is no permission key for "manage your own writing style profile,"
  // it is inherently self-scoped to whichever real OWNER is authenticated.
  // Same inherently-self-scoped reasoning as the Learn rows below, and the
  // reason there is no permission key for it: a writing sample is an excerpt
  // of the CALLING user's own message, read and deleted only for whoever is
  // authenticated (userId comes from the session, never the request). It is
  // additionally gated by requireAppLock - the app-lock PIN - which is a
  // stronger gate than any permission, since it takes a second credential on
  // top of the session.
  '/api/workspace/writing-samples/:id',
  '/api/workspace/learn/enabled',
  '/api/workspace/learn/share-enabled',
  '/api/workspace/learn/reset',
  '/api/workspace/learn',
  '/api/workspace/learn/agent-access/:agentId',
  // Email Redesign: each of these acts only on the caller's own notes or
  // their own business's own cached digest - no permission key exists
  // for "manage your own scratch notes," it's inherently self-scoped.
  '/api/workspace/email/notes',
  '/api/workspace/email/notes/:id',
  '/api/workspace/email/suggestions/regenerate',
  // Take-a-message board: dismissing an entry only removes it from this
  // business's own board (never touches the underlying WhatsApp
  // conversation) - the same low-risk, self-scoped bookkeeping as the
  // notification "dismiss" route above, gated by requireWorkspaceContext
  // rather than a dedicated permission key.
  '/api/workspace/relayed-messages/:id/dismiss',
];

interface RouteDeclaration {
  method: string;
  routePath: string;
  middleware: string;
}

/**
 * Routes are declared in two real shapes in server/index.ts - all on one
 * line, and split across lines when a shared handler factory is used. Both
 * must be checked: a guard missing from the multi-line form is exactly as
 * exploitable as one missing from the single-line form.
 */
function parseWorkspaceMutatingRoutes(): RouteDeclaration[] {
  const routes: RouteDeclaration[] = [];
  const declarationStart = /^app\.(post|patch|put|delete)\(/gm;
  const starts: { method: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = declarationStart.exec(serverSource)) !== null) {
    starts.push({ method: match[1] as string, index: match.index });
  }

  for (const [position, start] of starts.entries()) {
    const block = serverSource.slice(start.index, starts[position + 1]?.index ?? serverSource.length);

    // The path must be this declaration's OWN first argument. Matching any
    // path inside the block would let a neighbouring route's path leak in
    // and be judged against the wrong middleware chain.
    const pathMatch = /^app\.(?:post|patch|put|delete)\(\s*'(\/api\/workspace[^']*)'/.exec(block);
    if (!pathMatch) continue;

    // Everything before the handler itself is the middleware chain. Anything
    // after it is handler body and must not count as a guard.
    const handlerStart = block.search(/async\s*\(|Handler\(/);
    const middleware = handlerStart === -1 ? block : block.slice(0, handlerStart);

    routes.push({ method: start.method, routePath: pathMatch[1] as string, middleware });
  }
  return routes;
}

describe('server route authorization (every mutating workspace route is really guarded)', () => {
  it('finds a meaningful number of mutating workspace routes to check', () => {
    // Guards the test itself: if the parse silently stopped matching, the
    // assertions below would vacuously pass on an empty list.
    expect(parseWorkspaceMutatingRoutes().length).toBeGreaterThan(20);
  });

  it('every mutating /api/workspace route either requires a permission or is an explicitly reviewed self-scoped route', () => {
    const unguarded = parseWorkspaceMutatingRoutes()
      .filter((route) => !route.middleware.includes('requirePermission('))
      .filter((route) => !SELF_SCOPED_ROUTES.includes(route.routePath))
      .map((route) => `${route.method.toUpperCase()} ${route.routePath}`);

    expect(unguarded).toEqual([]);
  });

  it('the routes that can send WhatsApp messages as the business require whatsapp.send', () => {
    const sendRoutes = parseWorkspaceMutatingRoutes().filter(
      (route) =>
        route.routePath === '/api/workspace/chats/:chatId/messages' ||
        route.routePath === '/api/workspace/messages/:messageId/reactions',
    );

    expect(sendRoutes.length).toBe(2);
    for (const route of sendRoutes) {
      expect(route.middleware).toContain("requirePermission('whatsapp.send')");
    }
  });

  it('every Learn write route requires requireOwnerForLearn, so an ADMIN cannot manage the OWNER-only writing style profile', () => {
    const learnWriteRoutes = parseWorkspaceMutatingRoutes().filter((route) =>
      ['/api/workspace/learn/enabled', '/api/workspace/learn/share-enabled', '/api/workspace/learn/reset', '/api/workspace/learn', '/api/workspace/learn/agent-access/:agentId'].includes(
        route.routePath,
      ),
    );

    expect(learnWriteRoutes.length).toBe(5);
    for (const route of learnWriteRoutes) {
      expect(route.middleware).toContain('requireOwnerForLearn');
    }
  });

  it('the AI kill switch (agent status) requires ai.activate, so a read-only role cannot pause or resume the AI', () => {
    const statusRoute = parseWorkspaceMutatingRoutes().find(
      (route) => route.routePath === '/api/workspace/agents/:agentId/status',
    );

    expect(statusRoute).toBeDefined();
    expect(statusRoute?.middleware).toContain("requirePermission('ai.activate')");
  });
});

/**
 * Migration 1002: a real, explicit allowlist (same shape as
 * SELF_SCOPED_ROUTES above) for the developer-plane's own mutating
 * routes in productAccountRoutes.ts, which parseWorkspaceMutatingRoutes
 * above can't see (different file, different path prefix, requireDeveloperAdmin
 * instead of requirePermission). Defense-in-depth: a future developer-admin
 * route added without this guard should fail this test loudly, matching
 * this whole file's own stated purpose for the /api/workspace routes.
 */
describe('developer-plane route authorization (productAccountRoutes.ts)', () => {
  const ADMIN_ONLY_ROUTES: { method: string; routePath: string }[] = [
    { method: 'post', routePath: "'/developer/developers'" },
    { method: 'patch', routePath: "'/developer/developers/:userId/tier'" },
    { method: 'delete', routePath: "'/developer/developers/:userId'" },
    { method: 'patch', routePath: "'/developer/businesses/:businessId/tier-unrestricted'" },
  ];

  it('every developer-admin-only route is really guarded by requireDeveloperAdmin, not just requireDeveloper', () => {
    for (const { method, routePath } of ADMIN_ONLY_ROUTES) {
      const declarationPattern = new RegExp(`router\\.${method}\\(\\s*${routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*?\\basync`, 's');
      const match = declarationPattern.exec(productAccountRoutesSource);
      expect(match, `${method.toUpperCase()} ${routePath} declaration not found`).not.toBeNull();
      expect(match?.[0], `${method.toUpperCase()} ${routePath} is missing requireDeveloperAdmin`).toContain('requireDeveloperAdmin');
    }
  });

  it('found a meaningful number of admin-only routes to check - guards the test itself against a silently-empty list', () => {
    expect(ADMIN_ONLY_ROUTES.length).toBeGreaterThan(0);
  });
});

/**
 * AURA AI Oversight & Reliability Agent: every route in oversightRoutes.ts
 * must require requireDeveloper (a real human session) - a status-change
 * route reachable by anything less would break the "no AI-agent-reachable
 * write path into finding review" guarantee this whole system is built on.
 * Same allowlist-and-fail-loudly shape as the productAccountRoutes.ts
 * block above, applied to every mutating route in this file specifically.
 */
describe('oversight-agent route authorization (oversightRoutes.ts)', () => {
  const MUTATING_OVERSIGHT_ROUTES: { method: string; routePath: string }[] = [
    { method: 'patch', routePath: "'/developer/oversight/findings/:id'" },
    { method: 'patch', routePath: "'/developer/oversight/thresholds'" },
  ];

  it('every mutating oversight route requires requireDeveloper', () => {
    for (const { method, routePath } of MUTATING_OVERSIGHT_ROUTES) {
      const declarationPattern = new RegExp(`router\\.${method}\\(\\s*${routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*?\\basync`, 's');
      const match = declarationPattern.exec(oversightRoutesSource);
      expect(match, `${method.toUpperCase()} ${routePath} declaration not found`).not.toBeNull();
      expect(match?.[0], `${method.toUpperCase()} ${routePath} is missing requireDeveloper`).toContain('requireDeveloper');
    }
  });

  it('found a meaningful number of mutating oversight routes to check - guards the test itself against a silently-empty list', () => {
    expect(MUTATING_OVERSIGHT_ROUTES.length).toBeGreaterThan(0);
  });
});

/**
 * The same sweep, over every OTHER router file.
 *
 * Found during a security review: the sweep above reads three files -
 * index.ts, productAccountRoutes.ts and oversightRoutes.ts - while the
 * app mounts twenty routers (see platformRoutes.ts). Food operations,
 * invoices, billing, the driver portal, operator mode, property and retail
 * operations were all outside it, which meant roughly a hundred mutating
 * routes carried their guards by convention alone. Every one of them turned
 * out to be guarded; nothing was enforcing that it stayed true, and the
 * next route added to any of those files would have passed CI unguarded
 * and unnoticed.
 *
 * A route counts as guarded when the file applies a guard to the whole
 * router, to the prefix this route sits under, or on the route line itself.
 * Anything else has to be listed below as deliberately public.
 */
describe('every mounted router, not just the three the sweep used to read', () => {
  const ROUTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server');

  /**
   * Not routers: index.ts is covered by the sweep above, platformRoutes only
   * mounts, and the other two define the guards themselves.
   */
  const NOT_A_ROUTER = new Set(['index.ts', 'platformRoutes.ts', 'authMiddleware.ts', 'cookies.ts']);

  /**
   * Routes that are unauthenticated ON PURPOSE, each with the reason it is
   * safe to be. Deliberately an explicit list rather than a pattern: a new
   * public route should have to be argued for here, in writing, rather than
   * slip through for resembling one of these.
   */
  const DELIBERATELY_PUBLIC: Record<string, string> = {
    // The money endpoints. Unauthenticated by necessity - a payment
    // provider cannot hold a session - and therefore the ones that MUST
    // verify a signature instead. That is asserted separately below,
    // because an unauthenticated route that credits an account is the
    // worst thing in this file if its signature check ever goes missing.
    'billingRoutes.ts:POST /providers/bimpay/bridge': 'payment bridge, HMAC-verified',
    'billingRoutes.ts:POST /webhooks/:provider': 'payment webhook, signature-verified',
    'billingRoutes.ts:POST /webhooks/:provider/ai-token-topup': 'payment webhook, signature-verified',
    'billingRoutes.ts:POST /webhooks/:provider/ai-memory-topup': 'payment webhook, signature-verified',
    'billingRoutes.ts:POST /webhooks/:provider/plan-upgrade': 'payment webhook, signature-verified',
    // Exchanging a single-use link token for a driver session. The token IS
    // the credential, so this cannot itself require one.
    'driverPortalRouter.ts:POST /session': 'token exchange - the token is the whole credential',
    // Destroying your own session needs no permission to destroy.
    'driverPortalRouter.ts:POST /signout': 'revokes only the caller own cookie',
    // The landing-page consent flow, which runs before anybody has an account.
    'legalRouter.ts:POST /consent': 'public consent capture, pre-signup',
    // Signing up. Rate-limited by authLimiter at the app level.
    'productAccountRoutes.ts:POST /trials/register': 'public signup, rate-limited',
  };

  const GUARD = /require(Auth|Permission|Developer|DeveloperAdmin|Driver|Owner|AppLock|Platform|WorkspaceContext|ActiveSubscription)/;

  interface Route { file: string; key: string; guarded: boolean }

  const routes: Route[] = [];
  const scannedFiles: string[] = [];

  for (const entry of readdirSync(ROUTER_DIR)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || NOT_A_ROUTER.has(entry)) continue;
    const source = readFileSync(path.join(ROUTER_DIR, entry), 'utf8');
    if (!/router\.(post|put|patch|delete)\(/.test(source)) continue;
    scannedFiles.push(entry);

    // A guard applied to the whole router, or to one path prefix of it.
    const blanket = /router\.use\(\s*require/.test(source);
    const guardedPrefixes = [...source.matchAll(/router\.use\(\s*'([^']+)'\s*,\s*require/g)].map((m) => m[1] as string);

    for (const match of source.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']*)'\s*,([^\n]*)/g)) {
      const [, verb, routePath, rest] = match as unknown as [string, string, string, string];
      const guarded = blanket || guardedPrefixes.some((prefix) => routePath.startsWith(prefix)) || GUARD.test(rest);
      routes.push({ file: entry, key: `${entry}:${verb.toUpperCase()} ${routePath}`, guarded });
    }
  }

  it('is actually reading the routers, not silently scanning nothing', () => {
    // The failure this test would otherwise hide: a refactor that renames
    // the files or the router variable, leaving a sweep that passes because
    // it found no routes at all.
    expect(scannedFiles.length).toBeGreaterThanOrEqual(10);
    expect(routes.length).toBeGreaterThanOrEqual(80);
  });

  it('every mutating route is either guarded or listed as deliberately public', () => {
    const unaccounted = routes.filter((route) => !route.guarded && !(route.key in DELIBERATELY_PUBLIC));
    expect(unaccounted.map((route) => route.key)).toEqual([]);
  });

  it('nothing stays on the public list once it has been guarded', () => {
    // A stale exemption is how a list like this stops meaning anything.
    const stillPublic = new Set(routes.filter((route) => !route.guarded).map((route) => route.key));
    for (const key of Object.keys(DELIBERATELY_PUBLIC)) expect(stillPublic.has(key)).toBe(true);
  });

  it('every unauthenticated payment route verifies a provider signature', () => {
    // The one that would actually cost money: a webhook anybody on the
    // internet can POST "payment succeeded" to. Authentication is not
    // available to these routes, so the signature check is the ONLY thing
    // standing between a stranger and a free plan.
    const billing = readFileSync(path.join(ROUTER_DIR, 'billingRoutes.ts'), 'utf8');
    const paymentRoutes = Object.keys(DELIBERATELY_PUBLIC).filter((key) => key.startsWith('billingRoutes.ts:'));
    expect(paymentRoutes.length).toBeGreaterThanOrEqual(5);

    // Every one of them runs through a handler that calls verifyEvent, and
    // refuses on a 'rejected' outcome rather than carrying on.
    const verifyCalls = billing.match(/provider\.verifyEvent\(/g) ?? [];
    const rejections = billing.match(/result\.outcome === 'rejected'/g) ?? [];
    expect(verifyCalls.length).toBeGreaterThanOrEqual(4);
    expect(rejections.length).toBe(verifyCalls.length);
  });
});

/**
 * Signed in is not the same as allowed.
 *
 * Found in a security review. Two routers - invoices and operator mode -
 * carried requireAuth and nothing else, so every mutating route in them was
 * open to ANY member of the business, a VIEWER included. A VIEWER holds the
 * nine *.view permissions and nothing else; the whole point of the role is
 * that it cannot change anything.
 *
 * What that actually allowed:
 *   - approving, sending, marking paid, voiding and deleting invoices;
 *   - POSTing your own phone number and a PIN of your choosing to operator
 *     mode, which is the WhatsApp-side control channel: takings, invoice
 *     status changes, incident logs and the AI kill switch, from your own
 *     phone, outside the app entirely.
 *
 * These pin both shut. Reads are deliberately untouched - a colleague
 * looking at a document their business issued was never the problem.
 */
describe('the two routers where being signed in used to be the whole check', () => {
  const ROUTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server');
  const invoiceSource = readFileSync(path.join(ROUTER_DIR, 'invoiceRouter.ts'), 'utf8');
  const operatorSource = readFileSync(path.join(ROUTER_DIR, 'operatorModeRouter.ts'), 'utf8');

  const mutating = (source: string) =>
    [...source.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']*)'\s*,([^\n]*)/g)].map((m) => ({
      key: `${(m[1] as string).toUpperCase()} ${m[2] as string}`,
      rest: m[3] as string,
    }));

  it('every route that changes an invoice needs billing.manage, not just a session', () => {
    const routes = mutating(invoiceSource);
    expect(routes.length).toBeGreaterThanOrEqual(10);
    // Named explicitly rather than pattern-matched: these are the ones that
    // move money, and each should have to be removed from this list by hand.
    for (const key of ['POST /:id/approve', 'POST /:id/send', 'POST /:id/pay', 'POST /:id/void', 'DELETE /:id']) {
      expect(routes.find((route) => route.key === key)?.rest, `${key} is unguarded`).toContain('requireInvoiceChange');
    }
    for (const route of routes) expect(route.rest, `${route.key} is unguarded`).toContain('requireInvoiceChange');
  });

  it('invoice changes are bound to a permission a VIEWER does not hold', () => {
    expect(invoiceSource).toContain("requirePermission('billing.manage')");
    expect(hasPermission('VIEWER', 'billing.manage')).toBe(false);
    expect(hasPermission('AGENT', 'billing.manage')).toBe(false);
    expect(hasPermission('OWNER', 'billing.manage')).toBe(true);
  });

  it('configuring operator mode needs settings.manage', () => {
    const routes = mutating(operatorSource);
    expect(routes.length).toBeGreaterThanOrEqual(5);
    for (const route of routes) expect(route.rest, `${route.key} is unguarded`).toContain('requireOperatorModeAdmin');
    expect(operatorSource).toContain("requirePermission('settings.manage')");
  });

  it('nobody below an admin can point the WhatsApp control channel at their own phone', () => {
    // The escalation itself, stated as the thing that must stay false.
    for (const role of ['VIEWER', 'AGENT', 'MARKETING', 'SUPERVISOR', 'MANAGER'] as const) {
      expect(hasPermission(role, 'settings.manage'), `${role} can reconfigure operator mode`).toBe(false);
    }
    expect(hasPermission('OWNER', 'settings.manage')).toBe(true);
    expect(hasPermission('ADMIN', 'settings.manage')).toBe(true);
  });

  it('leaves reading alone, so this is a restriction on changing and nothing else', () => {
    const reads = [...invoiceSource.matchAll(/router\.get\(\s*'([^']*)'\s*,([^\n]*)/g)];
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const read of reads) expect(read[2] as string).not.toContain('requireInvoiceChange');
  });
});
