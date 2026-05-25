/**
 * Resolves the API Gateway base URL from Vite env at build time.
 * Must be absolute so fetch never targets the Amplify SPA host by mistake.
 */
export function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;
  const cleaned = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!cleaned) {
    throw new Error('Missing API base URL (VITE_API_BASE_URL).');
  }
  if (!/^https?:\/\//i.test(cleaned)) {
    throw new Error(
      'VITE_API_BASE_URL must be an absolute URL (for example https://your-api.execute-api.region.amazonaws.com).'
    );
  }
  return cleaned;
}

/** Builds a fully qualified API URL: `{base}{path}`. */
export function buildApiUrl(path: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
