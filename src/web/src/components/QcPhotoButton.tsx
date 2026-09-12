import { useRef, useState } from 'react';
import { Camera, Check, Loader2 } from 'lucide-react';
import { api, ApiError, type FoodQcFindingDto } from '../lib/api.js';

/**
 * Photographing an order at the pass.
 *
 * Uses the phone's own camera through a plain file input with `capture`,
 * rather than a getUserMedia viewfinder built into the page: a kitchen
 * tablet is often a phone, the native camera app is faster and steadier
 * than anything we would build, and it works when the page does not have
 * camera permission.
 *
 * The instruction to shoot FROM THE SIDE is the difference between this
 * being useful and being decorative. A photograph taken straight down at
 * a closed burger is a photograph of a bun; taken from the side, the
 * onions, the cheese and the sauce are all in the layers. It buys more of
 * the one signal that is reliable - seeing something that should not be
 * there. It never makes absence provable, and nothing here treats it as
 * though it does.
 */

/** Photos off a modern phone are far larger than this check needs. Resized before they leave the device. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

async function toResizedJpegBase64(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the photo.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // The data: prefix is stripped here rather than on the server, so what
  // crosses the wire is exactly the base64 the API documents.
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1] ?? '';
}

export function QcPhotoButton({
  orderId, taken, onDone,
}: {
  orderId: string;
  taken: boolean;
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findings, setFindings] = useState<FoodQcFindingDto[] | null>(null);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    try {
      const base64 = await toResizedJpegBase64(file);
      if (!base64) throw new Error('That photo could not be prepared.');

      const result = await api.uploadFoodQcPhoto(orderId, base64, 'image/jpeg');
      setFindings(result.check.findings);
      // Said plainly rather than passed over in silence: a photo that was
      // meant to be read and was not is a different thing from one that
      // was read and found nothing.
      if (result.readFailed) setError('Photo saved, but it could not be checked this time.');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that photo.');
    } finally {
      setBusy(false);
      // Cleared so photographing the same order twice in a row actually
      // fires the change event the second time.
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setFindings(null);
          input.current?.click();
        }}
        // The whole instruction, on the thing you press. Nobody reads a
        // help page in a kitchen.
        title="Photograph the order from the SIDE, not from above — the fillings show in the layers"
        aria-label={taken ? 'Photograph this order again' : 'Photograph this order before it goes out'}
        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-meta font-medium disabled:opacity-50 ${
          taken
            ? 'border-border-subtle text-fg-muted hover:text-fg'
            : 'border-accent/60 bg-accent-soft text-accent hover:bg-accent/20'
        }`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : taken ? <Check size={12} aria-hidden /> : <Camera size={12} aria-hidden />}
        {busy ? 'Checking…' : taken ? 'Photo' : 'Photo'}
      </button>

      {error && <span className="text-meta text-error">{error}</span>}

      {/* Shown once, right after the photo, so the person holding the bag
          sees it before they put it down. The card carries it afterwards. */}
      {findings !== null && !error && (
        <span className={`text-meta ${findings.length > 0 ? 'text-warning' : 'text-success'}`}>
          {findings.length > 0 ? `${findings.length} to look at` : 'Nothing seen that should not be'}
        </span>
      )}
    </>
  );
}
