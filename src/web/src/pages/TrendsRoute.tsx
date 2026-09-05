import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Sparkles, AlertCircle } from 'lucide-react';
import { api, type BiInsight } from '../lib/api.js';

/**
 * Business Intelligence Agent's Trends page - the first real implementation
 * (this route was a bare "coming soon" placeholder before this feature).
 * Renders only what businessIntelligenceService.getApprovedInsightsByCategory
 * returns: status='approved' bi_insights rows only - anything held/rejected
 * by the quality gate never reaches this page. Categories match directive
 * §29 exactly.
 */

const CATEGORY_LABELS: Record<BiInsight['category'], string> = {
  sentiment: 'Customer Sentiment',
  product_performance: 'Product Performance',
  feedback: 'Customer Feedback',
  emerging: 'Emerging Trends',
  operations: 'Operations',
};

const CATEGORY_ORDER: BiInsight['category'][] = ['sentiment', 'product_performance', 'feedback', 'emerging', 'operations'];

const CONFIDENCE_BADGE: Record<BiInsight['confidence'], string> = {
  insufficient_data: 'bg-fg-muted/15 text-fg-muted',
  early_signal: 'bg-warning/15 text-warning',
  moderate: 'bg-info/15 text-info',
  high: 'bg-success/15 text-success',
};

const CONFIDENCE_LABEL: Record<BiInsight['confidence'], string> = {
  insufficient_data: 'Insufficient data',
  early_signal: 'Early signal',
  moderate: 'Moderate confidence',
  high: 'High confidence',
};

function DirectionIcon({ direction }: { direction: BiInsight['direction'] }) {
  if (direction === 'increasing' || direction === 'emerging') return <TrendingUp size={14} className="text-success" aria-hidden />;
  if (direction === 'decreasing' || direction === 'declining') return <TrendingDown size={14} className="text-error" aria-hidden />;
  return <Minus size={14} className="text-fg-muted" aria-hidden />;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function InsightCard({ insight }: { insight: BiInsight }) {
  return (
    <div className="space-y-2 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-body font-semibold text-fg">{insight.title}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${CONFIDENCE_BADGE[insight.confidence]}`}>
          {CONFIDENCE_LABEL[insight.confidence]}
        </span>
      </div>
      <p className="text-caption text-fg-secondary">{insight.body}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-muted">
        {insight.direction && (
          <span className="flex items-center gap-1">
            <DirectionIcon direction={insight.direction} />
            {insight.direction}
            {insight.metricChangePct !== null && ` ${insight.metricChangePct > 0 ? '+' : ''}${insight.metricChangePct}%`}
          </span>
        )}
        <span>
          Based on {insight.evidenceObservationCount.toLocaleString()} observation{insight.evidenceObservationCount === 1 ? '' : 's'} across{' '}
          {insight.evidenceConversationCount.toLocaleString()} conversation{insight.evidenceConversationCount === 1 ? '' : 's'}
        </span>
        <span>{fmtDate(insight.periodStart)} – {fmtDate(insight.periodEnd)}</span>
      </div>
    </div>
  );
}

function CategorySection({ category, insights, biEnabled }: { category: BiInsight['category']; insights: BiInsight[]; biEnabled: boolean }) {
  return (
    <section className="space-y-3">
      <h2 className="text-body font-semibold text-fg">{CATEGORY_LABELS[category]}</h2>
      {insights.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle p-4 text-caption text-fg-muted">
          {biEnabled ? 'Nothing significant this period.' : 'Not enough data yet — turn on Business Intelligence on the AI agents page.'}
        </div>
      ) : (
        <div className="space-y-3">
          {insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}
    </section>
  );
}

export function TrendsRoute() {
  const [insightsByCategory, setInsightsByCategory] = useState<Record<BiInsight['category'], BiInsight[]> | null>(null);
  const [biEnabled, setBiEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getTrends(), api.getBusinessIntelligenceStats()])
      .then(([trends, stats]) => {
        if (cancelled) return;
        setInsightsByCategory(trends.insights);
        setBiEnabled(stats.enabled);
      })
      .catch(() => { if (!cancelled) setError('Could not load Trends right now.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-start gap-3">
          <div>
            <h1 className="text-title font-semibold text-fg">Trends</h1>
            <p className="mt-1 text-body text-fg-muted">
              Aggregate, evidence-backed patterns from your chats, invoices and documents — reviewed before publishing, never naming an individual customer.
            </p>
          </div>
        </div>

        {loading && <p className="mt-6 text-caption text-fg-muted">Loading…</p>}

        {error && (
          <div className="mt-6 flex items-center gap-2 rounded-xl border border-error/30 bg-error/5 p-4 text-caption text-error">
            <AlertCircle size={14} aria-hidden /> {error}
          </div>
        )}

        {!loading && !error && !biEnabled && (
          <div className="mt-6 flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-2 p-4 text-caption text-fg-secondary">
            <Sparkles size={14} className="text-accent" aria-hidden />
            Business Intelligence is off — turn it on from the AI agents page to start building Trends from your real data.
          </div>
        )}

        {!loading && !error && insightsByCategory && (
          <div className="mt-6 space-y-8">
            {CATEGORY_ORDER.map((category) => (
              <CategorySection key={category} category={category} insights={insightsByCategory[category]} biEnabled={biEnabled} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
