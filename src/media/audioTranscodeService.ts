import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

/**
 * Turns whatever a browser recorded into the format a WhatsApp voice note
 * actually is: Ogg/Opus, mono, 48kHz.
 *
 * This exists because browsers and WhatsApp disagree. MediaRecorder gives
 * WebM/Opus on Chrome and Android, MP4/AAC on Safari, and only Firefox
 * offers Ogg/Opus. WhatsApp voice notes are Ogg/Opus. Sending the raw
 * recording with ptt=true uploads fine and then fails to play for many
 * recipients - a feature that looks like it works and silently does not,
 * which is worse than not shipping it.
 *
 * ffmpeg-static pins a real ffmpeg binary rather than depending on one being
 * installed on the host, so this behaves identically in dev, CI and
 * production.
 */
export type TranscodeResult =
  | { status: 'ok'; buffer: Buffer<ArrayBuffer>; mimeType: 'audio/ogg; codecs=opus'; durationSeconds: number | null }
  | { status: 'failed'; reason: string };

/** WhatsApp voice notes are mono and low bitrate; matching that keeps them small and native-looking. */
const OPUS_BITRATE = '32k';
const SAMPLE_RATE = '48000';
const TRANSCODE_TIMEOUT_MS = 30_000;

function resolveFfmpeg(): string | null {
  // Typed as a plain string by ffmpeg-static, but it genuinely resolves to
  // null on unsupported platforms - so this is checked at runtime rather
  // than trusted from the type.
  const resolved = ffmpegPath as unknown as string | null;
  return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
}

/** Reads the real duration back out of the encoded file - never trusts a client-supplied number. */
async function probeDurationSeconds(ffmpeg: string, filePath: string): Promise<number | null> {
  try {
    // ffmpeg prints stream info to stderr and exits non-zero with no output
    // target, so the error path is the normal path here.
    await execFileAsync(ffmpeg, ['-hide_banner', '-i', filePath], { timeout: TRANSCODE_TIMEOUT_MS });
    return null;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
    if (!match) return null;
    const [, hours, minutes, seconds] = match;
    const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    return Number.isFinite(total) ? Math.round(total) : null;
  }
}

export async function transcodeToVoiceNote(input: Buffer): Promise<TranscodeResult> {
  if (input.length === 0) return { status: 'failed', reason: 'The recording was empty.' };

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    return { status: 'failed', reason: 'No ffmpeg binary is available, so the recording cannot be converted.' };
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'whatchat-voice-'));
  const sourcePath = path.join(workDir, 'source');
  const outputPath = path.join(workDir, 'note.ogg');

  try {
    await writeFile(sourcePath, input);

    // -vn drops any video track: a MediaRecorder blob from a device with a
    // camera permission can carry one, and WhatsApp would reject it.
    await execFileAsync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', sourcePath,
        '-vn',
        '-c:a', 'libopus',
        '-b:a', OPUS_BITRATE,
        '-ar', SAMPLE_RATE,
        '-ac', '1',
        '-f', 'ogg',
        outputPath,
        '-y',
      ],
      { timeout: TRANSCODE_TIMEOUT_MS },
    );

    const encoded = await readFile(outputPath);
    if (encoded.length === 0) return { status: 'failed', reason: 'Conversion produced an empty file.' };
    // Copy into a plain ArrayBuffer-backed Buffer so callers get a
    // consistent type regardless of how Node allocated the read.
    const buffer = Buffer.from(encoded) as Buffer<ArrayBuffer>;

    const durationSeconds = await probeDurationSeconds(ffmpeg, outputPath);
    return { status: 'ok', buffer, mimeType: 'audio/ogg; codecs=opus', durationSeconds };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    const message = stderr && stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason: `Could not convert the recording: ${message.slice(0, 300)}` };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
