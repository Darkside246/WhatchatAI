import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCampaign, CampaignNotFoundError, InvalidCampaignStatusError } from './campaignService.js';

const mockFindByIdForBusiness = vi.fn();
const mockHardDelete = vi.fn();
const mockRecord = vi.fn();

vi.mock('../repositories/campaignRepository.js', () => ({
  CampaignRepository: vi.fn().mockImplementation(() => ({
    findByIdForBusiness: mockFindByIdForBusiness,
    hardDelete: mockHardDelete,
  })),
}));

vi.mock('../repositories/securityAuditLogRepository.js', () => ({
  SecurityAuditLogRepository: vi.fn().mockImplementation(() => ({ record: mockRecord })),
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
