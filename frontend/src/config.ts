/**
 * Browser-side configuration.
 *
 * Only VITE_-prefixed variables reach the bundle and they are inlined at build
 * time, so nothing secret belongs here. Defaults exist so the app still renders
 * correctly when a variable is missing from the environment.
 */

/** Base URL of the Express API, without a trailing slash. */
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000/api'
).replace(/\/+$/, '')

/**
 * PRD Section 5 requires this disclaimer to be visible in the running app so a
 * judge is never unclear about which data is real and which is simulated.
 * The fallback is intentional: if the env var is ever dropped the banner
 * degrades to the PRD's own wording rather than disappearing from the UI.
 */
export const PROTOTYPE_BANNER =
  import.meta.env.VITE_PROTOTYPE_BANNER ??
  'Prototype uses synthetic maintenance data anchored to real railway infrastructure and timetable data.'
