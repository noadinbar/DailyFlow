import { Amplify } from 'aws-amplify';

let isConfigured = false;

export function configureAmplify() {
  if (isConfigured) return;

  const region = import.meta.env.VITE_AWS_REGION as string | undefined;
  const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined;
  const userPoolClientId = import.meta.env.VITE_COGNITO_APP_CLIENT_ID as string | undefined;

  if (!region || !userPoolId || !userPoolClientId) {
    throw new Error(
      'Missing Cognito configuration. Please set VITE_AWS_REGION, VITE_COGNITO_USER_POOL_ID, and VITE_COGNITO_APP_CLIENT_ID in frontend/.env'
    );
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
      },
    },
  });

  isConfigured = true;
}

