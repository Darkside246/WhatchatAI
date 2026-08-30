import { describe, expect, it, afterEach } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveContainedSessionDir,
  purgeSessionDir,
  SessionDirError,
} from '../src/services/whatsappTenantConnection.js';

const REAL_UUID = '4b6c1e2a-8f3d-4a1b-9c2e-7d5f6a0b1c3e';
const REAL_UUID_2 = 'a1b2c3d4-e5f6-4a1b-9c2e-7d5f6a0b1c3e';

function sessionRoot(): string {
  return path.resolve(process.env.WHATSAPP_SESSION_DIR ?? '.data/whatsapp/primary');
}

describe('resolveContainedSessionDir (adversarial path-containment cases)', () => {
  it('resolves a real UUID businessId to a direct child of the session root', async () => {
    const dir = await resolveContainedSessionDir(REAL_UUID);
    expect(dir).toBe(path.resolve(sessionRoot(), REAL_UUID));
  });

  it('rejects an empty string', async () => {
    await expect(resolveContainedSessionDir('')).rejects.toThrow(SessionDirError);
  });

  it('rejects path traversal via ../', async () => {
    await expect(resolveContainedSessionDir(`../../etc/${REAL_UUID}`)).rejects.toThrow(SessionDirError);
  });

  it('rejects a forward-slash-bearing id', async () => {
    await expect(resolveContainedSessionDir(`${REAL_UUID}/evil`)).rejects.toThrow(SessionDirError);
  });

  it('rejects a backslash-bearing id', async () => {
    await expect(resolveContainedSessionDir(`${REAL_UUID}\\evil`)).rejects.toThrow(SessionDirError);
  });

  it('rejects a null byte', async () => {
    await expect(resolveContainedSessionDir(`${REAL_UUID}\0`)).rejects.toThrow(SessionDirError);
  });

  it('rejects an absolute path', async () => {
    await expect(resolveContainedSessionDir(path.resolve('/etc/passwd'))).rejects.toThrow(SessionDirError);
  });

  it('rejects a non-UUID-shaped id even if otherwise filesystem-safe', async () => {
    await expect(resolveContainedSessionDir('not-a-real-uuid')).rejects.toThrow(SessionDirError);
  });
});

describe('purgeSessionDir (adversarial deletion-safety cases)', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent when the target directory does not exist', async () => {
    await expect(purgeSessionDir(REAL_UUID)).resolves.toBeUndefined();
  });

  it('deletes a real, genuinely-owned session directory', async () => {
    const dir = await resolveContainedSessionDir(REAL_UUID);
    cleanupDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'creds.json'), '{}');

    await purgeSessionDir(REAL_UUID);

    await expect(purgeSessionDir(REAL_UUID)).resolves.toBeUndefined(); // already gone - still idempotent
  });

  it('refuses to delete a symlink planted at the target, even one pointing outside the session root', async () => {
    const root = sessionRoot();
    await mkdir(root, { recursive: true });
    const outsideTarget = path.resolve(root, '..', 'symlink-target-outside-root');
    await mkdir(outsideTarget, { recursive: true });
    cleanupDirs.push(outsideTarget);

    const linkPath = path.resolve(root, REAL_UUID_2);
    await symlink(outsideTarget, linkPath, 'junction').catch(async () => {
      // Non-Windows fallback for local/dev runs of this suite.
      await symlink(outsideTarget, linkPath);
    });
    cleanupDirs.push(linkPath);

    await expect(purgeSessionDir(REAL_UUID_2)).rejects.toThrow(SessionDirError);

    // The outside directory must still be intact - the guard must have refused before any rm().
    await expect(mkdir(outsideTarget, { recursive: true })).resolves.toBeUndefined();
  });
});
