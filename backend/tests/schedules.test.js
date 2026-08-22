/**
 * Orchestration tests (T10) - the Mongo -> Node -> optimizer -> Mongo loop.
 *
 * This is the first place a bug can hide in the SEAM between two systems that
 * are each already tested, rather than inside either one. The two field-name
 * translations Node performs are the obvious candidates:
 *
 *   corridor_calendar `startMin`/`endMin` -> the contract's `startMinute`/`endMinute`
 *   task `_id`                            -> the contract's `taskId`
 *
 * The optimizer's request models are `extra="forbid"`, so a wrong name is a 422
 * rather than a silent drop - which is why the payload shape gets its own test
 * rather than being trusted because a solve happened to come back.
 *
 * Needs MongoDB and the optimizer service. Skips cleanly without either, so the
 * suite still passes on a machine running neither.
 *
 * It uses its OWN database. `node --test` runs test files in parallel, so
 * sharing the one test database with tests/api.test.js let each file's fixture
 * wipe the other's mid-run - which surfaced here as six unrelated failures in
 * api.test.js. Isolation by database is the fix rather than forcing the runner
 * serial, because the interference was real rather than a scheduling accident.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';

import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { Asset, Corridor, CorridorCalendar, Schedule, Task } from '../src/models/index.js';
import { gatherScenario } from '../src/services/scheduleGathering.js';

const app = createApp();
const HORIZON = '2026-08-24';

let databaseAvailable = false;
let optimizerAvailable = false;
let realCorpusAvailable = false;

/** Small hand-built scenario: two departments, one shared 180-minute window. */
async function insertFixture() {
  await Corridor.insertMany([
    {
      _id: 'A-B', name: 'ALPHA – BRAVO', section: 'A-B',
      stationA: { code: 'A', name: 'ALPHA' }, stationB: { code: 'B', name: 'BRAVO' },
      hasSyntheticDemand: true,
      occupancySummary: { trainsObserved: 40, utilisationPct: 30, blockWindowCount: 1 },
    },
    {
      _id: 'C-D', name: 'CHARLIE – DELTA', section: 'C-D',
      stationA: { code: 'C', name: 'CHARLIE' }, stationB: { code: 'D', name: 'DELTA' },
      hasSyntheticDemand: false,
      occupancySummary: { trainsObserved: 2, utilisationPct: 1, blockWindowCount: 5 },
    },
  ]);
  await CorridorCalendar.create({
    _id: 'A-B', corridorId: 'A-B', trainsObserved: 40,
    // Deliberately the STORED shape - startMin/endMin - so the test exercises
    // Node's translation rather than pre-translating for it.
    maxDailyBlockWindows: [
      { start: '01:00', end: '04:00', startMin: 60, endMin: 240, durationMin: 180 },
    ],
  });
  await Asset.insertMany([
    {
      _id: 'AST-A-B-1', corridorId: 'A-B', assetType: 'track', department: 'Engineering',
      criticality: {
        passengerDependency: 0.8, alternateRouteAvailable: false, safetyImportance: 0.75,
        historicalFailureFreq: 1.0, trainsAffectedCount: 40,
      },
      criticalityScore: 72.5, synthetic: true,
    },
    {
      _id: 'AST-A-B-2', corridorId: 'A-B', assetType: 'signal', department: 'S&T',
      criticality: {
        passengerDependency: 0.8, alternateRouteAvailable: false, safetyImportance: 0.85,
        historicalFailureFreq: 0.5, trainsAffectedCount: 40,
      },
      criticalityScore: 61.0, synthetic: true,
    },
  ]);
  await Task.insertMany([
    {
      _id: 'TSK-A1', department: 'Engineering', corridorId: 'A-B', assetId: 'AST-A-B-1',
      defectType: 'rail fracture', severity: 4, dateRaised: '2026-07-01',
      slaDueDate: '2026-09-30', estBlockDurationMins: 100, status: 'pending', synthetic: true,
      requiredResourceIds: ['RES-tamper'],
    },
    {
      _id: 'TSK-A2', department: 'S&T', corridorId: 'A-B', assetId: 'AST-A-B-2',
      defectType: 'relay fault', severity: 2, dateRaised: '2026-07-02',
      slaDueDate: '2026-10-30', estBlockDurationMins: 80, status: 'pending', synthetic: true,
      requiredResourceIds: ['RES-tamper'],
    },
  ]);
}

/** A database of this file's own; see the note at the top. */
const TEST_DB_URI = config.mongoUri.replace(/(\/[^/?]+)(\?|$)/, '$1_schedules$2');

before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 1500 });
    databaseAvailable = true;
  } catch {
    return;
  }

  try {
    const probe = await fetch(`${config.optimizer.baseUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    optimizerAvailable = probe.ok;
  } catch {
    optimizerAvailable = false;
  }

  await Promise.all([
    Corridor.deleteMany({}), CorridorCalendar.deleteMany({}),
    Asset.deleteMany({}), Task.deleteMany({}), Schedule.deleteMany({}),
  ]);
  await insertFixture();
});

after(async () => {
  if (databaseAvailable) await mongoose.connection.close();
});

function needs(t, { optimizer = false } = {}) {
  if (!databaseAvailable) { t.skip('no MongoDB reachable'); return false; }
  if (optimizer && !optimizerAvailable) { t.skip('optimizer service not reachable'); return false; }
  return true;
}

/* -------------------------------------------------------------------------- */
/* The seam: does Node build a payload the optimizer's contract accepts?       */
/* -------------------------------------------------------------------------- */

test('gathering translates the stored window shape into the contract shape', async (t) => {
  if (!needs(t)) return;

  const { payload } = await gatherScenario({ horizonStart: HORIZON, horizonDays: 7 });
  const window = payload.corridors[0].dailyWindows[0];

  // Stored as startMin/endMin; the optimizer forbids unknown fields, so the
  // translation has to happen here and has to be exact.
  assert.deepEqual(Object.keys(window).sort(), ['endMinute', 'startMinute']);
  assert.equal(window.startMinute, 60);
  assert.equal(window.endMinute, 240);
});

test('gathering emits taskId, not _id, and joins real asset criticality', async (t) => {
  if (!needs(t)) return;

  const { payload } = await gatherScenario({ horizonStart: HORIZON });
  const task = payload.tasks.find((entry) => entry.taskId === 'TSK-A1');

  assert.ok(task, 'task must be keyed as taskId');
  assert.equal(task._id, undefined);
  // REAL value from the assets collection - not regenerated.
  assert.equal(task.assetCriticalityScore, 72.5);
  // Load-bearing for the baseline's FCFS ordering (D-029).
  assert.equal(task.dateRaised, '2026-07-01');
  assert.equal(task.failureRiskScore, null);
});

test('gathering only includes corridors carrying demand', async (t) => {
  if (!needs(t)) return;

  const { payload, corridorCount } = await gatherScenario({ horizonStart: HORIZON });

  assert.equal(corridorCount, 1);
  assert.deepEqual(payload.corridors.map((c) => c.corridorId), ['A-B']);
});

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

test('generate returns 201 and persists a schedule', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const res = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1 })
    .expect(201);

  const schedule = res.body.data;
  assert.match(schedule._id, /^SCH-\d{17}$/);
  assert.equal(schedule.status, 'OPTIMAL');
  assert.equal(schedule.generationErrors.length, 0);
  // Both tasks fit the 180-minute window together, from two departments.
  assert.equal(schedule.metrics.tasksScheduled, 2);
  assert.equal(schedule.metrics.crossDepartmentBatches, 1);

  assert.equal(await Schedule.countDocuments({}), 1);
});

test('priorityScore is null before generation and real after it', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await Task.updateMany({}, { $set: { priorityScore: null, dominantPriorityFactor: null } });
  const before = await Task.findById('TSK-A1').lean();
  assert.equal(before.priorityScore, null);

  await request(app).post('/api/schedules/generate').send({ horizonStart: HORIZON }).expect(201);

  const after = await Task.findById('TSK-A1').lean();
  assert.ok(after.priorityScore > 0, 'priorityScore must be populated');
  assert.ok(after.priorityScore <= 100);
  assert.ok(after.dominantPriorityFactor, 'FR2.4 dominant factor must be stored');
  assert.equal(after.priorityBreakdown.usesFailureRisk, false);
  // T16 owns this; it must NOT have been invented along the way.
  assert.equal(after.failureRiskScore, null);
});

test('re-running generation appends rather than replacing', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const before = await Schedule.countDocuments({});
  await request(app).post('/api/schedules/generate').send({ horizonStart: HORIZON }).expect(201);
  const after = await Schedule.countDocuments({});

  // FR6.3 requires prior plans to remain viewable for audit, so each generation
  // is a new document - the opposite of the seed's replace strategy (D-019).
  assert.equal(after, before + 1);
});

/* -------------------------------------------------------------------------- */
/* Honesty fields: the third and final hop (dataclass -> HTTP -> MongoDB)      */
/* -------------------------------------------------------------------------- */

test('knownGaps and the placeholder flag survive being stored and read back', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await request(app).post('/api/schedules/generate').send({ horizonStart: HORIZON }).expect(201);
  const res = await request(app).get('/api/schedules/latest').expect(200);
  const schedule = res.body.data;

  // Read back OUT of MongoDB, not from the generation response.
  assert.ok(schedule.knownGaps.resourceConflicts);
  assert.match(schedule.knownGaps.resourceConflicts.note, /T25/);
  assert.match(schedule.knownGaps.dependencyViolations.note, /T24/);
  // Both fixture tasks need RES-tamper in the same window.
  assert.equal(schedule.knownGaps.resourceConflicts.count, 1);

  const flags = new Set(
    schedule.decisionLog.map((entry) => entry.contributingFactors.priorityIsPlaceholder),
  );
  assert.deepEqual([...flags], [false], 'real criticality was joined, so not a placeholder');
  assert.equal(schedule.inputSummary.prioritySource, 'fr2.3-priority-engine');
});

test('the baseline conflict report and contestable set survive the round trip', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const schedule = (await request(app).get('/api/schedules/latest').expect(200)).body.data;

  assert.ok(schedule.baseline, 'baseline result must be stored');
  assert.match(schedule.baseline.conflicts.note, /OUTPUT of the baseline/);
  assert.equal(schedule.baseline.metrics.crossDepartmentBatches, 0);
  // D-031: T14's denominator must come from here, never tasks.length.
  assert.deepEqual(schedule.contestableTaskIds.sort(), ['TSK-A1', 'TSK-A2']);
});

test('the stored comparison carries its caveats, not just its numbers', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const schedule = (await request(app).get('/api/schedules/latest').expect(200)).body.data;
  const comparison = schedule.comparisonToBaseline;

  assert.equal(comparison.contestableTaskCount, 2);
  assert.equal(comparison.optimized.doubleBookings, 0);
  assert.equal(comparison.baseline.crossDepartmentBatches, 0);
  // Rendering these numbers without the caveats would make a claim the data
  // does not support (D-031), so they travel with them.
  assert.equal(comparison.caveats.length, 3);
  assert.ok(comparison.caveats.some((line) => /utilisation/i.test(line)));
  assert.ok(comparison.caveats.some((line) => /scheduled-task count/i.test(line)));
});

/* -------------------------------------------------------------------------- */
/* Read paths and failure handling                                             */
/* -------------------------------------------------------------------------- */

test('schedules can be listed and fetched by id', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const list = await request(app).get('/api/schedules?limit=2').expect(200);
  assert.ok(list.body.pagination.total >= 1);
  // Heavy fields are excluded from the list view.
  assert.equal(list.body.data[0].blocks, undefined);

  const id = list.body.data[0]._id;
  const one = await request(app).get(`/api/schedules/${id}`).expect(200);
  assert.equal(one.body.data._id, id);
  assert.ok(Array.isArray(one.body.data.blocks));
});

test('an unknown schedule id returns the standard 404 envelope', async (t) => {
  if (!needs(t)) return;

  const res = await request(app).get('/api/schedules/SCH-does-not-exist').expect(404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('reprioritize updates scores without running a solve', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await Task.updateMany({}, { $set: { priorityScore: null } });
  const before = await Schedule.countDocuments({});

  const res = await request(app)
    .post('/api/tasks/reprioritize')
    .send({ asOf: HORIZON })
    .expect(200);

  assert.equal(res.body.data.ranked, 2);
  assert.ok(res.body.data.tasksUpdated >= 1);
  assert.ok((await Task.findById('TSK-A1').lean()).priorityScore > 0);
  // No schedule produced - that is the point of the lighter path (D-034).
  assert.equal(await Schedule.countDocuments({}), before);
});

test('an unreachable optimizer yields a clean, actionable 502', async (t) => {
  if (!needs(t)) return;

  // `config` is deliberately frozen (T1), so the optimizer URL cannot be
  // swapped for the test - and it should not be. Simulating the failure at the
  // transport layer is closer to the real thing anyway: this is what Node sees
  // when the service is not listening.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes(config.optimizer.baseUrl)) {
      throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
    }
    return realFetch(url);
  };

  try {
    const res = await request(app)
      .post('/api/schedules/generate')
      .send({ horizonStart: HORIZON })
      .expect(502);

    assert.equal(res.body.error.code, 'BAD_GATEWAY');
    // Not "Internal server error": an ApiError message is author-written and
    // safe, and masking it turned the single most likely operational failure
    // into the least actionable message the API could produce.
    assert.match(res.body.error.message, /optimizer/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('generation refuses cleanly when nothing is seeded', async (t) => {
  if (!needs(t)) return;

  const saved = await Corridor.find({ hasSyntheticDemand: true }).lean();
  await Corridor.updateMany({}, { $set: { hasSyntheticDemand: false } });

  try {
    const res = await request(app)
      .post('/api/schedules/generate')
      .send({ horizonStart: HORIZON })
      .expect(409);
    assert.match(res.body.error.message, /seeded/i);
  } finally {
    await Corridor.updateMany(
      { _id: { $in: saved.map((c) => c._id) } },
      { $set: { hasSyntheticDemand: true } },
    );
  }
});

test('invalid generation parameters are rejected at the boundary', async (t) => {
  if (!needs(t)) return;

  await request(app).post('/api/schedules/generate').send({ horizonStart: 'nope' }).expect(400);
  await request(app).post('/api/schedules/generate').send({ horizonDays: 0 }).expect(400);
  await request(app).post('/api/schedules/generate').send({ horizonDays: 500 }).expect(400);
});

/* -------------------------------------------------------------------------- */
/* The real corpus, through the whole loop                                     */
/* -------------------------------------------------------------------------- */

test('the real 89-task corpus reproduces CHECKPOINT.md numbers through this path', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  // Copy just the working set out of the seeded DEVELOPMENT database - note the
  // `_test` suffix is stripped, since config.mongoUri points at the test
  // database here and the corpus lives in the real one. Only the 30 corridors
  // carrying demand, their calendars and the backlog are copied; all 10,149
  // corridors would be 47 MB for no benefit, since gathering filters to
  // hasSyntheticDemand anyway.
  const devUri = config.mongoUri.replace(/_test(\?|$)/, '$1');
  const source = await mongoose.createConnection(devUri).asPromise();
  try {
    const corridors = await source
      .collection('corridors')
      .find({ hasSyntheticDemand: true })
      .toArray();
    if (corridors.length !== 30) {
      t.skip('development corpus not seeded; run npm run seed');
      return;
    }
    const ids = corridors.map((corridor) => corridor._id);
    const [calendars, tasks, assets] = await Promise.all([
      source.collection('corridor_calendar').find({ _id: { $in: ids } }).toArray(),
      source.collection('tasks').find({ corridorId: { $in: ids } }).toArray(),
      source.collection('assets').find({ corridorId: { $in: ids } }).toArray(),
    ]);

    await Promise.all([
      Corridor.deleteMany({}), CorridorCalendar.deleteMany({}),
      Asset.deleteMany({}), Task.deleteMany({}),
    ]);
    await Corridor.collection.insertMany(corridors);
    await CorridorCalendar.collection.insertMany(calendars);
    await Task.collection.insertMany(tasks);
    await Asset.collection.insertMany(assets);

    const res = await request(app)
      .post('/api/schedules/generate')
      .send({ horizonStart: HORIZON, horizonDays: 7 })
      .expect(201);
    const schedule = res.body.data;

    // Exactly the figures CHECKPOINT.md recorded, now arriving via
    // MongoDB -> Node -> optimizer HTTP -> MongoDB.
    assert.equal(schedule.inputSummary.taskCount, 89);
    assert.equal(schedule.inputSummary.corridorCount, 30);
    assert.equal(schedule.status, 'OPTIMAL');
    assert.equal(schedule.metrics.tasksScheduled, 36);
    assert.equal(schedule.metrics.tasksDeferred, 53);
    assert.equal(schedule.metrics.crossDepartmentBatches, 2);
    assert.ok(schedule.solveSeconds < 10, 'PRD Section 7 budget');

    assert.equal(schedule.baseline.metrics.doubleBookings, 6);
    assert.equal(schedule.baseline.metrics.doubleBookedMinutes, 605);
    assert.equal(schedule.baseline.metrics.overSubscribedWindows, 3);
    assert.equal(schedule.baseline.metrics.crossDepartmentBatches, 0);

    assert.equal(schedule.contestableTaskIds.length, 36);
    assert.equal(schedule.comparisonToBaseline.contestableTaskCount, 36);
    assert.equal(schedule.comparisonToBaseline.structurallyImpossibleCount, 53);
    // D-031's core finding: no throughput advantage, so the screen must not
    // claim one.
    assert.equal(schedule.comparisonToBaseline.optimized.contestableScheduled, 36);
    assert.equal(schedule.comparisonToBaseline.baseline.contestableScheduled, 36);
    // And the trap: baseline utilisation reads higher.
    assert.ok(
      schedule.comparisonToBaseline.baseline.blockUtilisationPct >
        schedule.comparisonToBaseline.optimized.blockUtilisationPct,
    );

    assert.equal(schedule.knownGaps.resourceConflicts.count, 11);
    assert.equal(schedule.knownGaps.dependencyViolations.count, 5);

    // Priority scores landed on every task, in T7's measured range.
    const scored = await Task.find({ priorityScore: { $ne: null } }).lean();
    assert.equal(scored.length, 89);
    const scores = scored.map((task) => task.priorityScore);
    assert.ok(Math.min(...scores) >= 25 && Math.max(...scores) <= 88);
  } finally {
    await source.close();
  }
});
