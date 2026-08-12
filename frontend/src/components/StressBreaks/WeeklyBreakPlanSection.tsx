import React from 'react';
import { ClockIcon } from '../Sidebar/AppSidebar';
import { pastelTagStyle } from '../shared/pastelTags';
import { categoryDisplayLabel, type StressActivity } from './activityCategories';

export type WeeklyBreakPlanItem = {
  id: string;
  library_activity_id: string;
  kind: 'timed' | 'flexible';
  title: string;
  category: string;
  category_label?: string;
  duration_minutes: number;
  recommended_day: string;
  recommended_start_time: string;
  recommended_end_time: string;
  summary_short?: string;
};

type WeekDayCard = { dayLabel: string; dateIso: string };

type WeeklyBreakPlanSectionProps = {
  weekCards: WeekDayCard[];
  planItems: WeeklyBreakPlanItem[];
  isSaving: boolean;
  planError: string;
  onRemove: (planId: string) => void;
  onOpenActivity: (libraryActivityId: string) => void;
};

function formatWeeklyPlanDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [, month, day] = value.split('-');
  return `${day}-${month}`;
}

export default function WeeklyBreakPlanSection(props: WeeklyBreakPlanSectionProps) {
  const { weekCards, planItems, isSaving, planError, onRemove, onOpenActivity } = props;

  const suggestionsByDay = React.useMemo(() => {
    const grouped = new Map<string, WeeklyBreakPlanItem[]>();
    for (const item of planItems) {
      const day = item.recommended_day;
      const list = grouped.get(day) || [];
      list.push(item);
      grouped.set(day, list);
    }
    return grouped;
  }, [planItems]);

  const [dayModal, setDayModal] = React.useState<{ dayIso: string; dayLabel: string } | null>(null);
  const dayModalItems = dayModal ? suggestionsByDay.get(dayModal.dayIso) || [] : [];

  return (
    <section className="df-workoutsSection" aria-label="Weekly Break Plan">
      <div className="df-workoutsSectionHeader">
        <h2 className="df-workoutsTitle">Weekly Break Plan</h2>
        <div className="df-workoutsGoal">{`${planItems.length} activities this week`}</div>
      </div>

      {planError ? (
        <div className="df-errorText" role="alert" style={{ marginBottom: 10 }}>
          {planError}
        </div>
      ) : null}

      <div className="df-workoutWeekGrid">
        {weekCards.map((card) => {
          const dayItems = suggestionsByDay.get(card.dateIso) || [];
          const item = dayItems[0];
          const canOpen = Boolean(item);
          return (
            <article
              key={card.dateIso}
              className={`df-workoutDayCard${canOpen ? ' df-workoutLibraryCardClickable' : ''}`}
              onClick={() => {
                if (item) onOpenActivity(item.library_activity_id);
              }}
              role={canOpen ? 'button' : undefined}
              tabIndex={canOpen ? 0 : undefined}
              onKeyDown={(event) => {
                if (!canOpen || !item) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenActivity(item.library_activity_id);
                }
              }}
              aria-label={canOpen ? `Open details for ${item?.title || 'activity'}` : undefined}
            >
              <h3 className="df-workoutDay">{card.dayLabel}</h3>
              {!item ? (
                <div className="df-workoutRestDay">No break planned</div>
              ) : (
                <>
                  <div
                    className="df-workoutTypePill"
                    style={pastelTagStyle(categoryDisplayLabel(item.category, item.category_label))}
                  >
                    {categoryDisplayLabel(item.category, item.category_label)}
                  </div>
                  <div className="df-workoutMeta df-workoutMetaTime">
                    <span className="df-inlineIcon" aria-hidden>
                      <ClockIcon size={14} />
                    </span>
                    {item.duration_minutes} min
                  </div>
                  <div className="df-workoutMeta">{item.title}</div>
                  <div className="df-workoutSlot">
                    <span className="df-inlineIcon" aria-hidden>
                      <ClockIcon size={14} />
                    </span>
                    {formatWeeklyPlanDay(item.recommended_day)} {item.recommended_start_time}-
                    {item.recommended_end_time}
                  </div>
                  <div className="df-weeklyPlanControls">
                    <button
                      type="button"
                      className="df-weeklyPlanControlBtn df-weeklyPlanControlRemove"
                      disabled={isSaving}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(item.id);
                      }}
                      aria-label={`Remove ${item.title} from weekly plan`}
                      title="Remove"
                    >
                      🗑
                    </button>
                  </div>
                  {dayItems.length > 1 && (
                    <button
                      type="button"
                      className="df-btn"
                      style={{ width: '100%', marginTop: 4 }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDayModal({ dayIso: card.dateIso, dayLabel: card.dayLabel });
                      }}
                    >
                      +{dayItems.length - 1} more
                    </button>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>

      {dayModal && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDayModal(null);
          }}
        >
          <div className="df-modalPanel" role="dialog" aria-modal="true" aria-label="Day break activities">
            <div className="df-modalHeader">
              <div className="df-modalTitle">{dayModal.dayLabel} breaks</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setDayModal(null)}
                aria-label="Close day breaks dialog"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 10, maxHeight: '70vh', overflowY: 'auto' }}>
              {dayModalItems.map((planItem) => (
                <article key={planItem.id} className="df-workoutLibraryCard">
                  <div className="df-workoutLibraryCardTop">
                    <h3 className="df-workoutLibraryTitle">{planItem.title}</h3>
                    <div className="df-weeklyPlanControls">
                      <button
                        type="button"
                        className="df-weeklyPlanControlBtn df-weeklyPlanControlRemove"
                        disabled={isSaving}
                        onClick={() => onRemove(planItem.id)}
                        aria-label={`Remove ${planItem.title} from weekly plan`}
                        title="Remove"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                  <div
                    className="df-workoutTypePill"
                    style={pastelTagStyle(categoryDisplayLabel(planItem.category, planItem.category_label))}
                  >
                    {categoryDisplayLabel(planItem.category, planItem.category_label)}
                  </div>
                  <div className="df-workoutMeta df-workoutMetaTime">
                    <span className="df-inlineIcon" aria-hidden>
                      <ClockIcon size={14} />
                    </span>
                    {planItem.duration_minutes} min · {planItem.recommended_start_time}-
                    {planItem.recommended_end_time}
                  </div>
                  <button
                    type="button"
                    className="df-btn"
                    onClick={() => onOpenActivity(planItem.library_activity_id)}
                  >
                    View activity
                  </button>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export type AddToWeeklyPlanModalProps = {
  activity: StressActivity;
  dayOptions: { value: string; label: string }[];
  day: string;
  startTime: string;
  durationMinutes: number | null;
  error: string;
  isSaving: boolean;
  onDayChange: (value: string) => void;
  onStartTimeChange: (value: string) => void;
  onDurationChange: (value: number) => void;
  onSave: () => void;
  onClose: () => void;
};

const FLEXIBLE_DURATION_OPTIONS = [5, 10, 15, 20, 30];

export function AddToWeeklyPlanModal(props: AddToWeeklyPlanModalProps) {
  const {
    activity,
    dayOptions,
    day,
    startTime,
    durationMinutes,
    error,
    isSaving,
    onDayChange,
    onStartTimeChange,
    onDurationChange,
    onSave,
    onClose,
  } = props;

  const isFlexible = activity.kind === 'flexible';
  const durationLabel = isFlexible
    ? durationMinutes
      ? `${durationMinutes} min`
      : 'Choose duration'
    : `${activity.duration_minutes} min`;

  return (
    <div
      className="df-modalBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <div
        className="df-modalPanel df-addWeeklyModal"
        role="dialog"
        aria-modal="true"
        aria-label="Add activity to weekly break plan"
      >
        <div className="df-modalHeader">
          <div className="df-modalTitle">Add to Weekly Break Plan</div>
          <button type="button" className="df-iconBtn" onClick={onClose} aria-label="Close add activity dialog" disabled={isSaving}>
            ✕
          </button>
        </div>
        <div className="df-settingsContent" style={{ display: 'grid', gap: 12 }}>
          <div className="df-workoutMeta">
            {activity.title} · {durationLabel}
          </div>
          <label className="df-field">
            <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
              Day
            </div>
            <select
              className="df-select"
              value={day}
              onChange={(event) => onDayChange(event.target.value)}
              disabled={isSaving}
            >
              {dayOptions.length === 0 && (
                <option value="" disabled>
                  No available days this week
                </option>
              )}
              {dayOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="df-field">
            <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
              Start time (24h, HH:mm)
            </div>
            <input
              className="df-input"
              type="text"
              inputMode="numeric"
              value={startTime}
              placeholder="HH:mm"
              maxLength={5}
              pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
              aria-label="Start time in 24-hour HH:mm format"
              disabled={isSaving}
              onChange={(event) => onStartTimeChange(event.target.value)}
            />
          </label>
          {isFlexible && (
            <label className="df-field">
              <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                Duration
              </div>
              <select
                className="df-select"
                value={durationMinutes ?? ''}
                onChange={(event) => onDurationChange(Number(event.target.value))}
                disabled={isSaving}
              >
                <option value="" disabled>
                  Select duration
                </option>
                {FLEXIBLE_DURATION_OPTIONS.map((mins) => (
                  <option key={mins} value={mins}>
                    {mins} min
                  </option>
                ))}
              </select>
            </label>
          )}
          {error ? <div className="df-errorText">{error}</div> : null}
          <div className="df-weeklyPlanActions">
            <button
              type="button"
              className="df-weeklyPlanActionBtn"
              disabled={
                !day ||
                !startTime ||
                isSaving ||
                (isFlexible && (durationMinutes == null || !FLEXIBLE_DURATION_OPTIONS.includes(durationMinutes)))
              }
              onClick={onSave}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="df-weeklyPlanActionBtn" disabled={isSaving} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
