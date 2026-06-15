/** True when the SPA is being asked to render the OAuth consent screen. */
export const isConsentRoute = (): boolean => {
  return window.location.pathname.replace(/\/$/, '').endsWith('/oauth/consent');
};
