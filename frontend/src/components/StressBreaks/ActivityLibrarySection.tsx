import React from 'react';
import { ClockIcon, HeartIcon } from '../Sidebar/AppSidebar';
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
  isGenerating: boolean;
  generateError: string;
  favoriteError: string;
  isTogglingFavorite: boolean;
  onGenerate: () => void;
  onRetryLoad: () => void;
  onToggleFavorite: (activity: StressActivity) => void;
  onOpenDetail: (activity: StressActivity) => void;
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
    isGenerating,
    generateError,
    favoriteError,
    isTogglingFavorite,
    onGenerate,
    onRetryLoad,
    onToggleFavorite,
    onOpenDetail,
  } = props;

  const [activeTab, setActiveTab] = React.useState<LibraryTab>('timed');

  const displayed = activeTab === 'timed' ? timedActivities : flexibleActivities;
  const emptyTabMessage =
    activeTab === 'timed'
      ? hasLibrary
        ? 'No Timed activities in your current library. Generate again after selecting Breathing, Meditation, or Stretching preferences.'
        : 'Generate Activities to create Timed break suggestions from your preferences.'
      : hasLibrary
        ? 'No Flexible activities in your current library. Generate again after selecting Walking, Reading, Journaling, Music, or Screen-free preferences.'
        : 'Generate Activities to refresh Flexible breaks from your preferences.';

  return (
    <section className="df-workoutsSection" aria-label="Activity Library">
      <div className="df-workoutsSectionHeader" style={{ alignItems: 'center', gap: 12 }}>
        <h2 className="df-workoutsTitle" style={{ fontSize: 22, margin: 0 }}>
          Activity Library
        </h2>
        <button
          type="button"
          className="df-btn df-btnPrimary"
          onClick={onGenerate}
          disabled={isGenerating || isLoadingLibrary}
        >
          {isGenerating ? 'Generating…' : 'Generate Activities'}
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

      {generateError ? (
        <div className="df-errorText" role="alert" style={{ marginTop: 12 }}>
          {generateError}
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
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
