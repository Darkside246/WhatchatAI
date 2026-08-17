const SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-16 w-16 text-xl',
} as const;

const PX_SIZES = { sm: 36, md: 44, lg: 64 } as const;

interface Props {
  /** The real display name (or JID/phone number fallback) this initial is derived from - never a fabricated name. */
  label: string;
  size?: keyof typeof SIZES;
  className?: string;
  /** The real, non-expired status count for this contact right now - the ring divides into exactly this many segments, same as WhatsApp's own UI. 0 (or omitted) renders no ring at all. */
  statusCount?: number;
  /** The real, authenticated media URL for this contact/account's downloaded profile picture - never a raw WhatsApp CDN link, never a placeholder. */
  photoUrl?: string | null;
}

/**
 * The real WhatsApp-style status ring: one arc segment per active status,
 * separated by real gaps - never a flat dashed circle standing in for an
 * unknown count. A single status renders as a solid ring, matching
 * WhatsApp's own behavior.
 */
function StatusRing({ count, boxSize }: { count: number; boxSize: number }) {
  if (count <= 0) return null;
  const strokeWidth = 2.5;
  const radius = boxSize / 2 - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = count === 1 ? 0 : Math.min(6, circumference / count / 4);
  const segmentLength = count === 1 ? circumference : circumference / count - gap;

  return (
    <svg
      width={boxSize}
      height={boxSize}
      viewBox={`0 0 ${boxSize} ${boxSize}`}
      className="absolute inset-0 -rotate-90 text-accent"
      aria-hidden
    >
      <circle
        cx={boxSize / 2}
        cy={boxSize / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeDasharray={`${segmentLength} ${gap}`}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Renders the real downloaded profile picture when one exists; otherwise
 * falls back to the actual first letter of whatever real identity string
 * the caller has - never a stock image or placeholder person icon.
 */
export function Avatar({ label, size = 'md', className = '', statusCount = 0, photoUrl = null }: Props) {
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

  if (statusCount <= 0) {
    return <div className={`shrink-0 ${className}`}>{circle}</div>;
  }

  const boxSize = PX_SIZES[size] + 8;

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: boxSize, height: boxSize }}
      title={statusCount === 1 ? 'Has an active status' : `Has ${statusCount} active statuses`}
    >
      <StatusRing count={statusCount} boxSize={boxSize} />
      <div className="absolute inset-0 flex items-center justify-center">{circle}</div>
    </div>
  );
}
