/**
 * The FR6.1 approval workflow and FR6.3 versioning - task T19.
 *
 * Two halves, following T15's shape. The first drives `approvalEngine.ts`
 * directly: the state machine and the whole-plan re-validation are pure, so a
 * refusal can be tested without a database. The second exercises the endpoints.
 *
 * THE DIRECTION THESE TESTS ARE WRITTEN AGAINST
 * ---------------------------------------------
 * A workflow is only worth having for the transitions it REFUSES. A happy path
 * through submit -> approve -> publish proves almost nothing: the failure that
 * matters is a plan reaching publication without review, or a published plan
 * quietly changing afterwards. So the legal set is asserted by ENUMERATING
 * every (state, action) pair and requiring the complement to be refused - which
 * is the only way to know the illegal set is complete rather than merely
 * non-empty.
 */
import test, { before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';

import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import {
  Corridor,
  CorridorCalendar,
  Schedule,
  ScheduleApproval,
  ScheduleOverride,
  Task,
} from '../src/models/index.js';
import type { ScheduleBlock } from '../src/models/Schedule.js';
import type { WorkflowAction, WorkflowState } from '../src/models/ScheduleApproval.js';
import {
  INITIAL_STATE,
  OVERRIDABLE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  allowedActions,
  checkTransition,
  currentState,
  planDigest,
  validatePlan,
} from '../src/services/approvalEngine.js';
import { horizonDates, type CorridorWindow, type EffectivePlan } from '../src/services/overrideEngine.js';

const app = createApp();
const HORIZON = '2026-08-24';
const DATES = horizonDates(HORIZON, 3);

const ALL_STATES: WorkflowState[] = ['draft', 'under_review', 'approved', 'rejected', 'published'];
const ALL_ACTIONS: WorkflowAction[] = ['submit', 'approve', 'reject', 'publish'];

/* -------------------------------------------------------------------------- */
/* Pure state machine - no I/O                                                 */
/* -------------------------------------------------------------------------- */

test('a plan with no approval rows is a draft', () => {
  assert.equal(currentState([]), INITIAL_STATE);
  assert.equal(currentState([]), 'draft');
});

test('the state is the fold of the append-only rows, not a stored field', () => {
  assert.equal(
    currentState([{ toState: 'under_review' }, { toState: 'approved' }, { toState: 'published' }]),
    'published',
  );
});

test('EXHAUSTIVE: exactly the four documented transitions are legal, every other pair is refused', () => {
  const legal = new Set(TRANSITIONS.map((t) => `${t.from}|${t.action}`));
  assert.equal(legal.size, 4, 'the transition table should hold exactly four entries');

  let refused = 0;
  for (const state of ALL_STATES) {
    for (const action of ALL_ACTIONS) {
      const result = checkTransition(state, action);
      const shouldBeLegal = legal.has(`${state}|${action}`);
      assert.equal(
        result.legal,
        shouldBeLegal,
        `${action} from ${state} should be ${shouldBeLegal ? 'legal' : 'refused'}`,
      );
      if (!result.legal) {
        refused += 1;
        // A refusal that does not name the state it was refused from leaves a
        // Controller with a 409 and no idea what to do next.
        assert.match(result.refusal.reason, new RegExp(state.replace('_', '[ _]')));
      }
    }
  }
  assert.equal(refused, ALL_STATES.length * ALL_ACTIONS.length - 4, 'all 16 other pairs refused');
});

test('the terminal states refuse everything, and say why generating a new plan is the way out', () => {
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(allowedActions(state), []);
    for (const action of ALL_ACTIONS) {
      const result = checkTransition(state, action);
      assert.equal(result.legal, false);
      assert.match(result.refusal.reason, /terminal state/);
      assert.match(result.refusal.reason, /Generate a new plan/);
    }
  }
});

test('a refusal from a non-terminal state names what the action WOULD need', () => {
  const result = checkTransition('draft', 'approve');
  assert.equal(result.legal, false);
  assert.match(result.refusal.reason, /only legal from: under_review/);
  assert.match(result.refusal.reason, /legal actions are: submit/);
});

test('a published plan is frozen and a rejected one is closed; the other three stay overridable', () => {
  assert.deepEqual(
    [...OVERRIDABLE_STATES].sort(),
    ['approved', 'draft', 'under_review'],
  );
  assert.equal(OVERRIDABLE_STATES.has('published'), false);
  assert.equal(OVERRIDABLE_STATES.has('rejected'), false);
});

/* -------------------------------------------------------------------------- */
/* Whole-plan re-validation - the guard on `approve`                           */
/* -------------------------------------------------------------------------- */

const WINDOWS: CorridorWindow[] = [
  { start: '01:00', end: '04:20', startMin: 60, endMin: 260, durationMin: 200 },
  { start: '06:00', end: '07:00', startMin: 360, endMin: 420, durationMin: 60 },
];

function block(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    corridorId: 'A-B',
    date: DATES[0]!,
    windowIndex: 0,
    start: '01:00',
    end: '04:20',
    startMinute: 60,
    endMinute: 260,
    capacityMinutes: 200,
    usedMinutes: 120,
    unusedMinutes: 80,
    taskIds: ['T1'],
    departments: ['Engineering'],
    isCrossDepartmentBatch: false,
    trainImpact: null,
    ...overrides,
  };
}

function validate(plan: EffectivePlan, durations: Array<[string, number]> = [['T1', 120], ['T2', 100]]) {
  return validatePlan({
    effectivePlan: plan,
    windowsByCorridor: new Map([['A-B', WINDOWS]]),
    durationByTask: new Map(durations),
    horizonDates: DATES,
    knownConflicts: [],
  });
}

function failedChecks(result: ReturnType<typeof validate>): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.check);
}

test('a plan that is genuinely fine passes every check, and every check is reported', () => {
  const result = validate({ blocks: [block()], deferredTaskIds: ['T2'] });
  assert.equal(result.constraintsSatisfied, true);
  assert.equal(result.checks.length, 6, 'all six checks are reported, not only the failures');
  assert.deepEqual(failedChecks(result), []);
  // The deferral count in this check is the OVERRIDE-deferred one. Beside a real
  // plan that defers 53 tasks, an unqualified "0 deferred" would read as a claim
  // that nothing was deferred at all.
  const deferCheck = result.checks.find((c) => c.check === 'no-task-both-placed-and-deferred')!;
  assert.match(deferCheck.detail, /override-deferred/);
});

test('an over-filled window is caught, with both figures named', () => {
  const result = validate({
    blocks: [block({ taskIds: ['T1', 'T2'], usedMinutes: 220, unusedMinutes: -20 })],
    deferredTaskIds: [],
  });
  assert.equal(result.constraintsSatisfied, false);
  assert.ok(failedChecks(result).includes('no-window-over-capacity'));
  const check = result.checks.find((c) => c.check === 'no-window-over-capacity')!;
  assert.match(check.detail, /220\/200 min/);
});

test('a task placed in two windows at once is caught', () => {
  const result = validate({
    blocks: [
      block(),
      block({ date: DATES[1]!, windowIndex: 1, start: '06:00', end: '07:00', capacityMinutes: 60, usedMinutes: 120 }),
    ],
    deferredTaskIds: [],
  });
  assert.ok(failedChecks(result).includes('no-task-placed-twice'));
});

test('a task that is both placed and deferred is caught - a replay bug, not a solver bug', () => {
  const result = validate({ blocks: [block()], deferredTaskIds: ['T1'] });
  assert.ok(failedChecks(result).includes('no-task-both-placed-and-deferred'));
});

test('a block that does not sit on a real corridor window is caught', () => {
  const result = validate({
    blocks: [block({ start: '02:00', end: '05:00' })],
    deferredTaskIds: [],
  });
  assert.ok(failedChecks(result).includes('every-block-on-a-real-corridor-window'));
});

test('a block outside the solved horizon is caught', () => {
  const result = validate({ blocks: [block({ date: '2026-12-25' })], deferredTaskIds: [] });
  assert.ok(failedChecks(result).includes('every-block-inside-the-horizon'));
});

test('booked minutes that no longer match task durations are caught', () => {
  // The one live input the publish freeze cannot close: `applyOverrides` reads
  // durations from the tasks collection, so a duration edited after a plan was
  // built would change the replayed plan without touching an immutable record.
  const result = validate({ blocks: [block()], deferredTaskIds: [] }, [['T1', 999]]);
  assert.ok(failedChecks(result).includes('booked-minutes-match-task-durations'));
});

test('known solver gaps are summarised on the record but do NOT block approval', () => {
  const result = validatePlan({
    effectivePlan: { blocks: [block()], deferredTaskIds: ['T2'] },
    windowsByCorridor: new Map([['A-B', WINDOWS]]),
    durationByTask: new Map([['T1', 120], ['T2', 100]]),
    horizonDates: DATES,
    knownConflicts: [
      { type: 'RESOURCE_DOUBLE_BOOKING' },
      { type: 'RESOURCE_DOUBLE_BOOKING' },
      { type: 'DEPENDENCY_ORDER_VIOLATION' },
    ],
  });
  // Every plan on the real corpus carries T25's resource gap, so blocking on
  // it would make every plan unapprovable. It is recorded instead, because a
  // signature has to state what was known-unresolved when it was given.
  // (DEPENDENCY_ORDER_VIOLATION is fed in here as a hand-built type to prove
  // the summariser groups ANY conflict type correctly - T24 means a real
  // solve can no longer actually produce one; see docs/DECISIONS.md.)
  assert.equal(result.constraintsSatisfied, true);
  assert.deepEqual(result.knownUnresolved, [
    { type: 'RESOURCE_DOUBLE_BOOKING', count: 2 },
    { type: 'DEPENDENCY_ORDER_VIOLATION', count: 1 },
  ]);
});

/* -------------------------------------------------------------------------- */
/* The publication digest                                                      */
/* -------------------------------------------------------------------------- */

test('the digest is stable under presentation-only differences', () => {
  const a: EffectivePlan = { blocks: [block({ taskIds: ['T1', 'T2'] })], deferredTaskIds: ['T3'] };
  const b: EffectivePlan = {
    blocks: [block({ taskIds: ['T2', 'T1'], usedMinutes: 999, isCrossDepartmentBatch: true })],
    deferredTaskIds: ['T3'],
  };
  assert.equal(planDigest(a), planDigest(b), 'task order and derived fields must not change it');
});

test('the digest changes when work actually moves', () => {
  const base: EffectivePlan = { blocks: [block()], deferredTaskIds: [] };
  const moved: EffectivePlan = { blocks: [block({ date: DATES[1]! })], deferredTaskIds: [] };
  const dropped: EffectivePlan = { blocks: [], deferredTaskIds: ['T1'] };
  assert.notEqual(planDigest(base), planDigest(moved));
  assert.notEqual(planDigest(base), planDigest(dropped));
});

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

const TEST_DB_URI = config.mongoUri.replace(/(\/[^/?]+)(\?|$)/, '$1_approvals$2');
let databaseAvailable = false;

/** One plan per lifecycle so tests do not have to run in a fixed order. */
const PLANS = {
  publish: 'SCH-TEST-APR-PUBLISH',
  reject: 'SCH-TEST-APR-REJECT',
  illegal: 'SCH-TEST-APR-ILLEGAL',
  newer: 'SCH-TEST-APR-NEWER',
} as const;

/**
 * `generatedAt` is deliberately in the PAST relative to the test run: the audit
 * trail is ordered by time, and a fixture generated "later" than the overrides
 * recorded against it would order the narrative backwards.
 */
async function makeSchedule(id: string, generatedAt: Date): Promise<void> {
  await Schedule.create({
    _id: id,
    horizon: 'weekly',
    horizonStart: HORIZON,
    horizonDays: 3,
    generatedAt,
    status: 'OPTIMAL',
    objectiveValue: 1,
    solveSeconds: 0.1,
    metrics: { tasksScheduled: 1, tasksDeferred: 1 },
    blocks: [block()],
    deferredTasks: [{ taskId: 'T2', reason: 'NO_CAPACITY', detail: 'lost a contest' }],
    decisionLog: [],
    knownGaps: null,
    conflictReport: { conflicts: [{ type: 'RESOURCE_DOUBLE_BOOKING' }] },
    contestableTaskIds: ['T1', 'T2'],
    inputSummary: { taskCount: 2, corridorCount: 1, prioritySource: 'test' },
    generationErrors: [],
  });
}

before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 1500 });
    databaseAvailable = true;
  } catch {
    return;
  }

  await Promise.all([
    Corridor.deleteMany({}),
    CorridorCalendar.deleteMany({}),
    Task.deleteMany({}),
    Schedule.deleteMany({}),
    ScheduleOverride.deleteMany({}),
    ScheduleApproval.deleteMany({}),
  ]);

  await Corridor.create({
    _id: 'A-B',
    name: 'ALPHA – BRAVO',
    section: 'A-B',
    stationA: { code: 'A', name: 'ALPHA' },
    stationB: { code: 'B', name: 'BRAVO' },
    hasSyntheticDemand: true,
  });
  await CorridorCalendar.create({
    _id: 'A-B',
    corridorId: 'A-B',
    maxDailyBlockWindows: WINDOWS,
  });
  await Task.insertMany([
    {
      _id: 'T1', department: 'Engineering', corridorId: 'A-B', assetId: 'AST-1',
      defectType: 'rail fracture', severity: 4, dateRaised: '2026-07-01',
      slaDueDate: '2026-09-30', estBlockDurationMins: 120, status: 'pending', synthetic: true,
    },
    {
      _id: 'T2', department: 'S&T', corridorId: 'A-B', assetId: 'AST-2',
      defectType: 'relay fault', severity: 2, dateRaised: '2026-07-02',
      slaDueDate: '2026-10-30', estBlockDurationMins: 100, status: 'pending', synthetic: true,
    },
  ]);

  await makeSchedule(PLANS.publish, new Date('2026-08-19T06:00:00Z'));
  await makeSchedule(PLANS.reject, new Date('2026-08-20T06:00:00Z'));
  await makeSchedule(PLANS.illegal, new Date('2026-08-21T06:00:00Z'));
  await makeSchedule(PLANS.newer, new Date('2026-08-22T06:00:00Z'));
});

after(async () => {
  if (databaseAvailable) await mongoose.connection.close();
});

function needsDb(t: TestContext): boolean {
  if (!databaseAvailable) {
    t.skip('no MongoDB reachable');
    return false;
  }
  return true;
}

function workflow(id: string, body: Record<string, unknown>) {
  return request(app).post(`/api/schedules/${id}/workflow`).send(body);
}

test('a freshly generated plan is a draft with submit as its only action', async (t) => {
  if (!needsDb(t)) return;
  const res = await request(app).get(`/api/schedules/${PLANS.illegal}`).expect(200);
  assert.equal(res.body.data.workflowState, 'draft');
  assert.deepEqual(res.body.data.allowedActions, ['submit']);
});

test('ILLEGAL: approving a draft skips Controller Review and is refused', async (t) => {
  if (!needsDb(t)) return;
  const res = await workflow(PLANS.illegal, { action: 'approve' }).expect(409);
  assert.match(res.body.error.message, /Cannot approve a plan that is draft/);
  assert.match(res.body.error.message, /only legal from: under_review/);
  assert.equal(res.body.error.details.workflowState, 'draft');
  assert.deepEqual(res.body.error.details.allowedActions, ['submit']);
});

test('ILLEGAL: publishing a plan that is only under review is refused', async (t) => {
  if (!needsDb(t)) return;
  await workflow(PLANS.illegal, { action: 'submit' }).expect(201);
  const res = await workflow(PLANS.illegal, { action: 'publish' }).expect(409);
  assert.match(res.body.error.message, /Cannot publish a plan that is under_review/);
  assert.match(res.body.error.message, /only legal from: approved/);
});

test('ILLEGAL: a rejected plan cannot be approved afterwards', async (t) => {
  if (!needsDb(t)) return;
  await workflow(PLANS.reject, { action: 'submit' }).expect(201);
  await workflow(PLANS.reject, {
    action: 'reject',
    reason: 'Sunday possession clashes with the engineering allotment',
  }).expect(201);

  const res = await workflow(PLANS.reject, { action: 'approve' }).expect(409);
  assert.match(res.body.error.message, /terminal state/);
  assert.equal(res.body.error.details.workflowState, 'rejected');
});

test('rejecting without a stated reason is refused at the boundary', async (t) => {
  if (!needsDb(t)) return;
  const res = await workflow(PLANS.newer, { action: 'reject', reason: 'no' }).expect(400);
  assert.match(JSON.stringify(res.body), /reason of at least 8 characters/);
});

test('approve runs whole-plan re-validation and stores the result on the row', async (t) => {
  if (!needsDb(t)) return;
  await workflow(PLANS.publish, { action: 'submit' }).expect(201);
  const res = await workflow(PLANS.publish, { action: 'approve' }).expect(201);

  assert.equal(res.body.data.fromState, 'under_review');
  assert.equal(res.body.data.toState, 'approved');
  assert.equal(res.body.data.validation.constraintsSatisfied, true);
  assert.equal(res.body.data.validation.checks.length, 6);
  // FR6.1 puts re-validation before final approval; the signature records what
  // the solver had already flagged as out of scope at that moment.
  assert.deepEqual(res.body.data.validation.knownUnresolved, [
    { type: 'RESOURCE_DOUBLE_BOOKING', count: 1 },
  ]);
});

test('publishing versions the plan and fingerprints exactly what was issued', async (t) => {
  if (!needsDb(t)) return;
  const res = await workflow(PLANS.publish, { action: 'publish' }).expect(201);
  assert.equal(res.body.data.toState, 'published');
  assert.equal(res.body.data.version, 1, 'versions are dense over PUBLISHED plans');
  assert.match(res.body.data.publishedPlanDigest, /^[0-9a-f]{16}$/);
});

test('ILLEGAL: publishing twice is refused', async (t) => {
  if (!needsDb(t)) return;
  const res = await workflow(PLANS.publish, { action: 'publish' }).expect(409);
  assert.match(res.body.error.message, /terminal state/);
});

test('FREEZE: a published plan cannot be overridden', async (t) => {
  if (!needsDb(t)) return;
  const res = await request(app)
    .post(`/api/schedules/${PLANS.publish}/override`)
    .send({
      taskId: 'T1',
      action: 'defer',
      reason: 'trying to amend an issued plan',
    })
    .expect(409);
  assert.match(res.body.error.message, /published and is frozen/);
  assert.equal(res.body.error.details.workflowState, 'published');
});

test('a rejected plan cannot be overridden either', async (t) => {
  if (!needsDb(t)) return;
  const res = await request(app)
    .post(`/api/schedules/${PLANS.reject}/override`)
    .send({ taskId: 'T1', action: 'defer', reason: 'amending a discarded plan' })
    .expect(409);
  assert.match(res.body.error.message, /was rejected/);
});

test('D-043 HOLDS: the workflow never writes to the schedule document', async (t) => {
  if (!needsDb(t)) return;
  const stored = await Schedule.findById(PLANS.publish).lean();
  assert.ok(stored);
  // Publishing froze this plan by refusing writes, not by snapshotting it, so
  // there is nothing on the document to have changed - including the solver's
  // own `status`, which is a CP-SAT result and NOT the workflow state.
  assert.equal(stored.status, 'OPTIMAL');
  assert.deepEqual(stored.blocks[0]!.taskIds, ['T1']);
  assert.equal((stored as unknown as { workflowState?: string }).workflowState, undefined);
});

test('an override applied before publication stays attached to that plan version', async (t) => {
  if (!needsDb(t)) return;

  // Amend `newer` while it is still a draft, then take it all the way through.
  await request(app)
    .post(`/api/schedules/${PLANS.newer}/override`)
    .send({
      taskId: 'T1',
      action: 'move',
      targetDate: DATES[1],
      targetWindowIndex: 0,
      reason: 'crew only available on the second night',
    })
    .expect(201);

  await workflow(PLANS.newer, { action: 'submit' }).expect(201);
  await workflow(PLANS.newer, { action: 'approve' }).expect(201);
  const published = await workflow(PLANS.newer, { action: 'publish' }).expect(201);
  assert.equal(published.body.data.version, 2);

  const audit = await request(app).get(`/api/schedules/${PLANS.newer}/audit`).expect(200);
  assert.equal(audit.body.data.state, 'published');
  assert.equal(audit.body.data.version, 2);
  // The amendment is still on THIS plan and still names the solver's placement.
  const overrides = audit.body.data.entries.filter((e: { kind: string }) => e.kind === 'override');
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].detail.originalAiAssignment.date, DATES[0]);
  assert.equal(overrides[0].detail.newAssignment.date, DATES[1]);
  // And the plan still replays to exactly what was published.
  assert.equal(audit.body.data.digestMatchesPublished, true);

  // The earlier version's own overrides are untouched by any of this.
  const first = await request(app).get(`/api/schedules/${PLANS.publish}/audit`).expect(200);
  assert.equal(first.body.data.version, 1);
  assert.equal(
    first.body.data.entries.filter((e: { kind: string }) => e.kind === 'override').length,
    0,
  );
});

test('MUTATION: the published digest actually detects a plan that changed underneath it', async (t) => {
  if (!needsDb(t)) return;

  // The API refuses this, which is the point - so it is done by writing
  // straight to the collection. A digest check that cannot go false would be
  // decoration, not verification.
  const smuggled = await ScheduleOverride.create({
    _id: 'OVR-SMUGGLED',
    scheduleId: PLANS.newer,
    taskId: 'T1',
    action: 'defer',
    originalAiAssignment: null,
    fromAssignment: null,
    newAssignment: null,
    reason: 'written past the API to prove the digest check can fail',
    revalidation: { constraintsSatisfied: true, checks: [], trainImpactDelta: null },
    actorRole: 'controller',
    createdAt: new Date(),
  });

  const audit = await request(app).get(`/api/schedules/${PLANS.newer}/audit`).expect(200);
  assert.equal(audit.body.data.digestMatchesPublished, false);

  await ScheduleOverride.deleteOne({ _id: smuggled._id });
  const restored = await request(app).get(`/api/schedules/${PLANS.newer}/audit`).expect(200);
  assert.equal(restored.body.data.digestMatchesPublished, true);
});

test('the audit trail is one time-ordered narrative across both collections', async (t) => {
  if (!needsDb(t)) return;
  const res = await request(app).get(`/api/schedules/${PLANS.newer}/audit`).expect(200);
  const kinds = res.body.data.entries.map((entry: { kind: string }) => entry.kind);

  // Generation first, then the amendment, then the sign-offs - FR6.2's
  // "who/what generated it, what was changed, who signed off".
  assert.deepEqual(kinds, ['generated', 'override', 'approval', 'approval', 'approval']);
  assert.match(res.body.data.entries[0].detail.generatedBy, /CP-SAT optimizer/);

  const times = res.body.data.entries.map((entry: { at: string }) => new Date(entry.at).getTime());
  assert.deepEqual(times, [...times].sort((a: number, b: number) => a - b));
});

test('the published plan is a different query from the latest plan', async (t) => {
  if (!needsDb(t)) return;

  // A fifth plan generated after publication: newest, but nobody has approved it.
  await makeSchedule('SCH-TEST-APR-UNSEEN', new Date('2026-08-23T06:00:00Z'));

  const latest = await request(app).get('/api/schedules/latest').expect(200);
  assert.equal(latest.body.data._id, 'SCH-TEST-APR-UNSEEN');
  assert.equal(latest.body.data.workflowState, 'draft');

  const published = await request(app).get('/api/schedules/published').expect(200);
  assert.equal(published.body.data._id, PLANS.newer, 'still the last plan actually issued');
  assert.equal(published.body.data.version, 2);

  await Schedule.deleteOne({ _id: 'SCH-TEST-APR-UNSEEN' });
});

test('the plan list carries each version its workflow state (FR6.3)', async (t) => {
  if (!needsDb(t)) return;
  const res = await request(app).get('/api/schedules?limit=10').expect(200);
  const byId = new Map(
    res.body.data.map((row: { _id: string; workflowState: string }) => [row._id, row.workflowState]),
  );
  assert.equal(byId.get(PLANS.publish), 'published');
  assert.equal(byId.get(PLANS.newer), 'published');
  assert.equal(byId.get(PLANS.reject), 'rejected');
  assert.equal(byId.get(PLANS.illegal), 'under_review');
});
