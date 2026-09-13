import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navItemsFor } from '../../src/web/src/components/SaasNavRail.js';
import { BUSINESS_TYPES_PATH, PRODUCTS } from '../../src/web/src/lib/productCatalog.js';

/**
 * The bug these guard against was found by the person using the product:
 * the platform nav carried Property Ops and Retail Ops and nothing at all
 * for Food, so an entire vertical - orders, kitchen, menu, QC, the lot -
 * could only be opened by typing its URL. Two verticals were privileged into
 * the nav by hand and the third was forgotten, which is what happens every
 * time a list of verticals is maintained in more than one place.
 *
 * So the rule is now structural rather than remembered: no vertical gets a
 * nav entry of its own, every one of them is reached through the Business
 * Types tiles, and the tiles can only point at routes that exist.
 */

/** Every path WorkspaceShell actually routes. Read from the file so a tile cannot promise a page that was never wired. */
function routedPaths(): Set<string> {
  const shell = readFileSync(new URL('../../src/web/src/pages/WorkspaceShell.tsx', import.meta.url), 'utf8');
  return new Set([...shell.matchAll(/path="([^"]+)"/g)].map((match) => match[1]!));
}

describe('Business Types tiles', () => {
  it('points every tile at a route that exists', () => {
    const routes = routedPaths();

    for (const product of PRODUCTS) {
      expect(routes, `${product.key}'s overview ${product.overview} is not routed`).toContain(product.overview);
      if (product.operations) {
        expect(routes, `${product.key}'s operations ${product.operations} is not routed`).toContain(product.operations);
      }
    }
  });

  it('routes the tiles page itself', () => {
    expect(routedPaths()).toContain(BUSINESS_TYPES_PATH);
  });

  it('gives no vertical a nav entry of its own on the platform nav', () => {
    // The actual regression: Property Ops and Retail Ops were in this list
    // and Food was not. Every vertical now goes through the tiles, so no
    // single one can be privileged into the nav and no other one forgotten.
    const platformPaths = NAV_ITEMS.platform.map((item) => item.to);

    for (const product of PRODUCTS) {
      expect(platformPaths, `${product.key}'s overview is back in the platform nav`).not.toContain(product.overview);
      if (product.operations) {
        expect(platformPaths, `${product.key}'s operations is back in the platform nav`).not.toContain(product.operations);
      }
    }
  });

  it('reaches every vertical from the platform nav through the tiles', () => {
    expect(NAV_ITEMS.platform.map((item) => item.to)).toContain(BUSINESS_TYPES_PATH);
  });

  it('covers every vertical the nav knows about', () => {
    // 'platform' is the workspace itself, not a business type - everything
    // else in the nav must have a tile, or it is unreachable again.
    const navVerticals = Object.keys(NAV_ITEMS).filter((key) => key !== 'platform').sort();
    expect(PRODUCTS.map((product) => product.key).sort()).toEqual(navVerticals);
  });
});

describe('navItemsFor', () => {
  it('hides the tiles from a customer who has no product yet', () => {
    // A productKey is genuinely unset during onboarding, which lands that
    // account on the platform nav. They must not be shown nine products they
    // did not buy.
    const paths = navItemsFor('platform', false).map((item) => item.to);
    expect(paths).not.toContain(BUSINESS_TYPES_PATH);
  });

  it('never shows the tiles inside a customer-locked vertical', () => {
    for (const product of PRODUCTS) {
      const paths = navItemsFor(product.key, false).map((item) => item.to);
      expect(paths, `${product.key} offers the tiles to a customer`).not.toContain(BUSINESS_TYPES_PATH);
    }
  });

  it('gives a developer a way back out of every vertical', () => {
    // Without this the tiles were a one-way door: choosing a business type
    // switched the nav to that vertical's own destinations, none of which
    // led back.
    for (const product of PRODUCTS) {
      const paths = navItemsFor(product.key, true).map((item) => item.to);
      expect(paths, `${product.key} traps a developer`).toContain(BUSINESS_TYPES_PATH);
    }
  });

  it('does not show a developer the tiles twice on the platform nav', () => {
    const paths = navItemsFor('platform', true).map((item) => item.to);
    expect(paths.filter((path) => path === BUSINESS_TYPES_PATH)).toHaveLength(1);
  });
});
