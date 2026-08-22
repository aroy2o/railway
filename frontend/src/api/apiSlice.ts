/**
 * The single HTTP client for the Express API, as an RTK Query slice.
 *
 * Every call to the backend is declared here as an endpoint rather than being
 * a `fetch` scattered through a component (CLAUDE.md frontend convention).
 * RTK Query then owns caching, request de-duplication, and the loading/error
 * state each component would otherwise hand-roll.
 *
 * Endpoints arrive with the tasks that need them:
 *   tasks / corridors / assets CRUD        task T10-T11 (FR1)
 *   generateSchedule, getSchedule          task T13     (FR3)
 *   baseline comparison                    task T14     (FR9)
 */
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import { API_BASE_URL } from '../config.ts'
import type { RootState } from '../store/store.ts'

/* -------------------------------------------------------------------------- */
/* Response types                                                              */
/* -------------------------------------------------------------------------- */

export interface DatabaseCheck {
  connected: boolean
  state: string
}

export interface OptimizerCheck {
  reachable: boolean
  ready: boolean
  /** False when the service answers but OR-Tools CP-SAT is not usable. */
  solverAvailable: boolean
  url: string
  error?: string
}

export interface DependencyHealth {
  status: 'ok' | 'degraded'
  checks: { database: DatabaseCheck; optimizer: OptimizerCheck }
  timestamp: string
}

/** The error envelope every Express route returns. */
export interface ApiErrorEnvelope {
  error: { code: string; message: string; details?: unknown }
}

/* -------------------------------------------------------------------------- */
/* API slice                                                                   */
/* -------------------------------------------------------------------------- */

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: API_BASE_URL,
    // Read the token straight from the store so no component ever has to
    // remember to pass it, and a logout instantly applies to every request.
    prepareHeaders: (headers, { getState }) => {
      const token = (getState() as RootState).auth.token
      if (token) headers.set('authorization', `Bearer ${token}`)
      return headers
    },
    // A hung solver must not hold a request open indefinitely. The optimizer's
    // own budget is SOLVER_MAX_SECONDS; this is the browser-side backstop.
    timeout: 30_000,
  }),
  // Cache invalidation tags, extended as CRUD endpoints are added (T10-T11).
  tagTypes: ['Health', 'Task', 'Corridor', 'Asset', 'Schedule'],
  endpoints: (builder) => ({
    /**
     * Cross-service wiring probe: React -> Express -> MongoDB + Python
     * optimizer. Backs the status panel on the landing screen so a broken link
     * in the chain is visible immediately rather than surfacing later as a
     * confusing failure.
     */
    getDependencyHealth: builder.query<DependencyHealth, void>({
      query: () => '/health/dependencies',
      providesTags: ['Health'],
    }),
  }),
})

export const { useGetDependencyHealthQuery } = api

/**
 * Narrow an RTK Query error into a message safe to show a user.
 * RTK Query errors are a union of transport failures and API envelopes, so
 * components should not be reaching into that shape themselves.
 */
export function describeApiError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'Unknown error'

  const candidate = error as { status?: number | string; error?: string; data?: unknown }

  if (candidate.status === 'FETCH_ERROR') {
    return 'Could not reach the API. Is the backend running?'
  }
  if (candidate.status === 'TIMEOUT_ERROR') {
    return 'The API did not respond in time.'
  }

  const envelope = candidate.data as Partial<ApiErrorEnvelope> | undefined
  if (envelope?.error?.message) return envelope.error.message

  return typeof candidate.status === 'number'
    ? `Request failed (${candidate.status})`
    : 'Request failed'
}
