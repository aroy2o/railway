/**
 * The FR6.1 workflow's display logic.
 *
 * The load-bearing test here is `describeSignOff` on an UNAPPROVED plan. A UI
 * that renders a blank until someone signs off lets a Controller read an
 * unreviewed plan as an approved one - and unlike a wrong number, that mistake
 * looks like nothing at all.
 */
import { describe, expect, it } from 'vitest'
import type { ScheduleOverride } from '../api/apiSlice.ts'
import {
  canSubmitAction,
  describeAction,
  describeSignOff,
  describeState,
  OVERRIDABLE_STATES,
  publicationDriftWarning,
  summariseEntry,
  type AuditEntry,
  type ScheduleApproval,
  type WorkflowState,
} from './approval.ts'

function approval(overrides: Partial<ScheduleApproval> = {}): ScheduleApproval {
  return {
    _id: 'APR-1',
    scheduleId: 'SCH-1',
    action: 'approve',
    fromState: 'under_review',
    toState: 'approved',
    reason: '',
    actorRole: 'controller',
    validation: { constraintsSatisfied: true, checks: [], knownUnresolved: [] },
    version: null,
    publishedPlanDigest: null,
    createdAt: '2026-08-24T11:00:00Z',
    ...overrides,
  }
}

function entry(detail: ScheduleApproval): AuditEntry {
  return { kind: 'approval', at: detail.createdAt, detail }
}

describe('describeState', () => {
  it('gives every state a meaning, not a restatement of its own label', () => {
    const states: WorkflowState[] = ['draft', 'under_review', 'approved', 'rejected', 'published']
    for (const state of states) {
      const described = describeState(state)
      expect(described.label.length).toBeGreaterThan(0)
      expect(described.meaning.length).toBeGreaterThan(0)
      expect(described.meaning.toLowerCase()).not.toBe(described.label.toLowerCase())
    }
  })

  it('says a published plan is frozen, because that is the operative fact', () => {
    expect(describeState('published').meaning).toMatch(/frozen/i)
    expect(describeState('draft').meaning).toMatch(/nobody has reviewed/i)
  })
})

describe('describeSignOff', () => {
  it('answers "not approved yet" as a STATE rather than showing nothing', () => {
    const answer = describeSignOff({ state: 'draft', version: null, entries: [] })

    expect(answer).toMatch(/Not approved yet/)
    // The absence of a sign-off has to be stated, not implied by an empty panel.
    expect(answer.length).toBeGreaterThan(20)
  })

  it('distinguishes "nobody has yet" from "rejected"', () => {
    expect(describeSignOff({ state: 'rejected', version: null, entries: [] })).toMatch(/rejected/)
    expect(describeSignOff({ state: 'rejected', version: null, entries: [] })).not.toMatch(
      /Not approved yet/,
    )
  })

  it('attributes an approval to a ROLE and never to a named person', () => {
    const answer = describeSignOff({
      state: 'published',
      version: 2,
      entries: [entry(approval({ actorRole: 'drm' }))],
    })

    expect(answer).toMatch(/the drm role/)
    expect(answer).toMatch(/Published as version 2/)
  })

  it('reports the approval, not the submission that preceded it', () => {
    const answer = describeSignOff({
      state: 'approved',
      version: null,
      entries: [
        entry(approval({ _id: 'APR-0', action: 'submit', toState: 'under_review', actorRole: 'controller' })),
        entry(approval({ actorRole: 'drm' })),
      ],
    })

    expect(answer).toMatch(/the drm role/)
  })
})

describe('OVERRIDABLE_STATES', () => {
  it('matches the server: frozen when published, closed when rejected', () => {
    expect([...OVERRIDABLE_STATES].sort()).toEqual(['approved', 'draft', 'under_review'])
    expect(OVERRIDABLE_STATES.has('published')).toBe(false)
    expect(OVERRIDABLE_STATES.has('rejected')).toBe(false)
  })

  it('agrees with the server signal it sits beside — no legal action, no override', () => {
    // `allowedActions` comes from the API and goes empty in exactly the two
    // states this set excludes, so a drift between them would be visible.
    const terminal: WorkflowState[] = ['published', 'rejected']
    for (const state of terminal) {
      expect(OVERRIDABLE_STATES.has(state)).toBe(false)
      expect(describeState(state).meaning).toMatch(/frozen|Generate a new plan/i)
    }
  })
})

describe('canSubmitAction', () => {
  it('requires a real reason to reject, mirroring FR6.2 for overrides', () => {
    expect(describeAction('reject').requiresReason).toBe(true)
    expect(canSubmitAction('reject', '')).toBe(false)
    expect(canSubmitAction('reject', 'nope')).toBe(false)
    expect(canSubmitAction('reject', 'clashes with the block allotment')).toBe(true)
  })

  it('does not demand a reason for the actions that do not need one', () => {
    for (const action of ['submit', 'approve', 'publish'] as const) {
      expect(canSubmitAction(action, '')).toBe(true)
    }
  })

  it('marks the two actions that cannot be walked back', () => {
    expect(describeAction('reject').terminal).toBe(true)
    expect(describeAction('publish').terminal).toBe(true)
    expect(describeAction('submit').terminal).toBe(false)
    expect(describeAction('approve').terminal).toBe(false)
  })
})

describe('summariseEntry', () => {
  it('names what generated the plan, not just that it exists', () => {
    expect(
      summariseEntry({
        kind: 'generated',
        at: '2026-08-24T09:00:00Z',
        detail: { generatedBy: 'CP-SAT optimizer (FR2.3 priorities)' },
      }),
    ).toMatch(/CP-SAT optimizer/)
  })

  it('summarises a move and a defer differently', () => {
    const base = {
      _id: 'OVR-1', scheduleId: 'SCH-1', taskId: 'TSK-00042',
      originalAiAssignment: null, fromAssignment: null,
      reason: 'crew availability', actorRole: 'controller',
      revalidation: { constraintsSatisfied: true, checks: [], trainImpactDelta: null },
      createdAt: '2026-08-24T10:00:00Z',
    } as unknown as ScheduleOverride

    const moved = summariseEntry({
      kind: 'override',
      at: base.createdAt,
      detail: { ...base, action: 'move', newAssignment: { date: '2026-08-26', start: '01:00' } } as ScheduleOverride,
    })
    const deferred = summariseEntry({
      kind: 'override',
      at: base.createdAt,
      detail: { ...base, action: 'defer', newAssignment: null } as ScheduleOverride,
    })

    expect(moved).toMatch(/TSK-00042 moved to 2026-08-26 01:00/)
    expect(deferred).toMatch(/TSK-00042 deferred/)
    expect(deferred).not.toMatch(/moved/)
  })

  it('reads a workflow row as the state it left the plan in', () => {
    expect(summariseEntry(entry(approval({ action: 'publish', toState: 'published', version: 3 })))).toBe(
      'Plan published as version 3 by the controller role',
    )
    expect(summariseEntry(entry(approval({ action: 'submit', toState: 'under_review' })))).toBe(
      'Plan under review by the controller role',
    )
  })
})

describe('publicationDriftWarning', () => {
  it('is silent in both healthy cases', () => {
    expect(publicationDriftWarning({ digestMatchesPublished: null })).toBeNull()
    expect(publicationDriftWarning({ digestMatchesPublished: true })).toBeNull()
  })

  it('warns, and says the trail is authoritative, when a published plan drifted', () => {
    const warning = publicationDriftWarning({ digestMatchesPublished: false })

    expect(warning).toMatch(/no longer matches/)
    expect(warning).toMatch(/re-issue/)
  })
})
