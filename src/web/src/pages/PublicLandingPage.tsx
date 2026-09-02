import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../hooks/useAuth.js';

type BusinessId = 'property' | 'food' | 'retail' | 'beauty' | 'auto' | 'health';

const BUSINESSES: Array<{ id: BusinessId; label: string; description: string; features: string[] }> = [
  {
    id: 'property',
    label: 'Property Management',
    description: 'Maintenance triage, work orders and tenant communication — all from WhatsApp.',
    features: ['Maintenance triage', 'Work order tracking', 'Tenant conversations', 'Vendor coordination', 'Invoices & billing', 'AI property agent'],
  },
  {
    id: 'food',
    label: 'Food & Restaurant',
    description: 'Take orders, manage your menu and coordinate delivery from a single WhatsApp inbox.',
    features: ['AI order capture', 'Menu management', 'Pickup & delivery', 'Kitchen coordination', 'Customer profiles', 'Broadcast promotions'],
  },
  {
    id: 'retail',
    label: 'Retail & Shop',
    description: 'Handle product enquiries, orders and stock from WhatsApp, automatically.',
    features: ['Order capture', 'Product catalogue', 'Stock management', 'Invoice generation', 'Customer profiles', 'Promo broadcasts'],
  },
  {
    id: 'beauty',
    label: 'Beauty & Wellness',
    description: 'Bookings, reminders and client management for salons, spas and studios.',
    features: ['AI booking agent', 'Appointment calendar', 'Service menu', 'Client profiles', 'Automated reminders', 'Loyalty campaigns'],
  },
  {
    id: 'auto',
    label: 'Automotive',
    description: 'Job tracking, estimates and customer communication for garages and dealers.',
    features: ['Service job tracking', 'Estimates & quotes', 'Vehicle history', 'Invoice generation', 'Customer profiles', 'Service reminders'],
  },
  {
    id: 'health',
    label: 'Health & Care',
    description: 'Appointment scheduling and patient communication for clinics and pharmacies.',
    features: ['Appointment booking', 'Patient records', 'Consultation invoices', 'Health reminders', 'Patient profiles', 'AI care agent'],
  },
];

type LegalDocs = {
  terms: { version: string; title: string } | null;
  privacy: { version: string; title: string } | null;
};

type FormPhase = 'form' | 'submitting';

export function PublicLandingPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [selectedId, setSelectedId] = useState<BusinessId | ''>('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [legalDocs, setLegalDocs] = useState<LegalDocs>({ terms: null, privacy: null });
  const [phase, setPhase] = useState<FormPhase>('form');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selected = BUSINESSES.find((b) => b.id === selectedId) ?? null;

  useEffect(() => {
    api.getLegalDocuments()
      .then((docs) => setLegalDocs({ terms: docs.terms, privacy: docs.privacy }))
      .catch(() => undefined);
  }, []);

  const canSubmit =
    !!selectedId && name.trim().length > 0 && email.trim().length > 0 &&
    phone.trim().length >= 5 && agreedToTerms && phase === 'form';

  /**
   * The Terms/Privacy checkbox above is the real, sufficient consent
   * mechanism - recordConsent() still writes the real compliance record
   * (who agreed to which version, when, from what IP), it just no longer
   * gates a separate QR-scanning step before the account exists. That
   * former "Confirm your agreement" QR was never connected to WhatsApp -
   * it encoded a link back into this app, not a Baileys pairing session -
   * so showing it first made the real WhatsApp QR (shown automatically
   * once registerTrial() below succeeds, via the normal onboarding gate)
   * look like a second, later, optional step instead of the actual point
   * of signing up.
   */
  async function handleStart() {
    if (!canSubmit || !selectedId) return;
    if (!legalDocs.terms || !legalDocs.privacy) {
      setSubmitError('Could not load legal documents. Please refresh and try again.');
      return;
    }

    setPhase('submitting');
    setSubmitError(null);

    try {
      await api.recordConsent({
        fullName: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        termsVersion: legalDocs.terms.version,
        privacyVersion: legalDocs.privacy.version,
        marketingOptIn,
      });
      await auth.registerTrial({ name: name.trim(), email: email.trim(), phone: phone.trim(), productKey: selectedId });
    } catch (err) {
      setPhase('form');
      setSubmitError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  }

  return (
    <main className="min-h-full bg-surface-0 text-fg">
      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 lg:px-10">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-body font-bold text-white">A</span>
          <span className="text-body font-semibold tracking-tight">AURA</span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="rounded-lg border border-border-subtle px-4 py-2 text-caption font-medium text-fg-secondary hover:bg-surface-2"
        >
          Sign in
        </button>
      </header>

      {/* Hero + form */}
      <section className="mx-auto grid max-w-6xl items-start gap-12 px-6 pb-24 pt-12 lg:grid-cols-[1fr_440px] lg:px-10">
        {/* Left — copy */}
        <div className="lg:pt-4">
          <p className="mb-4 text-caption font-semibold uppercase tracking-[0.2em] text-accent">
            WhatsApp Operations OS
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-fg sm:text-5xl lg:text-[3.25rem]">
            Run your entire business<br className="hidden lg:block" /> from one WhatsApp inbox.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-8 text-fg-secondary">
            AURA turns your existing WhatsApp number into a full operations platform — AI agents, invoices, bookings, work orders and customer management, built for the way Caribbean businesses already communicate.
          </p>

          {/* Trust signals */}
          <div className="mt-8 flex flex-wrap gap-3">
            {['No payment at signup', '48-hour free trial', 'Your existing WhatsApp number', 'Set up in minutes'].map((t) => (
              <span key={t} className="flex items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1.5 text-caption text-fg-muted">
                <Check size={11} className="text-success" strokeWidth={2.5} aria-hidden />
                {t}
              </span>
            ))}
          </div>

          {/* Feature preview */}
          {selected && (
            <div className="mt-10 rounded-2xl border border-border-subtle bg-surface-1 p-6">
              <p className="text-meta font-semibold uppercase tracking-widest text-accent">{selected.label}</p>
              <p className="mt-2 text-body leading-7 text-fg-secondary">{selected.description}</p>
              <ul className="mt-5 grid grid-cols-2 gap-2">
                {selected.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-caption text-fg-secondary">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                      <Check size={9} strokeWidth={3} aria-hidden />
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!selected && (
            <div className="mt-10 rounded-2xl border border-dashed border-border-subtle p-6 text-center">
              <p className="text-body text-fg-muted">Select your business type to see what's included.</p>
            </div>
          )}
        </div>

        {/* Right — form */}
        <div className="rounded-2xl border border-border-subtle bg-surface-1 p-7 shadow-sm lg:sticky lg:top-8">
              <h2 className="text-xl font-semibold text-fg">Start your free trial</h2>
              <p className="mt-1.5 text-caption text-fg-muted">48 hours, no credit card required.</p>

              <div className="mt-6 flex flex-col gap-4">
                {/* Business type */}
                <div>
                  <label className="block text-caption font-medium text-fg-secondary" htmlFor="biz-type">Type of business</label>
                  <select
                    id="biz-type"
                    value={selectedId}
                    onChange={(e) => setSelectedId(e.target.value as BusinessId | '')}
                    className="mt-1.5 w-full rounded-xl border border-border-subtle bg-surface-0 px-3 py-2.5 text-body text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  >
                    <option value="">Choose your industry…</option>
                    {BUSINESSES.map((b) => (
                      <option key={b.id} value={b.id}>{b.label}</option>
                    ))}
                  </select>
                </div>

                {/* Name */}
                <div>
                  <label className="block text-caption font-medium text-fg-secondary" htmlFor="full-name">Your name</label>
                  <input
                    id="full-name"
                    type="text"
                    required
                    placeholder="Jane Smith"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-border-subtle bg-surface-0 px-3 py-2.5 text-body text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </div>

                {/* Email */}
                <div>
                  <label className="block text-caption font-medium text-fg-secondary" htmlFor="work-email">Work email</label>
                  <input
                    id="work-email"
                    type="email"
                    required
                    placeholder="you@yourbusiness.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-border-subtle bg-surface-0 px-3 py-2.5 text-body text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label className="block text-caption font-medium text-fg-secondary" htmlFor="phone">Phone number</label>
                  <input
                    id="phone"
                    type="tel"
                    required
                    placeholder="+1 246 000 0000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-border-subtle bg-surface-0 px-3 py-2.5 text-body text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </div>

                {/* T&C consent */}
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={agreedToTerms}
                    onChange={(e) => setAgreedToTerms(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-subtle accent-accent"
                  />
                  <span className="text-caption leading-5 text-fg-secondary">
                    I have read and agree to the{' '}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); window.open('/terms', '_blank'); }}
                      className="font-medium text-accent underline underline-offset-2 hover:opacity-80"
                    >
                      Terms of Service
                    </button>{' '}
                    and{' '}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); window.open('/privacy', '_blank'); }}
                      className="font-medium text-accent underline underline-offset-2 hover:opacity-80"
                    >
                      Privacy Policy
                    </button>.
                    <span className="ml-1 text-error">*</span>
                  </span>
                </label>

                {/* Marketing opt-in */}
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={marketingOptIn}
                    onChange={(e) => setMarketingOptIn(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-subtle accent-accent"
                  />
                  <span className="text-caption leading-5 text-fg-muted">
                    I'd like to receive product updates, tips, and occasional promotions from AURA. (Optional — unsubscribe any time.)
                  </span>
                </label>

                {submitError && (
                  <p className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error">{submitError}</p>
                )}

                <button
                  type="button"
                  disabled={!canSubmit}
                  onClick={() => void handleStart()}
                  className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-body font-semibold text-white transition-opacity hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {phase === 'submitting' ? (
                    <><Loader2 size={16} className="animate-spin" aria-hidden /> Setting up your account…</>
                  ) : (
                    <>Get started free <ArrowRight size={16} aria-hidden /></>
                  )}
                </button>

                <p className="text-center text-meta text-fg-muted">
                  Already have an account?{' '}
                  <button type="button" onClick={() => navigate('/login')} className="font-medium text-accent hover:underline">
                    Sign in
                  </button>
                </p>
              </div>
        </div>
      </section>

      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5 text-caption text-fg-muted lg:px-10">
          <span>Clients see only the product they choose. Platform administration, AI providers and infrastructure remain behind the experience.</span>
          <div className="flex gap-4">
            <button type="button" onClick={() => navigate('/terms')} className="hover:text-fg hover:underline">Terms</button>
            <button type="button" onClick={() => navigate('/privacy')} className="hover:text-fg hover:underline">Privacy</button>
          </div>
        </div>
      </footer>
    </main>
  );
}

export function TrialStartPage() {
  const navigate = useNavigate();
  const selected = new URLSearchParams(window.location.search).get('product') ?? window.localStorage.getItem('whatchat:selected-product');

  const PRODUCT_NAMES: Record<string, string> = {
    property: 'AURA Property',
    food: 'AURA Food',
    retail: 'AURA Retail',
    beauty: 'AURA Beauty',
    auto: 'AURA Auto',
    health: 'AURA Health',
  };
  const product = (selected && PRODUCT_NAMES[selected]) ?? 'AURA';

  return (
    <main className="flex min-h-full items-center justify-center bg-surface-0 px-6 py-10 text-fg">
      <section className="w-full max-w-xl rounded-2xl border border-border-subtle bg-surface-1 p-7 shadow-sm">
        <p className="text-meta font-semibold tracking-widest text-accent">48-HOUR FREE TRIAL</p>
        <h1 className="mt-2 text-3xl font-semibold">Start with {product}</h1>
        <p className="mt-3 text-body leading-7 text-fg-secondary">
          Your trial begins when your product account is provisioned. No payment information is requested during this step.
        </p>
        <div className="mt-6 rounded-xl border border-border-subtle bg-surface-2 p-4 text-body text-fg-secondary">
          <p className="font-medium text-fg">What happens next</p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-caption">
            <li>Create your account.</li>
            <li>Connect WhatsApp using the existing QR pairing flow.</li>
            <li>Enter the dashboard for your selected product.</li>
          </ol>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={() => navigate('/')} className="rounded-lg border border-border-subtle px-4 py-3 text-body font-medium hover:bg-surface-2">
            Choose another product
          </button>
          <button type="button" onClick={() => navigate('/')} className="flex-1 rounded-lg bg-accent px-4 py-3 text-body font-semibold text-white hover:bg-accent-dim">
            Continue to account setup
          </button>
        </div>
        <p className="mt-4 text-meta text-fg-muted">
          Trial eligibility and product provisioning are enforced server-side. The public UI does not expose platform administration.
        </p>
      </section>
    </main>
  );
}
