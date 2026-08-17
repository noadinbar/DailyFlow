import React from 'react';

export type StressfulPeriodInsight = {
  id: string;
  day: string;
  day_label: string;
  period_label: string;
  /** Bold lead clause (no trailing punctuation). */
  lead: string;
  /** Continuation after comma. */
  action: string;
  headline?: string;
  recommendation?: string;
  suggested_category?: string;
  suggested_category_label?: string;
  suggested_duration_minutes?: number;
  reason_code?: string;
};

export type StressfulPeriodsPayload = {
  week_start?: string;
  week_end?: string;
  busy_block_count?: number;
  insights: StressfulPeriodInsight[];
  empty_message?: string | null;
};

type PotentiallyStressfulPeriodsSectionProps = {
  insightsPayload: StressfulPeriodsPayload | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string;
  onRefresh: () => void;
};

function RefreshIcon(props: { size?: number; spinning?: boolean }) {
  const size = props.size ?? 16;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.spinning ? 'df-stressRefreshIconSpin' : undefined}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

export function normalizeStressfulPeriodsPayload(raw: unknown): StressfulPeriodsPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const insightsRaw = Array.isArray(o.insights) ? o.insights : [];
  const insights: StressfulPeriodInsight[] = [];
  for (const entry of insightsRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const leadRaw =
      typeof item.lead === 'string' && item.lead.trim()
        ? item.lead.trim()
        : typeof item.headline === 'string'
          ? item.headline.trim().replace(/[.…]+$/u, '')
          : '';
    const actionRaw =
      typeof item.action === 'string' && item.action.trim()
        ? item.action.trim()
        : typeof item.recommendation === 'string'
          ? item.recommendation.trim().replace(/^Recommended:\s*/i, '')
          : '';
    if (!id || !leadRaw || !actionRaw) continue;
    insights.push({
      id,
      day: typeof item.day === 'string' ? item.day : '',
      day_label: typeof item.day_label === 'string' ? item.day_label : '',
      period_label: typeof item.period_label === 'string' ? item.period_label : '',
      lead: leadRaw,
      action: actionRaw,
      headline: leadRaw,
      recommendation: actionRaw,
      suggested_category: typeof item.suggested_category === 'string' ? item.suggested_category : undefined,
      suggested_category_label:
        typeof item.suggested_category_label === 'string' ? item.suggested_category_label : undefined,
      suggested_duration_minutes:
        typeof item.suggested_duration_minutes === 'number' && Number.isFinite(item.suggested_duration_minutes)
          ? item.suggested_duration_minutes
          : undefined,
      reason_code: typeof item.reason_code === 'string' ? item.reason_code : undefined,
    });
  }
  insights.sort((a, b) => a.day.localeCompare(b.day));
  return {
    week_start: typeof o.week_start === 'string' ? o.week_start : undefined,
    week_end: typeof o.week_end === 'string' ? o.week_end : undefined,
    busy_block_count:
      typeof o.busy_block_count === 'number' && Number.isFinite(o.busy_block_count)
        ? o.busy_block_count
        : undefined,
    insights: insights.slice(0, 3),
    empty_message: typeof o.empty_message === 'string' ? o.empty_message : null,
  };
}

export default function PotentiallyStressfulPeriodsSection(props: PotentiallyStressfulPeriodsSectionProps) {
  const { insightsPayload, isLoading, isRefreshing, error, onRefresh } = props;
  const insights = insightsPayload?.insights || [];
  const emptyMessage =
    insightsPayload?.empty_message || 'No particularly busy periods were identified this week.';

  return (
    <section className="df-workoutsSection df-stressInsightsSection" aria-label="Potentially Stressful Periods">
      <div className="df-workoutsSectionHeader" style={{ alignItems: 'center', gap: 10 }}>
        <h2 className="df-workoutsTitle" style={{ fontSize: 22, margin: 0 }}>
          Potentially Stressful Periods
        </h2>
        <button
          type="button"
          className="df-iconBtn df-stressRefreshBtn"
          onClick={onRefresh}
          disabled={isLoading || isRefreshing}
          aria-label="Refresh insights"
          title="Refresh insights"
        >
          <RefreshIcon size={16} spinning={isRefreshing} />
        </button>
      </div>

      {error ? (
        <div className="df-errorText" role="alert">
          {error}
        </div>
      ) : null}

      {(isLoading || isRefreshing) && !error && insights.length === 0 ? (
        <p className="df-subtitle" style={{ margin: 0, fontSize: 13 }} role="status">
          Analyzing this week&apos;s busy periods…
        </p>
      ) : null}

      {!isLoading && !isRefreshing && !error && insights.length === 0 ? (
        <div className="df-stressInsightEmpty" role="status">
          <p className="df-subtitle" style={{ margin: 0, fontSize: 13 }}>
            {emptyMessage}
          </p>
        </div>
      ) : null}

      {insights.length > 0 ? (
        <div className="df-stressInsightList">
          {insights.map((insight) => (
            <article key={insight.id} className="df-stressInsightCard">
              <p className="df-stressInsightLine">
                <strong>{insight.lead},</strong> {insight.action}
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
