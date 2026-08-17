import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/index.ts'),
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

  it('the AI kill switch (agent status) requires ai.activate, so a read-only role cannot pause or resume the AI', () => {
    const statusRoute = parseWorkspaceMutatingRoutes().find(
      (route) => route.routePath === '/api/workspace/agents/:agentId/status',
    );

    expect(statusRoute).toBeDefined();
    expect(statusRoute?.middleware).toContain("requirePermission('ai.activate')");
  });
});
