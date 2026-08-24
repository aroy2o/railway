/**
 * Display logic for Ask the Planner (PRD 9.2, FR8.2).
 *
 * The screen's job is not to present an answer. It is to present an answer
 * *together with what it was grounded in*, because PRD Section 18 treats a
 * fluent invented figure as this feature's headline risk, and a Controller
 * cannot tell a grounded sentence from an invented one by reading it.
 *
 * So three states are distinguished here rather than in JSX, where they would
 * be easy to collapse by accident:
 *
 *   `answered`   - grounded, and the question was answerable.
 *   `declined`   - the system said it does not have the data. A success.
 *   `ungrounded` - it answered, but the optimizer's verifier found a number
 *                  with no counterpart in the records. Shown as a warning, with
 *                  the answer still visible so it can be judged.
 *
 * `ungrounded` must never render like `answered`. That is the whole point.
 */

export interface ExplainVerification {
  grounded: boolean
  ungroundedNumbers: string[]
  unknownRecordIds: string[]
  note?: string
}

export interface ExplainResponse {
  answer: string
  answered: boolean
  groundedIn: string[]
  verification: ExplainVerification
  model?: string
  scheduleId?: string
  context: {
    factCount: number
    recordIds: string[]
    resolvedReferences?: { tasks?: string[]; corridors?: string[] }
    unknownReferences?: string[]
    unavailableTopics?: Array<{ topic: string; reason: string; blockedOn: string }>
    provenanceNote?: string
    /**
     * Framing caveats the grounding context carried (T16 / PRD 9.1).
     *
     * Rendered by this UI regardless of whether the model repeated them. The
     * prompt asks it to; a prompt is not a guarantee, and a risk figure shown
     * without its "trained on simulated data" caveat is exactly the claim PRD
     * Section 6 NG4 forbids. Same verify-don't-trust split as `verification`.
     */
    modelFramings?: Array<{ factId: string; framing: string; applies_to?: string }>
  }
}

export type AnswerState = 'answered' | 'declined' | 'ungrounded'

export function answerState(response: ExplainResponse): AnswerState {
  // Ungrounded outranks declined: an answer carrying an invented number is the
  // thing a reader most needs flagged, even if the model also said it declined.
  if (!response.verification.grounded) return 'ungrounded'
  return response.answered ? 'answered' : 'declined'
}

/** Human labels for the record-id namespaces the grounding contract emits. */
const RECORD_KIND_LABELS: Record<string, string> = {
  decision: 'Decision log',
  task: 'Task record',
  block: 'Scheduled block',
  conflict: 'Typed conflict',
  override: 'Manual override',
  plan: 'Plan summary',
  gap: 'Known gap',
}

export interface GroundingGroup {
  kind: string
  label: string
  ids: string[]
}

/**
 * Group the cited records for display, most specific first.
 *
 * Ordering puts the per-task evidence above the plan-level context, because
 * "which record backs this claim about TSK-00004" is the question a sceptical
 * reader actually has.
 */
const KIND_ORDER = ['decision', 'task', 'block', 'conflict', 'override', 'plan', 'gap']

export function groupRecordIds(ids: string[]): GroundingGroup[] {
  const buckets = new Map<string, string[]>()
  for (const id of ids) {
    const kind = id.includes(':') ? id.slice(0, id.indexOf(':')) : 'other'
    const bucket = buckets.get(kind)
    if (bucket) bucket.push(id)
    else buckets.set(kind, [id])
  }

  return [...buckets.entries()]
    .map(([kind, kindIds]) => ({
      kind,
      label: RECORD_KIND_LABELS[kind] ?? kind,
      ids: kindIds,
    }))
    .sort((a, b) => {
      const rank = (k: string) => {
        const index = KIND_ORDER.indexOf(k)
        return index === -1 ? KIND_ORDER.length : index
      }
      return rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind)
    })
}

/**
 * The message to show when the request itself failed.
 *
 * A 503 from the explanation layer carries a written, actionable reason (no API
 * key configured, Claude unreachable). Replacing it with "Something went wrong"
 * would discard the only useful part - see D-037 and D-051.
 */
export function explainErrorMessage(error: unknown): string {
  const data = (error as { data?: { error?: { message?: string } } } | undefined)?.data
  const message = data?.error?.message
  if (typeof message === 'string' && message.trim()) return message

  const status = (error as { status?: number | string } | undefined)?.status
  if (status === 'FETCH_ERROR') return 'Could not reach the API.'
  return `The explanation service returned an error${status ? ` (${status})` : ''}.`
}

/**
 * Questions offered as one-tap examples.
 *
 * Deliberately mixed: the last one is a question the system CANNOT answer. A
 * demo that only ever shows answerable questions hides the behaviour that
 * matters most, and a Controller should see the honest refusal without having
 * to think of it themselves.
 */
export const SUGGESTED_QUESTIONS = [
  'Why was this plan deferring so many tasks?',
  'How does this plan compare to the naive baseline?',
  'Which tasks share a block across departments, and why?',
  'How many trains will be delayed by this plan?',
]
