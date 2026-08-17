import React from 'react';

export type StressfulPeriodInsight = {
  id: string;
  day: string;
  day_label: string;
  period_label: string;
  headline: string;
  recommendation: string;
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

export function normalizeStressfulPeriodsPayload(raw: unknown): StressfulPeriodsPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const insightsRaw = Array.isArray(o.insights) ? o.insights : [];
  const insights: StressfulPeriodInsight[] = [];
  for (const entry of insightsRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const headline = typeof item.headline === 'string' ? item.headline.trim() : '';
    const recommendation = typeof item.recommendation === 'string' ? item.recommendation.trim() : '';
    if (!id || !headline || !recommendation) continue;
    insights.push({
      id,
      day: typeof item.day === 'string' ? item.day : '',
      day_label: typeof item.day_label === 'string' ? item.day_label : '',
      period_label: typeof item.period_label === 'string' ? item.period_label : '',
      headline,
      recommendation,
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
      <div className="df-workoutsSectionHeader" style={{ alignItems: 'center', gap: 12 }}>
        <h2 className="df-workoutsTitle" style={{ fontSize: 22, margin: 0 }}>
          Potentially Stressful Periods
        </h2>
        <button
          type="button"
          className="df-btn"
          onClick={onRefresh}
          disabled={isLoading || isRefreshing}
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh Insights'}
        </button>
      </div>

      <p className="df-subtitle" style={{ margin: '0 0 12px', color: '#6b7280' }}>
        Inferred from this week&apos;s calendar load and your Stress &amp; Breaks preferences — not a measured
        stress level.
      </p>

      {error ? (
        <div className="df-errorText" role="alert">
          {error}
        </div>
      ) : null}

      {(isLoading || isRefreshing) && !error && insights.length === 0 ? (
        <p className="df-subtitle" style={{ margin: 0 }} role="status">
          Analyzing this week&apos;s busy periods…
        </p>
      ) : null}

      {!isLoading && !isRefreshing && !error && insights.length === 0 ? (
        <div className="df-stressInsightEmpty" role="status">
          <p className="df-subtitle" style={{ margin: 0 }}>
            {emptyMessage}
          </p>
          <p className="df-subtitle" style={{ margin: '6px 0 0', color: '#6b7280' }}>
            You can still pick a short break from your Activity Library anytime.
          </p>
        </div>
      ) : null}

      {insights.length > 0 ? (
        <div className="df-stressInsightList">
          {insights.map((insight) => (
            <article key={insight.id} className="df-stressInsightCard">
              <div className="df-stressInsightHeadline">{insight.headline}</div>
              <div className="df-stressInsightRecommendation">{insight.recommendation}</div>
              {(insight.suggested_category_label || insight.suggested_duration_minutes) && (
                <div className="df-workoutMeta" style={{ marginTop: 6 }}>
                  {[
                    insight.suggested_category_label,
                    insight.suggested_duration_minutes
                      ? `${insight.suggested_duration_minutes} min`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
