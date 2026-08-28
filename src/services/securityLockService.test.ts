import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changePIN,
  LockNotConfiguredError,
  LockWrongCurrentPinError,
  InvalidArgon2ParamsError,
  type ChangePinInput,
} from './securityLockService.js';

const VALID_PARAMS = { memoryCostKib: 19_456, timeCost: 2, parallelism: 1, hashLengthBytes: 16 };

const mockFindByBusiness = vi.fn();
const mockUpdateCredential = vi.fn();
const mockRecord = vi.fn();

vi.mock('../repositories/securityLockCredentialRepository.js', () => ({
  // A real class constructor, not an arrow function - securityLockService.ts
  // calls `new SecurityLockCredentialRepository()`, and Vitest 4 now
  // requires the mocked implementation to actually be constructible
  // (matching real JS: `new (() => x)` throws natively too).
  SecurityLockCredentialRepository: vi.fn().mockImplementation(function SecurityLockCredentialRepository() {
    return { findByBusiness: mockFindByBusiness, updateCredential: mockUpdateCredential };
  }),
}));

vi.mock('../repositories/securityAuditLogRepository.js', () => ({
  SecurityAuditLogRepository: vi.fn().mockImplementation(function SecurityAuditLogRepository() {
    return { record: mockRecord };
  }),
}));

vi.mock('../db/pool.js', () => ({ pool: {} }));

const VALID_HASH = Buffer.alloc(32, 0xab).toString('hex');

const storedCredential = {
  pinSalt: 'somesalt',
  pinHash: VALID_HASH,
  argon2Params: VALID_PARAMS,
};

const validChangeInput = (): ChangePinInput => ({
  currentPinHash: VALID_HASH,
  newSalt: 'newsalt',
  newPinHash: Buffer.alloc(32, 0xcd).toString('hex'),
  newArgon2Params: VALID_PARAMS,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRecord.mockResolvedValue(undefined);
  mockUpdateCredential.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('changePIN', () => {
  it('throws LockNotConfiguredError when no credential exists', async () => {
    mockFindByBusiness.mockResolvedValue(null);
    await expect(changePIN('biz-1', validChangeInput())).rejects.toBeInstanceOf(LockNotConfiguredError);
  });

  it('throws InvalidArgon2ParamsError for weak new Argon2 params', async () => {
    mockFindByBusiness.mockResolvedValue(storedCredential);
    const input = { ...validChangeInput(), newArgon2Params: { ...VALID_PARAMS, memoryCostKib: 100 } };
    await expect(changePIN('biz-1', input)).rejects.toBeInstanceOf(InvalidArgon2ParamsError);
  });

  it('throws LockWrongCurrentPinError and records failure audit when current PIN is wrong', async () => {
    mockFindByBusiness.mockResolvedValue(storedCredential);
    const input = { ...validChangeInput(), currentPinHash: Buffer.alloc(32, 0xff).toString('hex') };
    await expect(changePIN('biz-1', input)).rejects.toBeInstanceOf(LockWrongCurrentPinError);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'lock_unlock_failure' }));
    expect(mockUpdateCredential).not.toHaveBeenCalled();
  });

  it('updates credential and records lock_pin_changed audit on success', async () => {
    mockFindByBusiness.mockResolvedValue(storedCredential);
    const input = validChangeInput();
    await changePIN('biz-1', input);
    expect(mockUpdateCredential).toHaveBeenCalledWith('biz-1', input.newSalt, input.newPinHash, input.newArgon2Params);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'lock_pin_changed' }));
  });

  it('fails closed when supplied hash length does not match stored hash', async () => {
    mockFindByBusiness.mockResolvedValue(storedCredential);
    const input = { ...validChangeInput(), currentPinHash: 'ab' };
    await expect(changePIN('biz-1', input)).rejects.toBeInstanceOf(LockWrongCurrentPinError);
  });
});
