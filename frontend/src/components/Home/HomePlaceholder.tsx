import React from 'react';

type HomePlaceholderProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

export default function HomePlaceholder(props: HomePlaceholderProps) {
  const { username, onLogout } = props;
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const [isLoggingOut, setIsLoggingOut] = React.useState<boolean>(false);

  async function handleLogoutClick() {
    setErrorMessage('');
    setIsLoggingOut(true);
    try {
      if (onLogout) await onLogout();
    } catch (e) {
      const anyErr = e as any;
      const message =
        anyErr && typeof anyErr.message === 'string'
          ? anyErr.message
          : 'Failed to sign out. Please try again.';
      setErrorMessage(message);
      // eslint-disable-next-line no-console
      console.error(e);
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <section className="df-card" aria-label="Home placeholder">
      <h1 className="df-title" style={{ textAlign: 'center' }}>
        Logged in successfully
      </h1>
      {username && (
        <p className="df-subtitle" style={{ textAlign: 'center' }}>
          Welcome, {username}
        </p>
      )}

      {errorMessage && <div className="df-errorText">{errorMessage}</div>}

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
        <button className="df-btn" onClick={() => void handleLogoutClick()} disabled={isLoggingOut}>
          {isLoggingOut ? 'Signing out...' : 'Sign out'}
        </button>
      </div>
    </section>
  );
}

