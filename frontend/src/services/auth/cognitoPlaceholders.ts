import { configureAmplify } from './amplifyConfig';
import {
  fetchUserAttributes,
  signIn,
  signOut,
  signUp,
  updateUserAttributes,
} from 'aws-amplify/auth';
import { fetchAuthSession } from 'aws-amplify/auth';

export type LoginPayload = {
  username: string;
  password: string;
};

export type SignUpPayload = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
};

export type SignUpResult = {
  confirmationRequired: boolean;
};

const ONBOARDING_COMPLETED_ATTRIBUTE = 'custom:onboardingCompleted';

function toAmplifyErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;

  const anyErr = err as any;
  if (anyErr && typeof anyErr === 'object') {
    const message =
      (typeof anyErr.message === 'string' && anyErr.message) ||
      (anyErr.error && typeof anyErr.error?.message === 'string' && anyErr.error.message) ||
      (typeof anyErr.toString === 'function' && anyErr.toString());

    if (typeof message === 'string') {
      const normalized = message.toLowerCase();

      // Common Cognito messages when the user exists but isn't confirmed/approved yet.
      if (
        normalized.includes('usernotconfirmed') ||
        normalized.includes('not confirmed') ||
        (normalized.includes('notauthorized') && normalized.includes('not confirmed'))
      ) {
        return 'Your account is created but is waiting for admin approval. Please try again after approval.';
      }

      return message;
    }

    // Fallback if message isn't a string.
    if (typeof anyErr.toString === 'function') return anyErr.toString();
    if (typeof anyErr.toString === 'function') return anyErr.toString();
  }

  return 'Request failed. Please try again.';
}

export async function submitLoginPlaceholder(payload: LoginPayload): Promise<void> {
  configureAmplify();
  try {
    console.debug('[DailyFlow][Auth] Checking existing local session before signIn');
    const preSession = await fetchAuthSession();
    const hasExistingTokens = Boolean(
      preSession?.tokens?.accessToken || preSession?.tokens?.idToken
    );
    console.debug('[DailyFlow][Auth] Existing session tokens?', { hasExistingTokens });

    if (hasExistingTokens) {
      try {
        console.debug('[DailyFlow][Auth] Signing out existing session before signIn');
        await signOut();
        console.debug('[DailyFlow][Auth] Existing session signed out successfully');
      } catch (e) {
        // Don't block login; still try signIn, but log the issue.
        console.warn('[DailyFlow][Auth] signOut before signIn failed; continuing', e);
      }
    }

    let result;
    try {
      console.debug('[DailyFlow][Auth] Attempting signIn', { username: payload.username });
      result = await signIn({ username: payload.username, password: payload.password });
    } catch (err) {
      const msg = toAmplifyErrorMessage(err).toLowerCase();
      console.warn('[DailyFlow][Auth] signIn threw error', { msg });

      // If we hit "already authenticated/already signed in", attempt a clean sign-out and retry once.
      if (
        msg.includes('already authenticated') ||
        msg.includes('already signed in') ||
        msg.includes('useralreadyauthenticatedexception')
      ) {
        try {
          console.debug('[DailyFlow][Auth] Retrying signIn after signOut due to existing session');
          await signOut();
          result = await signIn({ username: payload.username, password: payload.password });
        } catch (retryErr) {
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    // Amplify can resolve without throwing in some challenge/confirmation scenarios.
    // Treat anything other than a fully signed-in session as a login failure.
    const signedIn = (result as any)?.isSignedIn === true;
    if (!signedIn) {
      const nextStep = (result as any)?.nextStep;
      const signInStep = nextStep?.signInStep;
      if (signInStep === 'CONFIRM_SIGN_UP') {
        throw new Error(
          'Your account is created but is waiting for admin approval. Please try again after approval.'
        );
      }

      throw new Error('Log in failed. Please check your credentials and try again.');
    }

    const session = await fetchAuthSession();
    const accessToken = session.tokens?.accessToken?.toString();
    const idToken = session.tokens?.idToken?.toString();
    const token = accessToken || idToken;
    if (!token) {
      throw new Error('Log in failed. Missing authenticated session token.');
    }
  } catch (err) {
    throw new Error(toAmplifyErrorMessage(err));
  }
}

export async function submitSignUpPlaceholder(payload: SignUpPayload): Promise<SignUpResult> {
  configureAmplify();
  try {
    const result = await signUp({
      username: payload.username,
      password: payload.password,
      options: {
        userAttributes: {
          email: payload.email,
          // Cognito schema may require a plain `name` attribute.
          // We map it to the existing UI username for now.
          name: payload.username,
        },
      },
    });

    const signUpComplete = Boolean((result as any)?.isSignUpComplete);
    const confirmationRequired = signUpComplete === false;
    return { confirmationRequired };
  } catch (err) {
    throw new Error(toAmplifyErrorMessage(err));
  }
}

export async function fetchOnboardingCompleted(): Promise<boolean> {
  configureAmplify();
  try {
    const attrs = await fetchUserAttributes();
    const value = (attrs as any)?.[ONBOARDING_COMPLETED_ATTRIBUTE];
    return value === 'true';
  } catch (err) {
    throw new Error(toAmplifyErrorMessage(err));
  }
}

export async function setOnboardingCompletedTrue(): Promise<void> {
  configureAmplify();
  try {
    await updateUserAttributes({
      userAttributes: {
        [ONBOARDING_COMPLETED_ATTRIBUTE]: 'true',
      } as any,
    });
  } catch (err) {
    throw new Error(toAmplifyErrorMessage(err));
  }
}

export async function signOutCurrentUser(): Promise<void> {
  configureAmplify();
  try {
    await signOut();
  } catch (err) {
    throw new Error(toAmplifyErrorMessage(err));
  }
}

