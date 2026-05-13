import React, { useMemo, useState } from 'react';
import { submitLoginPlaceholder, submitSignUpPlaceholder } from '../../services/auth/cognitoPlaceholders';
import logoUrl from '../../../visuals/logo-rectangle.png';

type AuthMode = 'login' | 'signup';

type LoginPayload = {
  username: string;
  password: string;
};

type SignUpPayload = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
};

type Errors = Partial<
  Record<'username' | 'password' | 'email' | 'confirmPassword' | 'form', string>
>;

type AuthScreenProps = {
  // Called after Cognito sign up succeeds (account created).
  onSignedUp?: (user: { username: string; email: string }) => void;
  // Called after Cognito log in succeeds.
  onLoggedIn?: (user: { username: string }) => void;
};

function fieldError(errors: Errors, key: keyof Errors) {
  return errors[key] ? <div className="df-errorText">{errors[key]}</div> : null;
}

export default function AuthScreen(props: AuthScreenProps) {
  const { onSignedUp, onLoggedIn } = props;

  const [mode, setMode] = useState<AuthMode>('login');

  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');

  const [email, setEmail] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');

  const [errors, setErrors] = useState<Errors>({});
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const title = useMemo(
    () => (mode === 'login' ? 'Welcome back' : 'Create your account'),
    [mode]
  );

  function validate(): Errors {
    const next: Errors = {};

    if (username.trim() === '') next.username = 'Username is required.';
    if (mode === 'login') {
      if (password.trim() === '') next.password = 'Password is required.';
    }

    if (mode === 'signup') {
      if (password.trim() === '') next.password = 'Password is required.';
      if (confirmPassword.trim() === '') next.confirmPassword = 'Confirm password is required.';
      if (email.trim() === '') next.email = 'Email is required.';

      if (
        password.trim() !== '' &&
        confirmPassword.trim() !== '' &&
        password !== confirmPassword
      ) {
        next.confirmPassword = 'Passwords do not match.';
      }
    }

    return next;
  }

  async function handleSubmit() {
    const nextErrors = validate();
    setErrors(nextErrors);
    setSuccessMessage('');
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      if (mode === 'login') {
        const payload: LoginPayload = { username, password };
        await submitLoginPlaceholder(payload);
        setSuccessMessage('Log in successful.');
        onLoggedIn?.({ username });
      } else {
        const payload: SignUpPayload = { username, email, password, confirmPassword };
        const result = await submitSignUpPlaceholder(payload);

        // If Cognito reports the sign-up as fully complete (no confirmation /
        // admin approval required), immediately sign in with the same
        // credentials so the user is routed through the existing post-login
        // flow (App.handleLoggedIn → fetchOnboardingCompleted → questionnaire
        // or /calendar). This avoids forcing the user to retype the
        // credentials they just submitted.
        if (!result.confirmationRequired) {
          try {
            await submitLoginPlaceholder({ username, password });
            setSuccessMessage('Account created. Signing you in...');
            onLoggedIn?.({ username });
            return;
          } catch (autoSignInErr) {
            // Auto sign-in failed (e.g. the user pool actually requires
            // confirmation after all, or sign-in hit an unrelated error).
            // Fall back to the manual log-in flow with a clear message so the
            // user can recover instead of being stuck on a successful signup
            // with no path forward.
            const fallbackMessage =
              (autoSignInErr as any)?.message &&
              typeof (autoSignInErr as any).message === 'string'
                ? `Account created. ${(autoSignInErr as any).message}`
                : 'Account created. Please log in to continue.';
            setSuccessMessage(fallbackMessage);
            setMode('login');
            setErrors({});
            return;
          }
        }

        // Confirmation is required (manual admin approval in the current
        // Cognito setup). Don't try to auto-sign-in — Amplify will reject
        // sign-in until the account is confirmed. Keep the existing flow:
        // show the waiting-for-approval message and switch back to Log in.
        setSuccessMessage(
          'Account created. Waiting for admin approval. Please log in after approval.'
        );
        setMode('login');
        setErrors({});
      }
    } catch (e) {
      setErrors({ form: 'Something went wrong. Please try again.' });
      const anyErr = e as any;
      if (anyErr && typeof anyErr.message === 'string') {
        setErrors({ form: anyErr.message });
      }
      // Keep placeholder flow: no error normalization yet.
      // eslint-disable-next-line no-console
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="df-authWrap" aria-label="Authentication screen">
      <div className="df-card df-authCard">
        <div className="df-authHeader">
          <img
            src={logoUrl}
            className="df-authLogo"
            alt="DailyFlow logo"
          />
          <h1 className="df-authTitle">{title}</h1>

          <div className="df-authToggle" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              className={`df-authToggleBtn ${mode === 'login' ? 'df-authToggleBtnActive' : ''}`}
              onClick={() => {
                setMode('login');
                setErrors({});
                setSuccessMessage('');
              }}
              role="tab"
              aria-selected={mode === 'login'}
            >
              Log in
            </button>
            <button
              type="button"
              className={`df-authToggleBtn ${mode === 'signup' ? 'df-authToggleBtnActive' : ''}`}
              onClick={() => {
                setMode('signup');
                setErrors({});
                setSuccessMessage('');
              }}
              role="tab"
              aria-selected={mode === 'signup'}
            >
              Sign up
            </button>
          </div>
        </div>

        <form
          className="df-authForm"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          {successMessage && <div className="df-successText">{successMessage}</div>}
          {errors.form && <div className="df-errorText">{errors.form}</div>}

          <div className="df-field">
            <label>
              <div className="df-fieldLabel">Username</div>
              <input
                className="df-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="Your username"
              />
            </label>
            {fieldError(errors, 'username')}
          </div>

          {mode === 'login' && (
            <div className="df-field">
              <label>
                <div className="df-fieldLabel">Password</div>
                <input
                  className="df-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Your password"
                />
              </label>
              {fieldError(errors, 'password')}
            </div>
          )}

          {mode === 'signup' && (
            <>
              <div className="df-field">
                <label>
                  <div className="df-fieldLabel">Email</div>
                  <input
                    className="df-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </label>
                {fieldError(errors, 'email')}
              </div>

              <div className="df-field">
                <label>
                  <div className="df-fieldLabel">Password</div>
                  <input
                    className="df-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="Create a password"
                  />
                </label>
                {fieldError(errors, 'password')}
              </div>

              <div className="df-field">
                <label>
                  <div className="df-fieldLabel">Confirm password</div>
                  <input
                    className="df-input"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="Confirm your password"
                  />
                </label>
                {fieldError(errors, 'confirmPassword')}
              </div>
            </>
          )}

          <button className="df-btn df-btnPrimary df-authSubmit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Please wait...' : mode === 'login' ? 'Log in' : 'Sign up'}
          </button>
        </form>
      </div>
    </section>
  );
}

