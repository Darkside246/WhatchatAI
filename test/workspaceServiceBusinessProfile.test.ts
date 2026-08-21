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
});
