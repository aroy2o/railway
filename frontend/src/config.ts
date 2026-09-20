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
 * degrades to accurate wording for this branch's data source rather than
 * disappearing from the UI.
 *
 * fulldata-ktv-psa branch: the fallback below differs from PRD Section 5's
 * own wording because this branch's real-data source differs from PRD
 * Section 5.1's named sources (datameet/railways, data.gov.in) - it is real
 * KTV-PSA corridor infrastructure/freight/passenger data from the full_data
 * release package instead, scoped to one corridor rather than the national
 * network. See the branch plan / docs/DECISIONS.md for why. The maintenance
 * task/defect layer is still DGP-simulated, same honesty requirement as
 * before, just a different real anchor underneath it.
 */
export const PROTOTYPE_BANNER =
  import.meta.env.VITE_PROTOTYPE_BANNER ??
  'Prototype uses DGP-simulated maintenance data anchored to real KTV–PSA corridor ' +
    'infrastructure, freight and passenger traffic data (single-corridor scope, not the ' +
    'national datameet/data.gov.in dataset).'
