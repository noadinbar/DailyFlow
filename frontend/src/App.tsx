import React from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import AuthScreen from './components/Auth/AuthScreen';
import OnboardingQuestionnaireWizard from './components/OnboardingQuestionnaireWizard/OnboardingQuestionnaireWizard';
import HomePlaceholder from './components/Home/HomePlaceholder';
import QuestionnaireSavedPlaceholder from './components/Questionnaire/QuestionnaireSavedPlaceholder';
import { fetchOnboardingCompleted, signOutCurrentUser } from './services/auth/cognitoPlaceholders';
import { configureAmplify } from './services/auth/amplifyConfig';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';

type Screen = 'auth' | 'questionnaire' | 'questionnaireSaved' | 'home';

type AuthUser = {
  username: string;
  email?: string;
};

type AuthState = {
  isAuthenticated: boolean;
  user?: AuthUser;
};

function normalizePathname(pathname: string): string {
  if (!pathname) return '/';
  const normalized = pathname.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function shouldStartHydratingCalendar(): boolean {
  if (typeof window === 'undefined') return false;
  return normalizePathname(window.location.pathname) === '/calendar';
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [screen, setScreen] = React.useState<Screen>('auth');
  const [isCheckingOnboarding, setIsCheckingOnboarding] = React.useState<boolean>(false);
  const [isHydratingCalendarRoute, setIsHydratingCalendarRoute] = React.useState<boolean>(() =>
    shouldStartHydratingCalendar()
  );
  const [authState, setAuthState] = React.useState<AuthState>({
    isAuthenticated: false,
    user: undefined,
  });

  React.useEffect(() => {
    if (normalizePathname(location.pathname) !== '/calendar') {
      setIsHydratingCalendarRoute(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        configureAmplify();
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        const idToken = session.tokens?.idToken?.toString();
        const token = accessToken || idToken;
        if (!token) {
          if (!cancelled) {
            navigate('/', { replace: true });
            setIsHydratingCalendarRoute(false);
          }
          return;
        }

        const completed = await fetchOnboardingCompleted();
        const currentUser = await getCurrentUser();

        if (!completed) {
          if (!cancelled) {
            setAuthState({
              isAuthenticated: true,
              user: { username: currentUser.username },
            });
            setScreen('questionnaire');
            navigate('/', { replace: true });
            setIsHydratingCalendarRoute(false);
          }
          return;
        }

        if (!cancelled) {
          setAuthState({
            isAuthenticated: true,
            user: { username: currentUser.username },
          });
          setScreen('home');
          setIsHydratingCalendarRoute(false);
        }
      } catch (e) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error(e);
          navigate('/', { replace: true });
          setIsHydratingCalendarRoute(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [location.pathname, navigate]);

  React.useEffect(() => {
    if (screen === 'home' && authState.isAuthenticated && location.pathname !== '/calendar') {
      navigate('/calendar', { replace: true });
    }
  }, [screen, authState.isAuthenticated, location.pathname, navigate]);

  function handleSignedUp(user: { username: string; email: string }) {
    setAuthState({ isAuthenticated: false, user });
    setScreen('questionnaire');
    if (location.pathname !== '/') navigate('/', { replace: true });
  }

  async function handleLoggedIn(user: { username: string }) {
    setIsCheckingOnboarding(true);
    try {
      configureAmplify();
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) throw new Error('Missing authenticated session token.');

      const completed = await fetchOnboardingCompleted();
      setAuthState({ isAuthenticated: true, user });
      if (completed) {
        setScreen('home');
        navigate('/calendar', { replace: true });
      } else {
        setScreen('questionnaire');
        if (location.pathname !== '/') navigate('/', { replace: true });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      setAuthState({ isAuthenticated: false, user: undefined });
      setScreen('auth');
      navigate('/', { replace: true });
    } finally {
      setIsCheckingOnboarding(false);
    }
  }

  async function handleLogout() {
    await signOutCurrentUser();
    setAuthState({ isAuthenticated: false, user: undefined });
    setScreen('auth');
    navigate('/', { replace: true });
  }

  const showBlockingLoader = isCheckingOnboarding || isHydratingCalendarRoute;

  return (
    <main className="df-page" style={{ position: 'relative' }}>
      {/* Keep Routes mounted during login/calendar hydration so navigate() updates the URL reliably. */}
      <Routes>
      <Route
        path="/calendar/*"
        element={
          isHydratingCalendarRoute ? (
            <></>
          ) : screen === 'home' && authState.isAuthenticated ? (
            <HomePlaceholder username={authState.user?.username} onLogout={() => handleLogout()} />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
        <Route
          path="*"
          element={
            <>
              {screen === 'auth' && (
                <AuthScreen
                  onSignedUp={(user) => handleSignedUp(user)}
                  onLoggedIn={(user) => void handleLoggedIn(user)}
                />
              )}

              {screen === 'questionnaire' && (
                <OnboardingQuestionnaireWizard
                  onUnauthorized={() => {
                    setAuthState({ isAuthenticated: false, user: undefined });
                    setScreen('auth');
                    navigate('/', { replace: true });
                  }}
                  onSubmittedSuccess={() => {
                    setScreen('home');
                    navigate('/calendar', { replace: true });
                  }}
                />
              )}

              {screen === 'questionnaireSaved' && <QuestionnaireSavedPlaceholder />}
            </>
          }
        />
      </Routes>

      {showBlockingLoader && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(247, 247, 248, 0.92)',
          }}
          role="status"
          aria-live="polite"
          aria-label="Loading"
        >
          <section className="df-card">
            <h1 className="df-title" style={{ textAlign: 'center' }}>
              Loading...
            </h1>
          </section>
        </div>
      )}
    </main>
  );
}
