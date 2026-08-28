import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCampaign, CampaignNotFoundError, InvalidCampaignStatusError } from './campaignService.js';

// campaignService.ts constructs `new CampaignRepository(pool)` at its own
// module top level, and that import is hoisted ahead of everything in THIS
// file by ES module semantics - including a plain `const mockX = vi.fn()`
// declared above the vi.mock() calls textually. vi.hoisted() is what
// actually runs before any import, so it's the only way these mocks exist
// in time for campaignService.ts's own module-level construction to see them.
const { mockFindByIdForBusiness, mockHardDelete, mockRecord } = vi.hoisted(() => ({
  mockFindByIdForBusiness: vi.fn(),
  mockHardDelete: vi.fn(),
  mockRecord: vi.fn(),
}));

vi.mock('../repositories/campaignRepository.js', () => ({
  // A real class constructor, not an arrow function - `new CampaignRepository()`
  // requires something JS itself considers constructible. Vitest 4 stopped
  // papering over the mismatch: `new (() => x)` throws in real JS too.
  CampaignRepository: vi.fn().mockImplementation(function CampaignRepository() {
    return { findByIdForBusiness: mockFindByIdForBusiness, hardDelete: mockHardDelete };
  }),
}));

vi.mock('../repositories/securityAuditLogRepository.js', () => ({
  SecurityAuditLogRepository: vi.fn().mockImplementation(function SecurityAuditLogRepository() {
    return { record: mockRecord };
  }),
}));

vi.mock('../db/pool.js', () => ({ pool: {} }));
vi.mock('./whatsappOutboundMessageService.js', () => ({ whatsappOutboundMessageService: {} }));

const baseCampaign = {
  id: 'camp-1',
  businessId: 'biz-1',
  whatsappAccountId: 'wa-1',
  name: 'Test Campaign',
  status: 'CANCELLED' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRecord.mockResolvedValue(undefined);
  mockHardDelete.mockResolvedValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe('deleteCampaign', () => {
  it('throws CampaignNotFoundError when campaign does not exist', async () => {
    mockFindByIdForBusiness.mockResolvedValue(null);
    await expect(deleteCampaign('biz-1', 'camp-1')).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  it('throws InvalidCampaignStatusError for an active campaign', async () => {
    mockFindByIdForBusiness.mockResolvedValue({ ...baseCampaign, status: 'APPROVED' });
    await expect(deleteCampaign('biz-1', 'camp-1')).rejects.toBeInstanceOf(InvalidCampaignStatusError);
  });

  it('throws InvalidCampaignStatusError for a DRAFT campaign', async () => {
    mockFindByIdForBusiness.mockResolvedValue({ ...baseCampaign, status: 'DRAFT' });
    await expect(deleteCampaign('biz-1', 'camp-1')).rejects.toBeInstanceOf(InvalidCampaignStatusError);
  });

  it('deletes a CANCELLED campaign and records audit', async () => {
    mockFindByIdForBusiness.mockResolvedValue({ ...baseCampaign, status: 'CANCELLED' });
    await deleteCampaign('biz-1', 'camp-1');
    expect(mockHardDelete).toHaveBeenCalledWith('biz-1', 'camp-1');
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'campaign_deleted' }));
  });

  it('deletes a COMPLETED campaign', async () => {
    mockFindByIdForBusiness.mockResolvedValue({ ...baseCampaign, status: 'COMPLETED' });
    await deleteCampaign('biz-1', 'camp-1');
    expect(mockHardDelete).toHaveBeenCalledWith('biz-1', 'camp-1');
  });

  it('deletes a FAILED campaign', async () => {
    mockFindByIdForBusiness.mockResolvedValue({ ...baseCampaign, status: 'FAILED' });
    await deleteCampaign('biz-1', 'camp-1');
    expect(mockHardDelete).toHaveBeenCalledWith('biz-1', 'camp-1');
  });

  it('throws CampaignNotFoundError if hardDelete returns false', async () => {
    mockFindByIdForBusiness.mockResolvedValue({ ...baseCampaign, status: 'CANCELLED' });
    mockHardDelete.mockResolvedValue(false);
    await expect(deleteCampaign('biz-1', 'camp-1')).rejects.toBeInstanceOf(CampaignNotFoundError);
  });
});
