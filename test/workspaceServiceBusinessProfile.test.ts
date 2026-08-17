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
});
