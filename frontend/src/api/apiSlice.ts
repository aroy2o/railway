/**
 * The single HTTP client for the Express API, as an RTK Query slice.
 *
 * Every call to the backend is declared here as an endpoint rather than being
 * a `fetch` scattered through a component (CLAUDE.md frontend convention).
 * RTK Query then owns caching, request de-duplication, and the loading/error
 * state each component would otherwise hand-roll.
 *
 * Read endpoints for the pipeline output are here now. Still to come:
 *   task submission + auth                 rest of T10  (FR1, FR10)
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

/** Every list endpoint answers in this shape. */
export interface ListResponse<T> {
  data: T[]
  pagination: {
    total: number
    limit: number
    offset: number
    returned: number
    hasMore: boolean
  }
}

export interface Station {
  code: string
  name: string
  zone: string | null
  state: string | null
  lat: number | null
  lon: number | null
}

export interface OccupancySummary {
  trainsObserved: number
  occupiedMinutes: number
  freeMinutes: number
  utilisationPct: number
  blockWindowCount: number
  lowConfidence: boolean
}

export interface BlockWindow {
  start: string
  end: string
  startMin: number
  endMin: number
  durationMin: number
}

/** A real corridor section (T2) plus its denormalised occupancy summary (T3). */
export interface Corridor {
  _id: string
  name: string
  zone: string | null
  section: string
  stationA: Station
  stationB: Station
  states: string[]
  trainTraversals: number
  distinctTrains: number
  publishedDistanceKm: number | null
  straightLineKm: number | null
  derivedFlags: { longHop: boolean }
  sources: string[]
  hasSyntheticDemand: boolean
  occupancySummary: OccupancySummary
}

export interface CorridorDetail extends Corridor {
  /** Joined from corridor_calendar on read - see docs/DECISIONS.md D-016. */
  maxDailyBlockWindows: BlockWindow[]
  occupancy: {
    trainsObserved: number
    trainClassMix: Record<string, number>
    occupiedMinutes: number
    freeMinutes: number
    utilisationPct: number
    transitWindows: number
    lowConfidence: boolean
    lowConfidenceReasons: string[]
    occupiedWindows: BlockWindow[]
  } | null
}

export type Department = 'Engineering' | 'S&T' | 'TRD'

export interface Asset {
  _id: string
  corridorId: string
  assetType: 'track' | 'signal' | 'OHE'
  department: Department
  criticality: {
    passengerDependency: number
    alternateRouteAvailable: boolean
    safetyImportance: number
    historicalFailureFreq: number
    /** REAL - trains observed on the section (T3), not generated. */
    trainsAffectedCount: number
  }
  criticalityScore: number
  criticalityBreakdown: Record<string, number>
  dominantCriticalityFactor: string | null
  synthetic: boolean
}

export interface Task {
  _id: string
  department: Department
  corridorId: string
  assetId: string
  defectType: string
  severity: number
  dateRaised: string
  slaDueDate: string
  estBlockDurationMins: number
  requiredResourceId: string | null
  requiredResourceIds: string[]
  dependsOnTaskId: string | null
  workflowStage: string | null
  /**
   * Populated by T10's orchestration from the FR2.3 engine. Still null on a
   * freshly seeded database until a schedule has been generated - and null
   * means "unscored", never "zero".
   */
  priorityScore: number | null
  /** FR2.4 - which factor moved the score. Null before generation. */
  dominantPriorityFactor: string | null
  /** FR2.4 - the per-factor breakdown behind priorityScore. */
  priorityBreakdown: {
    components: Record<string, number>
    contributions: Record<string, number>
    daysToDue: number
    isOverdue: boolean
    /** False until T16 exists; the flag travels so nobody assumes otherwise. */
    usesFailureRisk: boolean
  } | null
  /** null until T16 scores it (PRD 9.1). */
  failureRiskScore: number | null
  status: 'pending' | 'scheduled' | 'deferred'
  synthetic: boolean
}

/* -------------------------------------------------------------------------- */
/* Schedules (T10 orchestration)                                               */
/* -------------------------------------------------------------------------- */

export interface ScheduleBlock {
  corridorId: string
  date: string
  windowIndex: number
  start: string
  end: string
  startMinute: number
  endMinute: number
  capacityMinutes: number
  usedMinutes: number
  unusedMinutes: number
  taskIds: string[]
  departments: Department[]
  /** The headline capability: one possession serving two departments. */
  isCrossDepartmentBatch: boolean
  /** null until train-impact scoring exists (PRD 9.6, T22) - not "no impact". */
  trainImpact: unknown | null
}

export interface DeferredTask {
  taskId: string
  reason: 'EXCEEDS_LONGEST_WINDOW' | 'NO_CAPACITY' | 'NO_WINDOW_ON_CORRIDOR'
  /** Human-readable and already good; render it rather than re-wording it. */
  detail: string
}

export interface ScheduleMetrics {
  tasksScheduled: number
  tasksDeferred: number
  blocksUsed: number
  crossDepartmentBatches: number
  blockMinutesUsed: number
  blockMinutesCapacity: number
  blockUtilisationPct: number
  unusedBlockMinutes: number
}

export interface KnownGaps {
  resourceConflicts: { count: number; note: string; conflicts: unknown[] }
  dependencyViolations: { count: number; note: string; violations: unknown[] }
}

export interface Schedule {
  _id: string
  horizon: string
  horizonStart: string
  horizonDays: number
  generatedAt: string
  status: string
  objectiveValue: number
  solveSeconds: number
  /** null until T23's policy sliders exist. Do not render as controllable. */
  policyWeights: unknown | null
  metrics: ScheduleMetrics
  blocks: ScheduleBlock[]
  deferredTasks: DeferredTask[]
  decisionLog: Array<{
    taskId: string
    decision: 'scheduled' | 'deferred'
    corridorId: string
    contributingFactors: Record<string, unknown>
  }>
  knownGaps: KnownGaps
  contestableTaskIds: string[]
  /** T14's data. Deliberately unused on this screen. */
  comparisonToBaseline: unknown | null
  inputSummary: { taskCount: number; corridorCount: number; prioritySource: string }
  /** Best-effort optimizer calls that failed (D-036). Surfaced, not swallowed. */
  generationErrors: Array<{ call: string; message: string; code: string }>
}

export interface Resource {
  _id: string
  type: 'crew' | 'machine' | 'permission'
  name: string
  corridorScope: string[]
  department: Department
  depot: string
  synthetic: boolean
}

/**
 * The honesty framing (PRD Section 5, docs/DECISIONS.md D-015) as it comes back
 * out of MongoDB - the disclaimer and the field-level real/synthetic map that
 * were generated with the data, not re-stated by the UI.
 */
export interface DatasetProvenance {
  _id: string
  sourceFile: string
  synthetic: boolean
  disclaimer: string | null
  seed: number | null
  referenceDate: string | null
  fieldProvenance: {
    real?: Record<string, string>
    synthetic?: Record<string, string>
    computedDownstream?: Record<string, string>
  } | null
  recordCount: number
}

interface ListArgs {
  limit?: number
  offset?: number
}

/** `object` rather than Record<string, unknown> so plain interfaces are accepted. */
function withQuery(path: string, args: object = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const query = params.toString()
  return query ? `${path}?${query}` : path
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
  tagTypes: ['Health', 'Task', 'Corridor', 'Asset', 'Resource', 'Provenance', 'Schedule'],
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

    /**
     * Corridors. `hasSyntheticDemand` is the filter that keeps the dashboard
     * viable: only ~30 of the 10,149 real sections carry generated maintenance
     * demand, and the field is indexed, so this is an index lookup rather than
     * a scan of the whole collection.
     */
    getCorridors: builder.query<
      ListResponse<Corridor>,
      ListArgs & { hasSyntheticDemand?: boolean; zone?: string; search?: string }
    >({
      query: (args = {}) => withQuery('/corridors', args),
      providesTags: ['Corridor'],
    }),

    getCorridor: builder.query<{ data: CorridorDetail }, string>({
      query: (id) => `/corridors/${encodeURIComponent(id)}`,
      providesTags: (_result, _error, id) => [{ type: 'Corridor', id }],
    }),

    getAssets: builder.query<
      ListResponse<Asset>,
      ListArgs & { corridorId?: string; department?: Department; assetType?: string }
    >({
      query: (args = {}) => withQuery('/assets', args),
      providesTags: ['Asset'],
    }),

    getTasks: builder.query<
      ListResponse<Task>,
      ListArgs & { corridorId?: string; department?: Department; status?: string }
    >({
      query: (args = {}) => withQuery('/tasks', args),
      providesTags: ['Task'],
    }),

    getResources: builder.query<
      ListResponse<Resource>,
      ListArgs & { corridorId?: string; department?: Department; type?: string }
    >({
      query: (args = {}) => withQuery('/resources', args),
      providesTags: ['Resource'],
    }),

    getProvenance: builder.query<{ data: DatasetProvenance[] }, void>({
      query: () => '/provenance',
      providesTags: ['Provenance'],
    }),

    /** The most recently generated plan. 404s until one has been generated. */
    getLatestSchedule: builder.query<{ data: Schedule }, void>({
      query: () => '/schedules/latest',
      providesTags: ['Schedule'],
    }),

    /**
     * Run the solver. Slow by API standards - it waits on CP-SAT - so callers
     * must show a loading state rather than appearing frozen.
     *
     * Invalidates Task as well as Schedule: generation writes FR2.3 priority
     * scores back onto task documents (D-035), so the priority queue is stale
     * the moment this succeeds.
     */
    generateSchedule: builder.mutation<
      { data: Schedule },
      { horizonStart?: string; horizonDays?: number } | void
    >({
      query: (body) => ({ url: '/schedules/generate', method: 'POST', body: body ?? {} }),
      invalidatesTags: ['Schedule', 'Task'],
    }),
  }),
})

export const {
  useGetDependencyHealthQuery,
  useGetCorridorsQuery,
  useGetCorridorQuery,
  useGetAssetsQuery,
  useGetTasksQuery,
  useGetResourcesQuery,
  useGetProvenanceQuery,
  useGetLatestScheduleQuery,
  useGenerateScheduleMutation,
} = api

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
