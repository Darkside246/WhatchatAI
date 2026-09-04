import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, type ProductNav } from '../../src/web/src/components/SaasNavRail.js';

const ALL_VERTICALS: ProductNav[] = [
  'platform', 'property', 'food', 'retail', 'beauty',
  'auto', 'health', 'legal', 'hospitality', 'construction', 'logistics',
];

/**
 * Real bug found live (Section 110-113): /automations (the generic
 * drip-funnel builder - message/wait/condition/tag nodes, no
 * property-specific dependency) was only ever wired into 2 of 11
 * verticals' nav (platform, property) - the exact same "real feature,
 * unreachable nav" mistake Section 45 already found and fixed once for
 * /approvals. Both are now real cross-vertical routes
 * (WorkspaceShell.tsx's route list is not vertical-gated), so every
 * vertical's nav should be able to reach them.
 */
describe('SaasNavRail.NAV_ITEMS (every vertical can reach every cross-vertical feature)', () => {
  it('every vertical has a real /automations nav entry', () => {
    for (const vertical of ALL_VERTICALS) {
      const paths = NAV_ITEMS[vertical].map((item) => item.to);
      expect(paths, `${vertical} is missing /automations`).toContain('/automations');
    }
  });

  it('every vertical has a real /approvals nav entry (Section 45\'s fix stays fixed)', () => {
    for (const vertical of ALL_VERTICALS) {
      const paths = NAV_ITEMS[vertical].map((item) => item.to);
      expect(paths, `${vertical} is missing /approvals`).toContain('/approvals');
    }
  });

  it('covers every declared vertical - a new vertical added to the type must also get a real NAV_ITEMS entry', () => {
    expect(Object.keys(NAV_ITEMS).sort()).toEqual([...ALL_VERTICALS].sort());
  });
});
