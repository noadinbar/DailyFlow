import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';

type WorkoutsScreenProps = {
  username?: string;
};

type WeeklyPlanItem = {
  day: string;
  type: string | null;
  duration: string | null;
  location: string | null;
  slot: string | null;
  isRestDay?: boolean;
};

type WorkoutLibraryItem = {
  id: string;
  title: string;
  type: string;
  duration: string;
  location: string;
};

const weeklyPlanPlaceholders: WeeklyPlanItem[] = [
  { day: 'Sun', type: null, duration: null, location: null, slot: null, isRestDay: true },
  { day: 'Mon', type: 'Strength', duration: '35 min', location: 'Gym', slot: 'Mon 07:00-07:35' },
  { day: 'Tue', type: null, duration: null, location: null, slot: null, isRestDay: true },
  { day: 'Wed', type: 'Cardio', duration: '25 min', location: 'Outside', slot: 'Wed 17:00-17:25' },
  { day: 'Thu', type: 'Mobility', duration: '30 min', location: 'Home', slot: 'Thu 18:00-18:30' },
  { day: 'Fri', type: null, duration: null, location: null, slot: null, isRestDay: true },
  { day: 'Sat', type: 'Strength', duration: '45 min', location: 'Gym', slot: 'Sat 10:00-10:45' },
];

const workoutLibraryPlaceholders: WorkoutLibraryItem[] = [
  { id: 'full-body-strength', title: 'Full body strength', type: 'Strength', duration: '40 min', location: 'Gym' },
  { id: 'run-20', title: '20-min run', type: 'Cardio', duration: '20 min', location: 'Outside' },
  { id: 'mobility-reset', title: 'Mobility reset', type: 'Mobility', duration: '15 min', location: 'Home' },
  { id: 'upper-body', title: 'Upper body workout', type: 'Strength', duration: '35 min', location: 'Gym' },
  { id: 'morning-yoga', title: 'Morning yoga flow', type: 'Yoga', duration: '25 min', location: 'Home' },
  { id: 'hiit-home', title: 'HIIT cardio', type: 'Cardio', duration: '30 min', location: 'Home' },
];

export default function WorkoutsScreen(props: WorkoutsScreenProps) {
  const { username } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);

  const displayName = (username || 'Noa Levi').trim();
  const initials = (displayName || 'N').slice(0, 2).toUpperCase();
  const isWorkoutsRoute = location.pathname.startsWith('/workouts');

  return (
    <section className="df-calendarPage df-workoutsPage" aria-label="DailyFlow workouts screen">
      <aside className="df-calendarLeftNav">
        <div className="df-calendarBrand">DailyFlow</div>
        <div className="df-calendarProfile">
          <div className="df-calendarProfileAvatar">{initials}</div>
          <div>
            <div className="df-calendarProfileName">{displayName}</div>
            <div className="df-calendarProfileHint">Plan your week</div>
          </div>
          <button
            type="button"
            className="df-iconBtn"
            onClick={() => setIsProfileSettingsOpen(true)}
            aria-label="Open profile settings"
            title="Settings"
            style={{ marginInlineStart: 'auto' }}
          >
            ⚙️
          </button>
        </div>

        <nav className="df-calendarMenu" aria-label="Main sections">
          <button type="button" className="df-calendarMenuItem" onClick={() => navigate('/calendar')}>
            Calendar
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
            Meals & Grocery
          </button>
          <button
            type="button"
            className={`df-calendarMenuItem${isWorkoutsRoute ? ' df-calendarMenuItemActive' : ''}`}
            onClick={() => navigate('/workouts')}
          >
            Workouts
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
            Stress & Breaks
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
            Overview
          </button>
        </nav>
      </aside>

      <div className="df-calendarMain">
        <header className="df-calendarTopbar">
          <div className="df-calendarTopbarLeft">
            <button type="button" className="df-btn">
              This week
            </button>
            <button type="button" className="df-btn df-btnPrimary">
              Generate plan
            </button>
            <button type="button" className="df-btn">
              Add all to calendar
            </button>
          </div>
          <div className="df-calendarTopbarRight">
            <div className="df-workoutsTopbarUser">{displayName}</div>
            <div className="df-workoutsAvatar">{initials}</div>
            <button
              type="button"
              className="df-iconBtn"
              onClick={() => setIsProfileSettingsOpen(true)}
              aria-label="Open profile settings"
              title="Settings"
            >
              ⚙️
            </button>
          </div>
        </header>

        <div className="df-workoutsContent">
          <section className="df-workoutsSection">
            <div className="df-workoutsSectionHeader">
              <h2 className="df-workoutsTitle">Weekly Workout Plan</h2>
              <div className="df-workoutsGoal">Goal: 3 workouts/week</div>
            </div>
            <div className="df-workoutWeekGrid">
              {weeklyPlanPlaceholders.map((item) => (
                <article key={item.day} className="df-workoutDayCard">
                  <h3 className="df-workoutDay">{item.day}</h3>
                  {item.isRestDay ? (
                    <div className="df-workoutRestDay">Rest day</div>
                  ) : (
                    <>
                      <div className="df-workoutTypePill">{item.type}</div>
                      <div className="df-workoutMeta">{item.duration}</div>
                      <div className="df-workoutMeta">{item.location}</div>
                      <div className="df-workoutSlot">{item.slot}</div>
                      <button type="button" className="df-workoutAddBtn">
                        + Add
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="df-workoutsSection">
            <h2 className="df-workoutsTitle">Workout Library</h2>
            <div className="df-workoutFilters">
              <div className="df-workoutFilterGroup">
                <span className="df-workoutFilterLabel">Type</span>
                <button type="button" className="df-workoutFilterChip">Strength</button>
                <button type="button" className="df-workoutFilterChip">Cardio</button>
                <button type="button" className="df-workoutFilterChip">Mobility</button>
                <button type="button" className="df-workoutFilterChip">Yoga</button>
              </div>
              <div className="df-workoutFilterGroup">
                <span className="df-workoutFilterLabel">Duration</span>
                <button type="button" className="df-workoutFilterChip">&lt; 20 min</button>
                <button type="button" className="df-workoutFilterChip">20-40 min</button>
                <button type="button" className="df-workoutFilterChip">40+ min</button>
              </div>
            </div>
            <div className="df-workoutLibraryGrid">
              {workoutLibraryPlaceholders.map((item) => (
                <article key={item.id} className="df-workoutLibraryCard">
                  <div className="df-workoutLibraryCardTop">
                    <h3 className="df-workoutLibraryTitle">{item.title}</h3>
                    <button type="button" className="df-workoutLibraryAdd" aria-label={`Add ${item.title}`}>
                      +
                    </button>
                  </div>
                  <div className="df-workoutTypePill">{item.type}</div>
                  <div className="df-workoutMeta">{item.duration}</div>
                  <div className="df-workoutMeta">{item.location}</div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>

      <ProfileSettingsModal
        isOpen={isProfileSettingsOpen}
        initialName={displayName}
        onClose={() => setIsProfileSettingsOpen(false)}
      />
    </section>
  );
}
