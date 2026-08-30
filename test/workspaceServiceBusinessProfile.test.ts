import { beforeEach, describe, expect, it } from 'vitest';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('workspaceService business profile (real businesses row, Settings page backing)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Original Name');
  });

  it('reads the real business name', async () => {
    const business = await workspaceService.getBusinessProfile(businessId);
    expect(business.name).toBe('Original Name');
  });

  it('persists a rename and returns the updated real row', async () => {
    const updated = await workspaceService.updateBusinessName(businessId, 'Renamed Business');
    expect(updated.name).toBe('Renamed Business');

    const reread = await workspaceService.getBusinessProfile(businessId);
    expect(reread.name).toBe('Renamed Business');
  });

  it('throws for a business id that does not exist - never returns a fabricated profile', async () => {
    await expect(workspaceService.getBusinessProfile('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('defaults a new business to UTC, and persists a real IANA timezone change', async () => {
    const initial = await workspaceService.getBusinessProfile(businessId);
    expect(initial.timezone).toBe('UTC');

    const updated = await workspaceService.updateBusinessTimezone(businessId, 'America/New_York');
    expect(updated.timezone).toBe('America/New_York');

    const reread = await workspaceService.getBusinessProfile(businessId);
    expect(reread.timezone).toBe('America/New_York');
  });

  it('rejects a fake timezone name via the real runtime IANA database, not a hardcoded list', async () => {
    await expect(workspaceService.updateBusinessTimezone(businessId, 'Definitely/NotARealPlace')).rejects.toThrow(
      /not a real IANA timezone/,
    );

    const reread = await workspaceService.getBusinessProfile(businessId);
    expect(reread.timezone).toBe('UTC'); // unchanged - a rejected update must not partially apply
  });

  const TINY_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('defaults to no brand color or logo, persists both, and lets either be cleared back to null independently', async () => {
    const initial = await workspaceService.getBusinessProfile(businessId);
    expect(initial.brandColor).toBeNull();
    expect(initial.logoDataUrl).toBeNull();

    const withColor = await workspaceService.updateBusinessBranding(businessId, { brandColor: '#4f46e5' });
    expect(withColor.brandColor).toBe('#4f46e5');
    expect(withColor.logoDataUrl).toBeNull(); // untouched by a brandColor-only patch

    const withLogo = await workspaceService.updateBusinessBranding(businessId, { logoDataUrl: TINY_PNG_DATA_URL });
    expect(withLogo.brandColor).toBe('#4f46e5'); // untouched by a logoDataUrl-only patch
    expect(withLogo.logoDataUrl).toBe(TINY_PNG_DATA_URL);

    const cleared = await workspaceService.updateBusinessBranding(businessId, { brandColor: null, logoDataUrl: null });
    expect(cleared.brandColor).toBeNull();
    expect(cleared.logoDataUrl).toBeNull();
  });

  it('rejects a malformed hex color and leaves the stored value untouched', async () => {
    await expect(workspaceService.updateBusinessBranding(businessId, { brandColor: 'blue' })).rejects.toThrow(
      /hex color/,
    );
    await expect(workspaceService.updateBusinessBranding(businessId, { brandColor: '#fff' })).rejects.toThrow(
      /hex color/,
    );

    const reread = await workspaceService.getBusinessProfile(businessId);
    expect(reread.brandColor).toBeNull();
  });

  it('rejects a non-image-data-URL logo and a logo over the size cap', async () => {
    await expect(
      workspaceService.updateBusinessBranding(businessId, { logoDataUrl: 'not a data url' }),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);

    // A real 600KB-decoded payload disguised as a data URL - over the 512KB cap.
    const oversized = `data:image/png;base64,${'A'.repeat(800_000)}`;
    await expect(workspaceService.updateBusinessBranding(businessId, { logoDataUrl: oversized })).rejects.toThrow(
      /exceeds/,
    );

    const reread = await workspaceService.getBusinessProfile(businessId);
    expect(reread.logoDataUrl).toBeNull();
  });
});
