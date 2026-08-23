/**
 * Manual override and re-validation - FR6.2, task T15.
 *
 * Two halves. The first drives `overrideEngine.ts` directly with hand-built
 * data - no database, no HTTP - because that is where a re-validation bug would
 * live. The second exercises the endpoints.
 *
 * THE DIRECTION THESE TESTS ARE WRITTEN AGAINST
 * ---------------------------------------------
 * A validator that wrongly rejects fails loudly. A validator that wrongly
 * ACCEPTS produces a plan that looks valid and cannot be executed, and nobody
 * finds out until a crew is standing on a corridor. Most of what follows is
 * aimed at the second failure, including one test that deliberately tries to
 * slip an over-capacity move past the checks.
 */
import test, { before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';

import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import {
  Asset,
  Corridor,
  CorridorCalendar,
  Schedule,
  ScheduleOverride,
  Task,
} from '../src/models/index.js';
import type { ScheduleBlock } from '../src/models/Schedule.js';
import type { IScheduleOverride } from '../src/models/ScheduleOverride.js';
import {
  applyOverrides,
  findPlacement,
  horizonDates,
  validateMove,
  type CorridorWindow,
} from '../src/services/overrideEngine.js';

const app = createApp();
const HORIZON = '2026-08-24';
const DATES = horizonDates(HORIZON, 3);

/* -------------------------------------------------------------------------- */
/* Pure engine - hand-built, no I/O                                            */
/* -------------------------------------------------------------------------- */

/** One corridor, two windows: a 200-minute one and a 60-minute one. */
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

function override(partial: Partial<IScheduleOverride>): IScheduleOverride {
  return {
    _id: 'OVR-1',
    scheduleId: 'SCH-1',
    taskId: 'T1',
    action: 'move',
    originalAiAssignment: null,
    fromAssignment: null,
    newAssignment: {
      corridorId: 'A-B',
      date: DATES[1]!,
      windowIndex: 0,
      start: '01:00',
      end: '04:20',
      startMinute: 60,
      endMinute: 260,
      capacityMinutes: 200,
    },
    reason: 'controller judgement',
    revalidation: { constraintsSatisfied: true, checks: [], trainImpactDelta: null },
    actorRole: 'controller',
    createdAt: new Date(),
    ...partial,
  } as IScheduleOverride;
}

const DURATIONS = new Map([
  ['T1', 120],
  ['T2', 100],
  ['T3', 150],
]);

test('applying a move lifts the task out of its old window and into the new one', () => {
  const plan = applyOverrides([block()], [override({})], DURATIONS);

  // The emptied window is dropped: a possession nobody is using is not taken.
  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.blocks[0]!.date, DATES[1]);
  assert.deepEqual(plan.blocks[0]!.taskIds, ['T1']);
  assert.equal(plan.blocks[0]!.usedMinutes, 120);
});

test('a window keeping other work stays, with capacity recomputed', () => {
  const shared = block({ taskIds: ['T1', 'T2'], departments: ['Engineering', 'S&T'], usedMinutes: 220 });

  const plan = applyOverrides([shared], [override({})], DURATIONS);

  const origin = plan.blocks.find((b) => b.date === DATES[0])!;
  assert.deepEqual(origin.taskIds, ['T2']);
  assert.equal(origin.usedMinutes, 100);
  assert.equal(origin.unusedMinutes, 100);
  // T1 leaving takes Engineering with it, so this is no longer a shared block.
  assert.equal(origin.isCrossDepartmentBatch, false);
});

test('a task can be overridden twice, each acting on the previous placement', () => {
  const first = override({ _id: 'OVR-1' });
  const second = override({
    _id: 'OVR-2',
    newAssignment: { ...first.newAssignment!, date: DATES[2]! },
  });

  const plan = applyOverrides([block()], [first, second], DURATIONS);

  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.blocks[0]!.date, DATES[2]);
});

test('deferring removes the task from the plan entirely', () => {
  const plan = applyOverrides([block()], [override({ action: 'defer', newAssignment: null })], DURATIONS);

  assert.equal(plan.blocks.length, 0);
  assert.deepEqual(plan.deferredTaskIds, ['T1']);
});

/* --- validateMove ---------------------------------------------------------- */

function validate(partial: Partial<Parameters<typeof validateMove>[0]> = {}) {
  return validateMove({
    taskId: 'T2',
    taskCorridorId: 'A-B',
    taskDurationMinutes: 100,
    targetCorridorId: 'A-B',
    targetDate: DATES[1]!,
    targetWindowIndex: 0,
    corridorWindows: WINDOWS,
    horizonDates: DATES,
    effectivePlan: { blocks: [block()], deferredTaskIds: [] },
    ...partial,
  });
}

test('a genuinely valid move is accepted, with every check reported', () => {
  const result = validate();

  assert.equal(result.revalidation.constraintsSatisfied, true);
  assert.ok(result.assignment);
  assert.equal(result.assignment!.start, '01:00');
  // The Controller sees what was verified, not just a verdict.
  assert.ok(result.revalidation.checks.length >= 5);
  assert.ok(result.revalidation.checks.every((check) => check.passed));
});

test('a cross-corridor move is refused - the asset does not move with the work', () => {
  const result = validate({ targetCorridorId: 'C-D' });

  assert.equal(result.revalidation.constraintsSatisfied, false);
  const failed = result.revalidation.checks.find((c) => !c.passed)!;
  assert.equal(failed.check, 'same-corridor');
  assert.match(failed.detail, /asset does not move/);
});

test('a move outside the plan horizon is refused', () => {
  const result = validate({ targetDate: '2027-01-01' });

  assert.equal(result.revalidation.constraintsSatisfied, false);
  assert.equal(result.revalidation.checks.find((c) => !c.passed)!.check, 'within-horizon');
});

test('a window index the corridor does not have is refused', () => {
  const result = validate({ targetWindowIndex: 99 });

  assert.equal(result.revalidation.constraintsSatisfied, false);
  const failed = result.revalidation.checks.find((c) => !c.passed)!;
  assert.equal(failed.check, 'window-exists');
  assert.match(failed.detail, /has 2 free window/);
});

test('a task longer than the window is refused with both figures named', () => {
  // 100 minutes of work into the 60-minute window.
  const result = validate({ targetWindowIndex: 1 });

  assert.equal(result.revalidation.constraintsSatisfied, false);
  const failed = result.revalidation.checks.find((c) => !c.passed)!;
  assert.equal(failed.check, 'duration-fits-window');
  assert.match(failed.detail, /100 min/);
  assert.match(failed.detail, /60 min/);
});

test('moving a task to where it already is is refused rather than silently accepted', () => {
  const result = validate({
    taskId: 'T1',
    taskDurationMinutes: 120,
    targetDate: DATES[0]!,
    targetWindowIndex: 0,
  });

  assert.equal(result.revalidation.constraintsSatisfied, false);
  assert.equal(result.revalidation.checks.find((c) => !c.passed)!.check, 'different-placement');
});

test('a window that is already nearly full refuses the move', () => {
  // 200-minute window holding 150 minutes; a 100-minute task cannot join it.
  const nearlyFull = block({ date: DATES[1]!, taskIds: ['T3'], usedMinutes: 150, unusedMinutes: 50 });

  const result = validate({ effectivePlan: { blocks: [nearlyFull], deferredTaskIds: [] } });

  assert.equal(result.revalidation.constraintsSatisfied, false);
  const failed = result.revalidation.checks.find((c) => !c.passed)!;
  assert.equal(failed.check, 'window-capacity');
  assert.match(failed.detail, /leaving 50 min/);
});

test('capacity is measured exactly, not approximately', () => {
  // 200-minute window with 100 minutes used: a 100-minute task fits precisely.
  const halfFull = block({ date: DATES[1]!, taskIds: ['T2'], usedMinutes: 100, unusedMinutes: 100 });
  const exact = validate({
    taskId: 'T3',
    taskDurationMinutes: 100,
    effectivePlan: { blocks: [halfFull], deferredTaskIds: [] },
  });
  assert.equal(exact.revalidation.constraintsSatisfied, true, '100 into 100 free must fit');

  const oneOver = validate({
    taskId: 'T3',
    taskDurationMinutes: 101,
    effectivePlan: { blocks: [halfFull], deferredTaskIds: [] },
  });
  assert.equal(oneOver.revalidation.constraintsSatisfied, false, 'one minute over must not');
});

/**
 * THE ADVERSARIAL CASE.
 *
 * Deliberately constructed to slip an invalid override through in the
 * dangerous direction - accepting something that cannot be executed.
 *
 * Setup: the solver put nothing in Tuesday's 200-minute window. A first
 * override moved a 150-minute task into it. A second override now tries to add
 * a 100-minute task to the same window. Total would be 250 minutes of work in
 * a 200-minute possession.
 *
 * A validator that measured capacity against the solver's ORIGINAL blocks
 * would see an empty window, find 200 minutes free, and accept - producing a
 * schedule that looks valid and is not. Only a validator reading the EFFECTIVE
 * plan catches it.
 */
test('ADVERSARIAL: an over-fill hidden behind a prior override is still caught', () => {
  const solverBlocks = [block()]; // Monday only. Tuesday is untouched.
  const firstOverride = override({
    _id: 'OVR-1',
    taskId: 'T3',
    newAssignment: {
      corridorId: 'A-B',
      date: DATES[1]!,
      windowIndex: 0,
      start: '01:00',
      end: '04:20',
      startMinute: 60,
      endMinute: 260,
      capacityMinutes: 200,
    },
  });

  // Sanity: reading the solver's plan alone, Tuesday looks completely empty.
  const naiveView = solverBlocks.find((b) => b.date === DATES[1]);
  assert.equal(naiveView, undefined, 'the trap requires Tuesday to look empty in the base plan');

  const effectivePlan = applyOverrides(solverBlocks, [firstOverride], DURATIONS);
  const tuesday = effectivePlan.blocks.find((b) => b.date === DATES[1])!;
  assert.equal(tuesday.usedMinutes, 150, 'the prior override really did fill it');

  const result = validate({
    taskId: 'T2',
    taskDurationMinutes: 100,
    targetDate: DATES[1]!,
    effectivePlan,
  });

  assert.equal(
    result.revalidation.constraintsSatisfied,
    false,
    '150 + 100 into a 200 minute window must be refused',
  );
  const failed = result.revalidation.checks.find((c) => !c.passed)!;
  assert.equal(failed.check, 'window-capacity');
  assert.match(failed.detail, /already holds 150 min/);
});

test('findPlacement reports where a task currently sits', () => {
  assert.equal(findPlacement({ blocks: [block()], deferredTaskIds: [] }, 'T1')?.date, DATES[0]);
  assert.equal(findPlacement({ blocks: [block()], deferredTaskIds: [] }, 'NOPE'), null);
});

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

const TEST_DB_URI = config.mongoUri.replace(/(\/[^/?]+)(\?|$)/, '$1_overrides$2');
let databaseAvailable = false;
const SCHEDULE_ID = 'SCH-TEST-OVERRIDE';

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
    Asset.deleteMany({}),
    Task.deleteMany({}),
    Schedule.deleteMany({}),
    ScheduleOverride.deleteMany({}),
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
    maxDailyBlockWindows: [
      { start: '01:00', end: '04:20', startMin: 60, endMin: 260, durationMin: 200 },
      { start: '06:00', end: '07:00', startMin: 360, endMin: 420, durationMin: 60 },
    ],
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
  await Schedule.create({
    _id: SCHEDULE_ID,
    horizon: 'weekly',
    horizonStart: HORIZON,
    horizonDays: 3,
    generatedAt: new Date(),
    status: 'OPTIMAL',
    objectiveValue: 1,
    solveSeconds: 0.1,
    metrics: {},
    blocks: [block({ taskIds: ['T1'], usedMinutes: 120, unusedMinutes: 80 })],
    deferredTasks: [{ taskId: 'T2', reason: 'NO_CAPACITY', detail: 'lost a contest' }],
    decisionLog: [],
    knownGaps: null,
    contestableTaskIds: ['T1', 'T2'],
    inputSummary: { taskCount: 2, corridorCount: 1, prioritySource: 'test' },
    generationErrors: [],
  });
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

test('a valid move is accepted and recorded with its re-validation', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({
      taskId: 'T1',
      action: 'move',
      targetDate: DATES[1],
      targetWindowIndex: 0,
      reason: 'Ganger unavailable on the Monday night shift',
    })
    .expect(201);

  const saved = res.body.data;
  assert.equal(saved.action, 'move');
  assert.equal(saved.revalidation.constraintsSatisfied, true);
  // FR6.2: original AI assignment, new assignment, reason, re-validation result.
  assert.equal(saved.originalAiAssignment.date, DATES[0]);
  assert.equal(saved.newAssignment.date, DATES[1]);
  assert.match(saved.reason, /Ganger/);
  assert.equal(saved.revalidation.trainImpactDelta, null); // T22's, not invented
});

test('the schedule document itself is never mutated', async (t) => {
  if (!needsDb(t)) return;

  const stored = await Schedule.findById(SCHEDULE_ID).lean();

  // The solver's plan still says Monday - the decision log explains that plan,
  // and rewriting blocks would leave the explanation grounded in a lie (D-043).
  assert.equal(stored!.blocks[0]!.date, DATES[0]);
  assert.deepEqual(stored!.blocks[0]!.taskIds, ['T1']);
});

test('the effective plan reflects the override', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app).get(`/api/schedules/${SCHEDULE_ID}`).expect(200);

  assert.equal(res.body.data.blocks[0].date, DATES[0], 'base plan untouched');
  assert.equal(res.body.data.effectivePlan.blocks[0].date, DATES[1], 'effective plan moved');
  assert.equal(res.body.data.overrides.length, 1);
});

test('a move into a window without room is refused with the specific reason', async (t) => {
  if (!needsDb(t)) return;

  // T1 (120 min) now occupies Tuesday's 200-minute window. T2 needs 100.
  const res = await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({
      taskId: 'T2',
      action: 'move',
      targetDate: DATES[1],
      targetWindowIndex: 0,
      reason: 'Trying to co-locate the signalling work',
    })
    .expect(409);

  assert.equal(res.body.error.code, 'CONFLICT');
  assert.match(res.body.error.message, /already holds 120 min/);
  // The whole check list travels, not just the failure.
  assert.ok(res.body.error.details.revalidation.checks.length >= 5);
});

test('a task too long for the target window is refused', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({
      taskId: 'T2',
      action: 'move',
      targetDate: DATES[2],
      targetWindowIndex: 1, // the 60-minute window
      reason: 'Attempting the early morning slot',
    })
    .expect(409);

  assert.match(res.body.error.message, /100 min/);
  assert.match(res.body.error.message, /60 min/);
});

test('override targets offered to the UI are exactly those the write path accepts', async (t) => {
  if (!needsDb(t)) return;

  const targets = (await request(app)
    .get(`/api/schedules/${SCHEDULE_ID}/override-targets/T2`)
    .expect(200)).body.data as Array<{ date: string; windowIndex: number }>;

  assert.ok(targets.length > 0);
  // The 60-minute window can never hold a 100-minute task, on any day.
  assert.ok(targets.every((target) => target.windowIndex !== 1));
  // Tuesday's big window is full of T1, so it must not be offered either.
  assert.ok(!targets.some((t2) => t2.date === DATES[1] && t2.windowIndex === 0));
});

test('deferring a scheduled task is accepted and frees its window', async (t) => {
  if (!needsDb(t)) return;

  await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({ taskId: 'T1', action: 'defer', reason: 'Awaiting a spare tamping machine' })
    .expect(201);

  const res = await request(app).get(`/api/schedules/${SCHEDULE_ID}`).expect(200);
  assert.deepEqual(res.body.data.effectivePlan.deferredTaskIds, ['T1']);
  assert.equal(res.body.data.effectivePlan.blocks.length, 0, 'the emptied window is released');
});

test('an override without a real reason is rejected at the boundary', async (t) => {
  if (!needsDb(t)) return;

  await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({ taskId: 'T1', action: 'defer', reason: 'x' })
    .expect(400);

  await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({ taskId: 'T1', action: 'defer' })
    .expect(400);
});

test('a move without a target is rejected at the boundary', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({ taskId: 'T1', action: 'move', reason: 'No target supplied at all' })
    .expect(400);

  assert.equal(res.body.error.code, 'BAD_REQUEST');
});

test('overriding a task that is not in this plan is refused, not silently ignored', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({ taskId: 'T2', action: 'defer', reason: 'This one is already deferred' })
    .expect(409);

  assert.match(res.body.error.message, /already deferred/);
});

test('overriding a nonexistent task returns a clean 404', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app)
    .post(`/api/schedules/${SCHEDULE_ID}/override`)
    .send({ taskId: 'NO-SUCH-TASK', action: 'defer', reason: 'Should not be possible' })
    .expect(404);

  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('the override history is the FR6.2 audit trail', async (t) => {
  if (!needsDb(t)) return;

  const res = await request(app).get(`/api/schedules/${SCHEDULE_ID}/overrides`).expect(200);

  assert.equal(res.body.data.length, 2); // the move, then the defer
  for (const entry of res.body.data) {
    assert.ok(entry.reason.length >= 8);
    assert.ok(entry.revalidation);
    assert.ok(entry.actorRole);
    assert.ok(entry.createdAt);
  }
  // Chronological, which is also the order they replay in.
  assert.ok(
    new Date(res.body.data[0].createdAt) <= new Date(res.body.data[1].createdAt),
  );
});
