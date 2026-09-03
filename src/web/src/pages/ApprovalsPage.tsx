import { ShieldCheck } from 'lucide-react';
import { ApprovalsPanel } from '../components/ApprovalsPanel.js';

/**
 * Section 45 (Approval Centre): a real, universally-reachable home for
 * every vertical's pending action requests - not just property's, which is
 * the only vertical that previously had a route to ApprovalsPanel at all
 * (embedded as one of PropertyOperationsPage's own tabs). See
 * ApprovalsPanel.tsx's own doc comment for the real gap this closes.
 */
export function ApprovalsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="flex items-start gap-4 rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <ShieldCheck size={22} />
          </div>
          <div>
            <p className="text-meta font-semibold tracking-widest text-accent">APPROVALS</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Review what your agents want to do</h1>
            <p className="mt-3 max-w-2xl text-body leading-7 text-fg-secondary">
              Every real action an AI agent is holding for your sign-off - regardless of which agent or capability
              proposed it - lands here.
            </p>
          </div>
        </section>

        <ApprovalsPanel />
      </div>
    </div>
  );
}
