interface Props {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Accessible label - this control has no visible text of its own. */
  label: string;
}

/**
 * A real iOS-style on/off switch: a pill track that slides a circular thumb
 * left/right, not a button whose label changes. Used wherever a setting is
 * a genuine binary state (on this app: the per-agent AI kill switch).
 */
export function ToggleSwitch({ checked, onChange, disabled = false, label }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-success' : 'bg-fg-muted/30'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ease-in-out ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
