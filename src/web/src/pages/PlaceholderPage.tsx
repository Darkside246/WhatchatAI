interface Props {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: Props) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold text-fg">{title}</h1>
      <p className="max-w-sm text-sm text-fg-muted">{description}</p>
      <span className="mt-2 rounded-full bg-surface-2 px-3 py-1 text-xs text-fg-secondary">Not built yet</span>
    </div>
  );
}
