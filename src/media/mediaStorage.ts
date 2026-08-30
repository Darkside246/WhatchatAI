/**
 * Selects the real media storage backend per call via
 * MEDIA_STORAGE_BACKEND ('local', the default, or 's3'). Every real call
 * site imports storeMedia/retrieveMedia/buildStorageReference from here,
 * never directly from localEncryptedMediaStorage.ts or
 * s3EncryptedMediaStorage.ts - the two backends share an identical
 * interface, so nothing else in the app ever needs to know which one is
 * actually storing bytes.
 *
 * 'local' stays the default deliberately: it's what every existing dev
 * machine, CI run, and the current Overlord/docker-compose deployment
 * already use, and it needs no cloud credentials to work. Only a real
 * multi-machine cloud deployment (app-server and app-worker on separate
 * Fly machines, unable to share one local volume) needs MEDIA_STORAGE_BACKEND=s3.
 */
import * as local from './localEncryptedMediaStorage.js';
import * as s3 from './s3EncryptedMediaStorage.js';

function backend(): typeof local {
  return process.env.MEDIA_STORAGE_BACKEND === 's3' ? s3 : local;
}

export function buildStorageReference(businessId: string, sha256: string): string {
  return backend().buildStorageReference(businessId, sha256);
}

export function storeMedia(businessId: string, sha256: string, plaintext: Buffer): Promise<string> {
  return backend().storeMedia(businessId, sha256, plaintext);
}

export function retrieveMedia(businessId: string, storageReference: string): Promise<Buffer> {
  return backend().retrieveMedia(businessId, storageReference);
}
