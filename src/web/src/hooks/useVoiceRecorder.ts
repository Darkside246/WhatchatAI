import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Real microphone capture via MediaRecorder.
 *
 * Deliberately does NOT try to normalise the container here. Chrome and
 * Android give WebM/Opus, Safari gives MP4/AAC, Firefox gives Ogg/Opus - the
 * server converts whatever arrives into the Ogg/Opus that WhatsApp voice
 * notes actually are. Guessing in the browser would just add a second place
 * to be wrong.
 *
 * Every value this exposes is measured: elapsedSeconds counts real elapsed
 * time while recording, and the blob is the real captured audio.
 */
export type RecorderState = 'idle' | 'requesting' | 'recording' | 'unsupported' | 'denied';

interface UseVoiceRecorder {
  state: RecorderState;
  elapsedSeconds: number;
  error: string | null;
  start: () => Promise<void>;
  /** Resolves with the real recording, or null if nothing usable was captured. */
  stop: () => Promise<{ blob: Blob; mimeType: string } | null>;
  cancel: () => void;
}

/** Ordered by how well each container survives the server-side conversion; the browser picks the first it supports. */
const PREFERRED_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function useVoiceRecorder(): UseVoiceRecorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Releasing the microphone on unmount matters: a live capture the user
  // can no longer see is both a privacy problem and a stuck browser
  // recording indicator.
  useEffect(() => releaseStream, [releaseStream]);

  const start = useCallback(async () => {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('unsupported');
      setError('This browser cannot record audio.');
      return;
    }

    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;

      setElapsedSeconds(0);
      timerRef.current = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
      setState('recording');
    } catch (err) {
      releaseStream();
      // A refused permission is a real, distinct outcome - not a generic failure.
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setState(denied ? 'denied' : 'idle');
      setError(denied ? 'Microphone access was blocked for this site.' : 'Could not start recording.');
    }
  }, [releaseStream]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      releaseStream();
      setState('idle');
      return null;
    }

    const finished = new Promise<{ blob: Blob; mimeType: string } | null>((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        resolve(blob.size > 0 ? { blob, mimeType } : null);
      };
    });

    recorder.stop();
    const result = await finished;
    releaseStream();
    recorderRef.current = null;
    setState('idle');
    return result;
  }, [releaseStream]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      // Drop the audio rather than resolving it - a cancelled recording must
      // not be sendable.
      recorder.onstop = null;
      recorder.stop();
    }
    chunksRef.current = [];
    recorderRef.current = null;
    releaseStream();
    setElapsedSeconds(0);
    setState('idle');
  }, [releaseStream]);

  return { state, elapsedSeconds, error, start, stop, cancel };
}
