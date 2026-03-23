import { configureAmplify } from './amplifyConfig';
import { signIn, signUp } from 'aws-amplify/auth';

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

function toAmplifyErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;

  const anyErr = err as any;
  if (anyErr && typeof anyErr === 'object') {
    if (typeof anyErr.message === 'string') return anyErr.message;
    if (anyErr.error && typeof anyErr.error?.message === 'string') return anyErr.error.message;
    if (typeof anyErr.toString === 'function') return anyErr.toString();
  }

  return 'Request failed. Please try again.';
}

export async function submitLoginPlaceholder(payload: LoginPayload): Promise<void> {
  configureAmplify();
  try {
    await signIn({ username: payload.username, password: payload.password });
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

