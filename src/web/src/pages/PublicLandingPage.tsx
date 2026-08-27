import { useNavigate } from 'react-router-dom';

const products = [
  {
    id: 'property',
    name: 'WhatsChat Property',
    eyebrow: 'PROPERTY OPERATIONS',
    description: 'Turn WhatsApp into a maintenance and property operations command centre.',
    features: ['Maintenance triage', 'Work orders', 'Tenant conversations', 'Vendor coordination'],
  },
  {
    id: 'food',
    name: 'WhatsChat Food',
    eyebrow: 'FOOD OPERATIONS',
    description: 'Take orders, manage menus and coordinate pickup and delivery from WhatsApp.',
    features: ['AI ordering', 'Menu management', 'Pickup and delivery', 'Customer conversations'],
  },
] as const;

export function PublicLandingPage() {
  const navigate = useNavigate();

  function startTrial(product: (typeof products)[number]['id']) {
    window.localStorage.setItem('whatchat:selected-product', product);
    navigate(`/trial?product=${product}`);
  }

  return (
    <main className="min-h-full bg-surface-0 text-fg">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-6 lg:px-10">
        <header className="flex items-center justify-between border-b border-border-subtle pb-5">
          <button type="button" onClick={() => navigate('/')} className="flex items-center gap-3 text-left">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-title font-bold text-white">W</span>
            <span><strong className="block text-title">WhatsChat</strong><span className="text-caption text-fg-muted">WhatsApp Operations OS</span></span>
          </button>
          <button type="button" onClick={() => navigate('/login')} className="rounded-lg border border-border-subtle px-4 py-2 text-body font-medium hover:bg-surface-2">Sign in</button>
        </header>

        <div className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="mb-5 text-caption font-semibold uppercase tracking-[0.22em] text-accent">Run your business from WhatsApp</p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-tight tracking-tight text-fg lg:text-6xl">One WhatsApp connection. A complete operations system behind it.</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-fg-secondary">Choose the WhatsChat product built for your business. Start with a full 48-hour trial, connect WhatsApp and operate from a focused dashboard.</p>
            <div className="mt-8 flex flex-wrap gap-3 text-caption text-fg-muted">
              <span className="rounded-full border border-border-subtle px-3 py-1.5">No payment at signup</span>
              <span className="rounded-full border border-border-subtle px-3 py-1.5">One trial per email</span>
              <span className="rounded-full border border-border-subtle px-3 py-1.5">Existing WhatsApp pairing</span>
            </div>
          </div>

          <div className="grid gap-4">
            {products.map((product) => (
              <article key={product.id} className="rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-sm">
                <p className="text-meta font-semibold tracking-widest text-accent">{product.eyebrow}</p>
                <h2 className="mt-2 text-2xl font-semibold">{product.name}</h2>
                <p className="mt-3 text-body leading-7 text-fg-secondary">{product.description}</p>
                <ul className="mt-5 grid gap-2 text-caption text-fg-secondary sm:grid-cols-2">
                  {product.features.map((feature) => <li key={feature} className="rounded-lg bg-surface-2 px-3 py-2">{feature}</li>)}
                </ul>
                <button type="button" onClick={() => startTrial(product.id)} className="mt-6 w-full rounded-lg bg-accent px-4 py-3 text-body font-semibold text-white hover:bg-accent-dim">Start 48-hour free trial</button>
              </article>
            ))}
          </div>
        </div>

        <footer className="border-t border-border-subtle pt-5 text-caption text-fg-muted">Clients see only the product they choose. Platform administration, AI providers and infrastructure remain behind the experience.</footer>
      </section>
    </main>
  );
}

export function TrialStartPage() {
  const navigate = useNavigate();
  const selected = new URLSearchParams(window.location.search).get('product') ?? window.localStorage.getItem('whatchat:selected-product');
  const product = selected === 'food' ? 'WhatsChat Food' : 'WhatsChat Property';

  return (
    <main className="flex min-h-full items-center justify-center bg-surface-0 px-6 py-10 text-fg">
      <section className="w-full max-w-xl rounded-2xl border border-border-subtle bg-surface-1 p-7 shadow-sm">
        <p className="text-meta font-semibold tracking-widest text-accent">48-HOUR FREE TRIAL</p>
        <h1 className="mt-2 text-3xl font-semibold">Start with {product}</h1>
        <p className="mt-3 text-body leading-7 text-fg-secondary">Your trial begins when your product account is provisioned. No payment information is requested during this step.</p>
        <div className="mt-6 rounded-xl border border-border-subtle bg-surface-2 p-4 text-body text-fg-secondary">
          <p className="font-medium text-fg">What happens next</p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-caption">
            <li>Create your account.</li>
            <li>Connect WhatsApp using the existing QR pairing flow.</li>
            <li>Enter the dashboard for your selected product.</li>
          </ol>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={() => navigate('/')} className="rounded-lg border border-border-subtle px-4 py-3 text-body font-medium hover:bg-surface-2">Choose another product</button>
          <button type="button" onClick={() => navigate('/register')} className="flex-1 rounded-lg bg-accent px-4 py-3 text-body font-semibold text-white hover:bg-accent-dim">Continue to account setup</button>
        </div>
        <p className="mt-4 text-meta text-fg-muted">Trial eligibility and product provisioning are enforced server-side. The public UI does not expose platform administration.</p>
      </section>
    </main>
  );
}
