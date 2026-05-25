/** Shared copy of backend/user-facing Google Calendar connection messages. */
export const GOOGLE_RECONNECT_MESSAGE = 'Google connection expired, reconnect required';
export const GOOGLE_RECONNECT_MESSAGE_NEW =
  'Google Calendar connection expired. Please reconnect.';

export type GoogleConnectionPayload = {
  message?: string;
  reconnect_required?: boolean;
};

/**
 * True when the API response indicates missing/expired Google Calendar
 * connection and the user should connect/reconnect — not a generic app error.
 */
export function isGoogleCalendarReconnectOrMissing(
  payload: GoogleConnectionPayload | null | undefined,
  httpStatus: number
): boolean {
  if (payload?.reconnect_required === true) return true;

  const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (message === GOOGLE_RECONNECT_MESSAGE || message === GOOGLE_RECONNECT_MESSAGE_NEW) {
    return true;
  }
  if (/google connection expired/i.test(message) || /reconnect required/i.test(message)) {
    return true;
  }
  if (/google calendar is not connected/i.test(message)) {
    return true;
  }
  if (/session expired/i.test(message) && /reconnect/i.test(message)) {
    return true;
  }

  const apiFail = message.match(/^Google Calendar API request failed with status (\d+)\.?$/i);
  if (apiFail) {
    const googleStatus = Number.parseInt(apiFail[1], 10);
    if ([400, 401, 403].includes(googleStatus)) return true;
  }

  if (httpStatus === 404 && /not connected/i.test(message)) return true;
  if (!message && httpStatus === 404) return true;

  return false;
}

/** User-facing text for the Calendars panel / reconnect banner (never raw API status lines). */
export function googleCalendarReconnectDisplayMessage(
  payload: GoogleConnectionPayload | null | undefined
): string {
  const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (
    message &&
    message !== GOOGLE_RECONNECT_MESSAGE &&
    !/^Google Calendar API request failed with status \d+/i.test(message)
  ) {
    return message;
  }
  return GOOGLE_RECONNECT_MESSAGE_NEW;
}
