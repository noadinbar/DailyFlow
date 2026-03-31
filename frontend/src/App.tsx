import React from 'react';
import AuthScreen from './components/Auth/AuthScreen';
import OnboardingQuestionnaireWizard from './components/OnboardingQuestionnaireWizard/OnboardingQuestionnaireWizard';
import HomePlaceholder from './components/Home/HomePlaceholder';
import QuestionnaireSavedPlaceholder from './components/Questionnaire/QuestionnaireSavedPlaceholder';
import { fetchOnboardingCompleted, signOutCurrentUser } from './services/auth/cognitoPlaceholders';
import { fetchAuthSession } from 'aws-amplify/auth';

type Screen = 'auth' | 'questionnaire' | 'questionnaireSaved' | 'home';

type AuthUser = {
  username: string;
  email?: string;
};

type AuthState = {
  isAuthenticated: boolean;
  user?: AuthUser;
};

export default function App() {
  const [screen, setScreen] = React.useState<Screen>('auth');
  const [isCheckingOnboarding, setIsCheckingOnboarding] = React.useState<boolean>(false);
  const [authState, setAuthState] = React.useState<AuthState>({
    isAuthenticated: false,
    user: undefined,
  });

  function handleSignedUp(user: { username: string; email: string }) {
    // Sign up does not imply an authenticated session yet (no email confirmation flow here).
    setAuthState({ isAuthenticated: false, user });
    setScreen('questionnaire');
  }

  async function handleLoggedIn(user: { username: string }) {
    setIsCheckingOnboarding(true);
    try {
      // Extra safety: only navigate after we can actually read an authenticated session.
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) throw new Error('Missing authenticated session token.');

      const completed = await fetchOnboardingCompleted();
      setAuthState({ isAuthenticated: true, user });
      setScreen(completed ? 'home' : 'questionnaire');
    } catch (e) {
      // If onboarding flag can't be read or session is missing, do not allow forward navigation.
      // eslint-disable-next-line no-console
      console.error(e);
      setAuthState({ isAuthenticated: false, user: undefined });
      setScreen('auth');
    } finally {
      setIsCheckingOnboarding(false);
    }
  }

  async function handleLogout() {
    await signOutCurrentUser();
    setAuthState({ isAuthenticated: false, user: undefined });
    setScreen('auth');
  }

  return (
    <main className="df-page">
      {isCheckingOnboarding && (
        <section className="df-card" aria-label="Checking onboarding status">
          <h1 className="df-title" style={{ textAlign: 'center' }}>
            Loading...
          </h1>
        </section>
      )}

      {screen === 'auth' && (
        <AuthScreen
          onSignedUp={(user) => handleSignedUp(user)}
          onLoggedIn={(user) => handleLoggedIn(user)}
        />
      )}

      {screen === 'questionnaire' && (
        <OnboardingQuestionnaireWizard
          onUnauthorized={() => {
            setAuthState({ isAuthenticated: false, user: undefined });
            setScreen('auth');
          }}
          onSubmittedSuccess={() => {
            // Post-questionnaire success navigates to the current placeholder/main.
            setScreen('home');
          }}
        />
      )}

      {screen === 'questionnaireSaved' && <QuestionnaireSavedPlaceholder />}

      {screen === 'home' && (
        <HomePlaceholder username={authState.user?.username} onLogout={() => handleLogout()} />
      )}
    </main>
  );
}

