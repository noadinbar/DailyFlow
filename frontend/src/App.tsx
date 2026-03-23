import React from 'react';
import AuthScreen from './components/Auth/AuthScreen';
import OnboardingQuestionnaireWizard from './components/OnboardingQuestionnaireWizard/OnboardingQuestionnaireWizard';
import HomePlaceholder from './components/Home/HomePlaceholder';

type Screen = 'auth' | 'questionnaire' | 'home';

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
  const [authState, setAuthState] = React.useState<AuthState>({
    isAuthenticated: false,
    user: undefined,
  });

  function handleSignedUp(user: { username: string; email: string }) {
    // Sign up does not imply an authenticated session yet (no email confirmation flow here).
    setAuthState({ isAuthenticated: false, user });
    setScreen('questionnaire');
  }

  function handleLoggedIn(user: { username: string }) {
    setAuthState({ isAuthenticated: true, user });
    setScreen('home');
  }

  return (
    <main className="df-page">
      {screen === 'auth' && (
        <AuthScreen
          onSignedUp={(user) => handleSignedUp(user)}
          onLoggedIn={(user) => handleLoggedIn(user)}
        />
      )}

      {screen === 'questionnaire' && <OnboardingQuestionnaireWizard />}

      {screen === 'home' && <HomePlaceholder username={authState.user?.username} />}
    </main>
  );
}

