import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import { transcodeToVoiceNote } from '../src/media/audioTranscodeService.js';

const execFileAsync = promisify(execFile);
const ffmpeg = ffmpegPath as unknown as string;

/**
 * Real bytes throughout. The fixtures are genuinely encoded audio produced
 * by ffmpeg, not stub buffers - a test that transcodes a fake buffer would
 * prove nothing about whether a real browser recording converts.
 */
describe('voice note transcoding (real encoded audio, real ffmpeg)', () => {
  let workDir: string;
  let webmOpus: Buffer;
  let mp4Aac: Buffer;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'voice-test-'));

    // What Chrome and Android MediaRecorder actually produce.
    const webmPath = path.join(workDir, 'chrome.webm');
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'libopus', '-f', 'webm', webmPath, '-y',
    ]);
    webmOpus = await readFile(webmPath);

    // What Safari and iOS produce instead.
    const mp4Path = path.join(workDir, 'safari.mp4');
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'aac', '-f', 'mp4', mp4Path, '-y',
    ]);
    mp4Aac = await readFile(mp4Path);
  }, 60_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** Ogg files start with the "OggS" capture pattern - a real format check, not a mime-type claim. */
  function isOgg(buffer: Buffer): boolean {
    return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  }

  it('converts a Chrome WebM/Opus recording into a real Ogg/Opus voice note', async () => {
    const result = await transcodeToVoiceNote(webmOpus);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(isOgg(result.buffer)).toBe(true);
    expect(result.mimeType).toBe('audio/ogg; codecs=opus');
    // Duration is probed back out of the encoded file, so it reflects the
    // real audio rather than anything the caller claimed.
    expect(result.durationSeconds).toBe(3);
  }, 60_000);

  it('converts a Safari MP4/AAC recording too - the format WhatsApp would refuse to play as a voice note', async () => {
    const result = await transcodeToVoiceNote(mp4Aac);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(isOgg(result.buffer)).toBe(true);
    expect(result.durationSeconds).toBe(2);
  }, 60_000);

  it('fails honestly on bytes that are not audio, instead of emitting a silent or corrupt note', async () => {
    const notAudio = Buffer.from('this is plainly not an audio file', 'utf8');

    const result = await transcodeToVoiceNote(notAudio);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBeTruthy();
  }, 60_000);

  it('rejects an empty recording rather than producing a zero-length voice note', async () => {
    const result = await transcodeToVoiceNote(Buffer.alloc(0));
    expect(result.status).toBe('failed');
  });
});
