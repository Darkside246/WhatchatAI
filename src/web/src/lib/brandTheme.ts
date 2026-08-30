/**
 * Overrides the app's single semantic accent token (see index.css's
 * `--color-accent`/`--color-accent-dim`/`--color-accent-soft`) with a
 * business's own brand color. Every component already styles itself from
 * those token names rather than a hardcoded hex - the same mechanism the
 * built-in [data-theme] palettes use to swap themes without touching
 * component code - so this is the one place a business's brand color needs
 * to be applied for it to reach the whole dashboard UI.
 */
export function applyBrandTheme(brandColor: string | null): void {
  const root = document.documentElement;
  if (!brandColor || !/^#[0-9A-Fa-f]{6}$/.test(brandColor)) {
    root.style.removeProperty('--color-accent');
    root.style.removeProperty('--color-accent-dim');
    root.style.removeProperty('--color-accent-soft');
    return;
  }
  root.style.setProperty('--color-accent', brandColor);
  root.style.setProperty('--color-accent-dim', shade(brandColor, -0.15));
  root.style.setProperty('--color-accent-soft', `${brandColor}1f`);
}

/** amount < 0 darkens toward black, amount > 0 lightens toward white. */
function shade(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const channel = (shift: number): number => {
    const value = (num >> shift) & 0xff;
    const adjusted = amount < 0 ? value * (1 + amount) : value + (255 - value) * amount;
    return Math.max(0, Math.min(255, Math.round(adjusted)));
  };
  const r = channel(16);
  const g = channel(8);
  const b = channel(0);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
