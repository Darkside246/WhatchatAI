const SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-16 w-16 text-xl',
} as const;

interface Props {
  /** The real display name (or JID/phone number fallback) this initial is derived from - never a fabricated name. */
  label: string;
  size?: keyof typeof SIZES;
  className?: string;
  /** A real, non-expired WhatsApp status exists for this contact right now - renders the WhatsApp-style dashed status ring. */
  hasActiveStatus?: boolean;
  /** The real, authenticated media URL for this contact/account's downloaded profile picture - never a raw WhatsApp CDN link, never a placeholder. */
  photoUrl?: string | null;
}

/**
 * Renders the real downloaded profile picture when one exists; otherwise
 * falls back to the actual first letter of whatever real identity string
 * the caller has - never a stock image or placeholder person icon.
 */
export function Avatar({ label, size = 'md', className = '', hasActiveStatus = false, photoUrl = null }: Props) {
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';
  const circle = photoUrl ? (
    <img
      src={photoUrl}
      alt=""
      className={`shrink-0 rounded-full object-cover ring-2 ring-surface-1 ${SIZES[size]}`}
      aria-hidden
    />
  ) : (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-fg-secondary ring-2 ring-surface-1 ${SIZES[size]}`}
      aria-hidden
    >
      {initial}
    </div>
  );

  if (!hasActiveStatus) {
    return <div className={`shrink-0 ${className}`}>{circle}</div>;
  }

  return (
    <div
      className={`shrink-0 rounded-full border-2 border-dashed border-accent p-0.5 ${className}`}
      title="Has an active status"
    >
      {circle}
    </div>
  );
}
