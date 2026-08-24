import React from 'react';
import { CalendarPlusIcon, ClockIcon, HeartIcon } from '../Sidebar/AppSidebar';
import { pastelTagStyle } from '../shared/pastelTags';
import {
  activityFavoriteKey,
  activityMatchSignature,
  categoryDisplayLabel,
  type StressActivity,
} from './activityCategories';

type LibraryTab = 'timed' | 'flexible';

type ActivityLibrarySectionProps = {
  timedActivities: StressActivity[];
  flexibleActivities: StressActivity[];
  favoriteKeySet: Set<string>;
  favoriteSignatureSet: Set<string>;
  hasLibrary: boolean;
  isLoadingLibrary: boolean;
  libraryLoadError: string;
  favoriteError: string;
  isTogglingFavorite: boolean;
  isSavingWeeklyPlan: boolean;
  onRetryLoad: () => void;
  onToggleFavorite: (activity: StressActivity) => void;
  onOpenDetail: (activity: StressActivity) => void;
  onAddToWeeklyPlan: (activity: StressActivity) => void;
};

export default function ActivityLibrarySection(props: ActivityLibrarySectionProps) {
  const {
    timedActivities,
    flexibleActivities,
    favoriteKeySet,
    favoriteSignatureSet,
    hasLibrary,
    isLoadingLibrary,
    libraryLoadError,
    favoriteError,
    isTogglingFavorite,
    isSavingWeeklyPlan,
    onRetryLoad,
    onToggleFavorite,
    onOpenDetail,
    onAddToWeeklyPlan,
  } = props;

  const [activeTab, setActiveTab] = React.useState<LibraryTab>('timed');
  const [isFavoritesMode, setIsFavoritesMode] = React.useState(false);

  const tabActivities = activeTab === 'timed' ? timedActivities : flexibleActivities;
  const displayed = React.useMemo(() => {
    if (!isFavoritesMode) return tabActivities;
    return tabActivities.filter((item) => {
      const favKey = activityFavoriteKey(item);
      return favoriteKeySet.has(favKey) || favoriteSignatureSet.has(activityMatchSignature(item));
    });
  }, [isFavoritesMode, tabActivities, favoriteKeySet, favoriteSignatureSet]);

  const emptyTabMessage = isFavoritesMode
    ? activeTab === 'timed'
      ? 'No favorite Timed activities match the current view.'
      : 'No favorite Flexible activities match the current view.'
    : activeTab === 'timed'
      ? hasLibrary
        ? 'No Timed activities in your current library. Generate again after selecting Breathing, Meditation, or Stretching preferences.'
        : 'Generate Activities to create Timed break suggestions from your preferences.'
      : hasLibrary
        ? 'No Flexible activities in your current library. Generate again after selecting Walking, Reading, Journaling, Music, or Screen-free preferences.'
        : 'Generate Activities to refresh Flexible breaks from your preferences.';

  return (
    <section className="df-workoutsSection" aria-label="Activity Library">
      <div className="df-workoutsSectionHeader">
        <h2 className="df-workoutsTitle">Activity Library</h2>
        <button
          type="button"
          className={`df-workoutFavoriteToggle${isFavoritesMode ? ' df-workoutFavoriteToggleActive' : ''}`}
          onClick={() => setIsFavoritesMode((prev) => !prev)}
          aria-label={isFavoritesMode ? 'Show all activities' : 'Show favorite activities only'}
          title={isFavoritesMode ? 'Showing favorites' : 'Show favorites'}
        >
          ❤
        </button>
      </div>

      <div className="df-stressLibraryTabs" role="tablist" aria-label="Activity library tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'timed'}
          className={`df-workoutFilterChip${activeTab === 'timed' ? ' df-workoutFilterChipActive' : ''}`}
          onClick={() => setActiveTab('timed')}
        >
          Timed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'flexible'}
          className={`df-workoutFilterChip${activeTab === 'flexible' ? ' df-workoutFilterChipActive' : ''}`}
          onClick={() => setActiveTab('flexible')}
        >
          Flexible
        </button>
      </div>

      {libraryLoadError ? (
        <div className="df-errorText" role="alert" style={{ marginTop: 12 }}>
          {libraryLoadError}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="df-btn df-btnPrimary" onClick={onRetryLoad}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {favoriteError ? (
        <div className="df-errorText" role="alert" style={{ marginTop: 12 }}>
          {favoriteError}
        </div>
      ) : null}

      {isLoadingLibrary ? (
        <p className="df-subtitle" style={{ marginTop: 14 }} role="status">
          Loading activity library…
        </p>
      ) : null}

      {!isLoadingLibrary && !libraryLoadError && !hasLibrary && (
        <div className="df-stressLibraryEmpty" role="status">
          <p className="df-subtitle" style={{ margin: 0 }}>
            Your Activity Library is empty. Click <strong>Generate Activities</strong> to create Timed
            suggestions and refresh Flexible breaks from your saved Stress &amp; Breaks preferences.
          </p>
        </div>
      )}

      {!isLoadingLibrary && !libraryLoadError && hasLibrary && displayed.length === 0 && (
        <p className="df-subtitle" style={{ marginTop: 14 }} role="status">
          {emptyTabMessage}
        </p>
      )}

      {!isLoadingLibrary && !libraryLoadError && displayed.length > 0 && (
        <div className="df-workoutLibraryGrid" style={{ marginTop: 14 }}>
          {displayed.map((item) => {
            const favKey = activityFavoriteKey(item);
            const isFav = favoriteKeySet.has(favKey) || favoriteSignatureSet.has(activityMatchSignature(item));
            const categoryLabel = categoryDisplayLabel(item.category, item.category_label);
            const durationLabel =
              item.kind === 'flexible' || item.duration_minutes == null
                ? 'Flexible'
                : `${item.duration_minutes} min`;
            return (
              <article
                key={item.id}
                className="df-workoutLibraryCard df-workoutLibraryCardClickable"
                onClick={() => onOpenDetail(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenDetail(item);
                  }
                }}
                aria-label={`Open details for ${item.title}`}
              >
                <div className="df-workoutLibraryCardTop">
                  <h3 className="df-workoutLibraryTitle">{item.title}</h3>
                  <button
                    type="button"
                    className={`df-favoriteHeartBtn${isFav ? ' df-favoriteHeartBtnActive' : ''}`}
                    aria-label={`Toggle favorite for ${item.title}`}
                    aria-pressed={isFav}
                    title={isFav ? 'Unfavorite' : 'Favorite'}
                    disabled={isTogglingFavorite}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFavorite(item);
                    }}
                  >
                    <HeartIcon size={18} filled={isFav} />
                  </button>
                </div>
                <div className="df-workoutTypePill" style={pastelTagStyle(categoryLabel)}>
                  {categoryLabel}
                </div>
                <div className="df-workoutMeta df-workoutMetaTime">
                  <span className="df-inlineIcon" aria-hidden>
                    <ClockIcon size={14} />
                  </span>
                  {durationLabel}
                </div>
                <div className="df-workoutMeta df-workoutLibrarySummary">{item.summary_short}</div>
                <button
                  type="button"
                  className="df-mealLibraryCalendarBtn df-workoutLibraryActionBtn"
                  aria-label={`Add ${item.title} to weekly break plan`}
                  title="Add to weekly break plan"
                  disabled={isSavingWeeklyPlan}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAddToWeeklyPlan(item);
                  }}
                >
                  <span className="df-mealLibraryCalendarBtnIcon df-inlineIcon" aria-hidden>
                    <CalendarPlusIcon size={16} />
                  </span>
                  Add to plan
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
