import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The dispatcher is a thin pass-through, so this only proves the routing
 * decision itself (which backend gets called for which MEDIA_STORAGE_BACKEND
 * value) - both real backends already have their own full test coverage
 * (localEncryptedMediaStorage.test.ts, s3EncryptedMediaStorage.test.ts).
 */
const localStoreMedia = vi.fn(async () => 'local-reference');
const s3StoreMedia = vi.fn(async () => 's3-reference');

vi.mock('../src/media/localEncryptedMediaStorage.js', () => ({
  buildStorageReference: () => 'local-built',
  storeMedia: (...args: unknown[]) => localStoreMedia(...args),
  retrieveMedia: vi.fn(),
}));
vi.mock('../src/media/s3EncryptedMediaStorage.js', () => ({
  buildStorageReference: () => 's3-built',
  storeMedia: (...args: unknown[]) => s3StoreMedia(...args),
  retrieveMedia: vi.fn(),
}));

const { storeMedia } = await import('../src/media/mediaStorage.js');

describe('mediaStorage dispatcher', () => {
  const originalBackend = process.env.MEDIA_STORAGE_BACKEND;

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.MEDIA_STORAGE_BACKEND;
    else process.env.MEDIA_STORAGE_BACKEND = originalBackend;
    localStoreMedia.mockClear();
    s3StoreMedia.mockClear();
  });

  it('defaults to the local backend when MEDIA_STORAGE_BACKEND is unset', async () => {
    delete process.env.MEDIA_STORAGE_BACKEND;
    await storeMedia('biz', 'sha', Buffer.from('x'));
    expect(localStoreMedia).toHaveBeenCalledTimes(1);
    expect(s3StoreMedia).not.toHaveBeenCalled();
  });

  it('routes to the s3 backend when MEDIA_STORAGE_BACKEND=s3', async () => {
    process.env.MEDIA_STORAGE_BACKEND = 's3';
    await storeMedia('biz', 'sha', Buffer.from('x'));
    expect(s3StoreMedia).toHaveBeenCalledTimes(1);
    expect(localStoreMedia).not.toHaveBeenCalled();
  });

  it('falls back to local for any unrecognized value - never a silent no-op backend', async () => {
    process.env.MEDIA_STORAGE_BACKEND = 'not-a-real-backend';
    await storeMedia('biz', 'sha', Buffer.from('x'));
    expect(localStoreMedia).toHaveBeenCalledTimes(1);
    expect(s3StoreMedia).not.toHaveBeenCalled();
  });
});
