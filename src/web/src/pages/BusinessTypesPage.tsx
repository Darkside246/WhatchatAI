import { Link } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';
import { PRODUCTS } from '../lib/productCatalog.js';

/**
 * Every business type AURA can run, behind one icon.
 *
 * This replaces the two vertical entries the platform nav used to carry -
 * Property Ops and Retail Ops - which between them were both incomplete and
 * misleading: Food had no entry at all, so the entire food vertical
 * (operations, kitchen, menu, QC) could only be opened by typing the URL,
 * and the two that were there went straight to an operations screen rather
 * than to the vertical, so there was no way to reach the rest of it.
 *
 * Choosing a tile opens that vertical's overview, which is what switches the
 * nav rail to that vertical's own destinations - the operations screen
 * included. The direct operations link on a tile is a shortcut to the same
 * place the old nav entries went, kept so nothing got harder.
 *
 * Developer-only, as asked. Worth being precise about what that means: this
 * page holds no data of its own, only links, and each vertical's screens
 * fetch through the API under the caller's own tenancy. So the gate here is
 * scope, not security - it stops a customer seeing nine products they did
 * not buy. The server remains the thing that decides what anyone can read.
 */
export function BusinessTypesPage() {
  const { business } = useAuth();

  if (!business?.isDeveloper) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-border-subtle bg-surface-1 p-6 text-center">
          <Lock size={20} className="mx-auto mb-3 text-fg-muted" aria-hidden />
          <h1 className="text-h3 font-semibold text-fg">Business types</h1>
          <p className="mt-2 text-caption text-fg-secondary">
            Switching between business types is a developer tool. Your workspace is set up for your own business, and
            everything it needs is in the menu on the left.
          </p>
          <Link
            to="/dashboard"
            className="mt-4 inline-flex items-center gap-1.5 text-caption font-medium text-accent hover:underline"
          >
            Back to dashboard
            <ArrowRight size={14} aria-hidden />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <header className="mb-5">
        <h1 className="text-h2 font-semibold text-fg">Business types</h1>
        <p className="mt-1 max-w-2xl text-caption text-fg-secondary">
          Every vertical AURA can run a business as. Opening one switches the workspace to that vertical, so the menu on
          the left becomes its own - conversations, operations, agent and settings for that business type.
        </p>
      </header>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {PRODUCTS.map((product) => (
          <li key={product.key}>
            {/* The whole tile is the link to the vertical, so selecting one is
                a single click anywhere on it rather than a hunt for the words. */}
            <div className="flex h-full flex-col rounded-xl border border-border-subtle bg-surface-1 transition-colors hover:border-accent/40">
              <Link to={product.overview} className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <product.icon size={18} strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="text-body font-semibold text-fg">{product.name}</span>
                </div>
                <p className="text-caption leading-relaxed text-fg-secondary">{product.description}</p>
              </Link>

              <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-4 py-2.5">
                {product.operations ? (
                  <Link
                    to={product.operations}
                    className="inline-flex items-center gap-1.5 text-meta font-medium text-accent hover:underline"
                  >
                    Open operations
                    <ArrowRight size={12} aria-hidden />
                  </Link>
                ) : (
                  /* Said plainly rather than offered as a link that lands on a
                     "coming soon" page - a tile should not promise a screen
                     that is not built. */
                  <span className="text-meta text-fg-muted">Operations screen not built yet</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
