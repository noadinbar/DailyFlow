import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import dailyflowLogoUrl from '../../../visuals/small_logo.png';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'dailyflow_sidebar_collapsed';

/**
 * Persisted, screen-shared collapsed state for the left sidebar.
 *
 * The state lives in localStorage so the sidebar stays consistent when the
 * user navigates between Calendar / Meals / Workouts (each route mounts a
 * fresh screen-level component).
 */
export function useSidebarCollapsed(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const update = React.useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const computed = typeof next === 'function' ? next(prev) : next;
        try {
          window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, computed ? '1' : '0');
        } catch {
          // localStorage may be unavailable (private mode); state still works in memory.
        }
        return computed;
      });
    },
    []
  );
  return [value, update];
}

type SidebarItem = {
  label: string;
  route: string;
  icon: React.ReactNode;
  disabled?: boolean;
};

type AppSidebarProps = {
  displayName: string;
  profileImageUrl?: string;
  onOpenSettings: () => void;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
};

export default function AppSidebar(props: AppSidebarProps) {
  const { displayName, profileImageUrl, onOpenSettings, isCollapsed, onToggleCollapsed } = props;
  const navigate = useNavigate();
  const location = useLocation();

  const initials = (displayName || 'N').slice(0, 2).toUpperCase();

  const items: SidebarItem[] = [
    { label: 'Calendar', route: '/calendar', icon: <CalendarIcon /> },
    { label: 'Meals & Grocery', route: '/meals', icon: <MealsIcon /> },
    { label: 'Workouts', route: '/workouts', icon: <WorkoutsIcon /> },
    { label: 'Stress & Breaks', route: '/stress', icon: <StressIcon />, disabled: true },
    { label: 'Overview', route: '/overview', icon: <OverviewIcon />, disabled: true },
  ];

  return (
    <aside
      className={`df-calendarLeftNav${isCollapsed ? ' df-calendarLeftNavCollapsed' : ''}`}
      aria-label="Primary navigation"
    >
      <button
        type="button"
        className="df-sidebarToggle"
        onClick={onToggleCollapsed}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!isCollapsed}
        title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <span className="df-sidebarToggleIcon" aria-hidden>
          <HamburgerIcon />
        </span>
      </button>

      <div className="df-calendarBrand">
        <span className="df-calendarBrandLogoWrap" aria-hidden>
          <img
            src={dailyflowLogoUrl}
            alt=""
            className="df-calendarBrandLogo"
          />
        </span>
        <span className="df-calendarBrandLabel">DailyFlow</span>
      </div>

      <div className="df-calendarProfile">
        <div className="df-calendarProfileAvatar">
          {profileImageUrl ? (
            <img
              key={profileImageUrl}
              src={profileImageUrl}
              alt=""
              className="df-calendarProfileAvatarImg"
            />
          ) : (
            initials
          )}
        </div>
        <div className="df-calendarProfileInfo">
          <div className="df-calendarProfileName">{displayName}</div>
          <div className="df-calendarProfileHint">Plan your week</div>
        </div>
        <button
          type="button"
          className="df-iconBtn df-calendarProfileSettings"
          onClick={onOpenSettings}
          aria-label="Open profile settings"
          title="Settings"
        >
          <SettingsIcon />
        </button>
      </div>

      <nav className="df-calendarMenu" aria-label="Main sections">
        {items.map((item) => {
          const isActive = location.pathname.startsWith(item.route);
          return (
            <button
              key={item.route}
              type="button"
              className={`df-calendarMenuItem${isActive ? ' df-calendarMenuItemActive' : ''}`}
              onClick={() => {
                if (item.disabled) return;
                navigate(item.route);
              }}
              disabled={item.disabled}
              title={isCollapsed ? item.label : undefined}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="df-calendarMenuItemIcon" aria-hidden>
                {item.icon}
              </span>
              <span className="df-calendarMenuItemLabel">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// --- Inline SVG icons (24x24, currentColor) ---------------------------------

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  );
}

function MealsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="7.5" cy="6.5" rx="2.5" ry="3" />
      <line x1="7.5" y1="9.5" x2="7.5" y2="20" />
      <line x1="14" y1="4" x2="14" y2="8" />
      <line x1="16.5" y1="4" x2="16.5" y2="8" />
      <line x1="19" y1="4" x2="19" y2="8" />
      <path d="M14 8h5v2a2.5 2.5 0 0 1-2.5 2.5L16.5 20" />
    </svg>
  );
}

function WorkoutsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="9" width="3" height="6" rx="1" />
      <rect x="18.5" y="9" width="3" height="6" rx="1" />
      <rect x="5.5" y="7" width="3" height="10" rx="1.2" />
      <rect x="15.5" y="7" width="3" height="10" rx="1.2" />
      <line x1="8.5" y1="12" x2="15.5" y2="12" />
    </svg>
  );
}

function StressIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3c2.5 2.2 4 4.5 4 7a4 4 0 1 1-8 0c0-2.5 1.5-4.8 4-7z" />
      <path d="M9 17c.6.9 1.7 1.5 3 1.5s2.4-.6 3-1.5" />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="13" width="3.5" height="7.5" rx="1" />
      <rect x="10.25" y="8.5" width="3.5" height="12" rx="1" />
      <rect x="17" y="4" width="3.5" height="16.5" rx="1" />
    </svg>
  );
}

// --- Exported small icons used by other screens -----------------------------

export function ClockIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 14;
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
      className={props.className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

export function HeartIcon(props: {
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  const size = props.size ?? 18;
  const filled = props.filled === true;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
    </svg>
  );
}

export function FireIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 14;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden
    >
      <path d="M12 3c.6 2.3 2 3.6 3.4 5 1.6 1.6 2.6 3.4 2.6 5.5a6 6 0 0 1-12 0c0-1.3.4-2.5 1.2-3.6.5.9 1.3 1.4 2.2 1.4-.2-2 .6-4.4 2.6-8.3z" />
      <path d="M12 14.5c.4.9 1 1.4 1.8 1.6-.3.9-1 1.4-1.8 1.4s-1.5-.5-1.8-1.4c.8-.2 1.4-.7 1.8-1.6z" />
    </svg>
  );
}

export function CalendarPlusIcon(props: { size?: number; className?: string }) {
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
      className={props.className}
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
      <line x1="12" y1="13" x2="12" y2="18" />
      <line x1="9.5" y1="15.5" x2="14.5" y2="15.5" />
    </svg>
  );
}
