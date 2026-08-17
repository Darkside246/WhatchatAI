import { useEffect } from 'react';
import { X, Download } from 'lucide-react';

interface Props {
  imageUrl: string;
  fileName: string | null;
  onClose: () => void;
}

/** A real fullscreen viewer over the same authenticated /api/media/:id URL the inline bubble thumbnail already uses - no separate fetch, no placeholder. */
export function MediaLightbox({ imageUrl, fileName, onClose }: Props) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-between bg-black/95 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div className="flex items-center justify-end gap-2 text-white" onClick={(e) => e.stopPropagation()}>
        <a
          href={imageUrl}
          download={fileName ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          title="Download"
        >
          <Download size={18} aria-hidden />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          title="Close"
        >
          <X size={18} aria-hidden />
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        <img src={imageUrl} alt="Full size preview" className="max-h-[85vh] max-w-full rounded-xl object-contain shadow-2xl" />
      </div>
    </div>
  );
}
