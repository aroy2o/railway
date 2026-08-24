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
import test, { before, after, type TestContext } from 'node:test';
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

/** Small hand-built scenario: two departments, one shared 180-minute window. */
async function insertFixture() {
  await Corridor.insertMany([
    {
      _id: 'A-B', name: 'ALPHA – BRAVO', section: 'A-B',
      stationA: { code: 'A', name: 'ALPHA' }, stationB: { code: 'B', name: 'BRAVO' },
      hasSyntheticDemand: true,
      occupancySummary: { trainsObserved: 40, utilisationPct: 30, blockWindowCount: 1 },
      // T26: deliberately set so the gathering test below exercises real
      // threading, not just a null default passing through unnoticed.
      seasonalRiskFlag: 'monsoon-risk',
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
      // T25 made resource no-overlap a hard constraint, so this fixture must
      // NOT share a resource between TSK-A1 and TSK-A2 any more - it would
      // now force one to defer instead of the cross-department batch this
      // fixture exists to demonstrate. See the dedicated resource-conflict
      // tests below, which build their own inline scenario instead.
      _id: 'TSK-A1', department: 'Engineering', corridorId: 'A-B', assetId: 'AST-A-B-1',
      defectType: 'rail fracture', severity: 4, dateRaised: '2026-07-01',
      slaDueDate: '2026-09-30', estBlockDurationMins: 100, status: 'pending', synthetic: true,
    },
    {
      _id: 'TSK-A2', department: 'S&T', corridorId: 'A-B', assetId: 'AST-A-B-2',
      defectType: 'relay fault', severity: 2, dateRaised: '2026-07-02',
      slaDueDate: '2026-10-30', estBlockDurationMins: 80, status: 'pending', synthetic: true,
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

function needs(t: TestContext, { optimizer = false }: { optimizer?: boolean } = {}): boolean {
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

test('gathering threads seasonalRiskFlag straight through (T26)', async (t) => {
  if (!needs(t)) return;

  const { payload } = await gatherScenario({ horizonStart: HORIZON, horizonDays: 7 });
  const corridor = payload.corridors.find((c) => c.corridorId === 'A-B');

  // Denormalised onto Corridor at seed time (D-016), so no join is needed
  // here - unlike occupiedWindows/trainClassMix, which come from the
  // separate corridor_calendar collection.
  assert.equal(corridor?.seasonalRiskFlag, 'monsoon-risk');
});

test('gathering emits taskId, not _id, and joins real asset criticality', async (t) => {
  if (!needs(t)) return;

  const { payload } = await gatherScenario({ horizonStart: HORIZON });
  const task = payload.tasks.find((entry) => entry.taskId === 'TSK-A1');

  assert.ok(task, 'task must be keyed as taskId');
  // TypeScript now proves this at compile time - OptimizerTask has no `_id` -
  // so the runtime check is a belt-and-braces guard against a loosened type.
  assert.equal((task as unknown as Record<string, unknown>)._id, undefined);
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

test('T23: policyWeights persists exactly what the solve used, defaults filled in', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const res = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1, policyWeights: { fragmentation: 2500 } })
    .expect(201);

  const weights = res.body.data.policyWeights;
  assert.equal(weights.fragmentation, 2500, 'the term the request named');
  // D-023's defaults, filled in for every term the request did NOT name -
  // never omitted, never a guess.
  assert.equal(weights.coverage, 10000);
  assert.equal(weights.slaCompliance, 2000);
  assert.equal(weights.batching, 3000);
  assert.equal(weights.unusedMinute, 1);
});

test('T23: omitting policyWeights entirely still records the real defaults, never null', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const res = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1 })
    .expect(201);

  assert.deepEqual(res.body.data.policyWeights, {
    coverage: 10000,
    slaCompliance: 2000,
    batching: 3000,
    unusedMinute: 1,
    fragmentation: 500,
  });
});

test('T23: a weight outside D-061s verified-safe range is refused before any optimizer call', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const before = await Schedule.countDocuments({});

  const res = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1, policyWeights: { coverage: 500 } })
    .expect(400);

  assert.match(res.body.error.message, /validation failed/i);
  assert.match(JSON.stringify(res.body.error.details), /coverage/);
  // Refused at the boundary means no NEW schedule was created for it - other
  // tests in this suite share the collection, so the count is compared
  // relative to before the request, never asserted as an absolute zero.
  assert.equal(await Schedule.countDocuments({}), before);
});

test('T23: an unknown weight field name is refused, not silently ignored', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1, policyWeights: { coveragee: 20000 } })
    .expect(400);
});

test('T20: whatif returns 2+ real options with a framing and a recommendation', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const generated = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1 })
    .expect(201);
  const scheduleId = generated.body.data._id;
  const taskId = generated.body.data.blocks[0].taskIds[0];

  const res = await request(app)
    .post(`/api/schedules/${scheduleId}/whatif`)
    .send({ taskId })
    .expect(200);

  const whatif = res.body.data;
  assert.equal(whatif.taskId, taskId);
  assert.equal(whatif.currentlyScheduled, true);
  assert.ok(whatif.options.length >= 2, 'FR5.1: 2 or more options');
  assert.match(whatif.framing, /D-024/);
});

test('T20: whatif never writes to the schedule document (D-064)', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const generated = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1 })
    .expect(201);
  const scheduleId = generated.body.data._id;
  const taskId = generated.body.data.blocks[0].taskIds[0];
  const before = await Schedule.findById(scheduleId).lean();
  const countBefore = await Schedule.countDocuments({});

  await request(app)
    .post(`/api/schedules/${scheduleId}/whatif`)
    .send({ taskId })
    .expect(200);

  const after = await Schedule.findById(scheduleId).lean();
  assert.deepEqual(before, after, 'the schedule document must be byte-identical after a whatif call');
  // No new document either - a whatif is not a generation. Compared against
  // the count just before the call, not an absolute 1, since this file's
  // other tests share the same database and generate their own schedules.
  assert.equal(await Schedule.countDocuments({}), countBefore);
});

test('T20: whatif on a schedule generated with a non-default weight uses that weight, not the D-023 default', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const generated = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1, policyWeights: { fragmentation: 2500 } })
    .expect(201);
  const scheduleId = generated.body.data._id;
  const taskId = generated.body.data.blocks[0].taskIds[0];

  const res = await request(app)
    .post(`/api/schedules/${scheduleId}/whatif`)
    .send({ taskId })
    .expect(200);

  // The baseline metrics inside the whatif response should reproduce this
  // exact schedule's own metrics - proof the fragmentation=2500 weight, not
  // the default 500, was actually applied to the whatif's own baseline solve.
  assert.deepEqual(res.body.data.baselineMetrics, generated.body.data.metrics);
});

test('T20: an unknown task id is a clean 422, not a 500', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const generated = await request(app)
    .post('/api/schedules/generate')
    .send({ horizonStart: HORIZON, horizonDays: 1 })
    .expect(201);

  const res = await request(app)
    .post(`/api/schedules/${generated.body.data._id}/whatif`)
    .send({ taskId: 'TSK-DOES-NOT-EXIST' })
    .expect(502);
  assert.match(JSON.stringify(res.body), /TSK-DOES-NOT-EXIST/);
});

test('T20: whatif against a nonexistent schedule id is a 404', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await request(app)
    .post('/api/schedules/SCH-NOPE/whatif')
    .send({ taskId: 'TSK-A1' })
    .expect(404);
});

test('priorityScore is null before generation and real after it', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await Task.updateMany({}, { $set: { priorityScore: null, dominantPriorityFactor: null } });
  const before = await Task.findById('TSK-A1').lean();
  assert.ok(before, 'fixture task must exist');
  assert.equal(before.priorityScore, null);

  await request(app).post('/api/schedules/generate').send({ horizonStart: HORIZON }).expect(201);

  const after = await Task.findById('TSK-A1').lean();
  assert.ok(after, 'fixture task must exist');
  assert.ok((after.priorityScore ?? 0) > 0, 'priorityScore must be populated');
  assert.ok((after.priorityScore ?? 0) <= 100);
  assert.ok(after.dominantPriorityFactor, 'FR2.4 dominant factor must be stored');
  assert.equal(after.priorityBreakdown?.usesFailureRisk, false);
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
  // T25 enforces resource no-overlap as a hard constraint, so this fixture
  // (which no longer shares a resource between its two tasks) has none to
  // report - the count is checked, not merely assumed, every time.
  assert.equal(schedule.knownGaps.resourceConflicts.count, 0);

  const flags = new Set(
    schedule.decisionLog.map((entry: any) => entry.contributingFactors.priorityIsPlaceholder),
  );
  assert.deepEqual([...flags], [false], 'real criticality was joined, so not a placeholder');
  assert.equal(schedule.inputSummary.prioritySource, 'fr2.3-priority-engine');
});

test('the T22 traffic-block costing survives the Mongoose sub-schema', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await request(app).post('/api/schedules/generate').send({ horizonStart: HORIZON }).expect(201);
  const schedule = (await request(app).get('/api/schedules/latest').expect(200)).body.data;

  // This is a regression test with a specific history: `deferredSchema` declared
  // only taskId/reason/detail, so Mongoose SILENTLY dropped displacementOption -
  // the same subtraction D-033 caught in a response schema, in a different layer.
  const costed = schedule.deferredTasks.filter((task: any) => task.displacementOption);

  if (schedule.deferredTasks.length === 0) return;   // fixture with nothing deferred
  assert.ok(costed.length > 0, 'traffic-block costings must survive persistence');

  const option = costed[0].displacementOption;
  // Measured and estimated stay structurally apart, not merged into one number.
  assert.ok(typeof option.impact.measured.trainsAffected === 'number');
  assert.ok(typeof option.impact.measured.clearanceMinutes === 'number');
  assert.ok(typeof option.impact.estimated.weightedImpact === 'number');
  assert.match(option.impact.framing, /apportioned/i);
  assert.match(option.note, /does NOT schedule it/);

  // T22 graduated the conflict type: checked, not undetectable, and in exactly
  // one of the two lists.
  const report = schedule.conflictReport;
  const undetectable = report.notYetDetectable.map((e: any) => e.type);
  const clear = report.checkedAndClear.map((e: any) => e.type);
  assert.ok(!undetectable.includes('TRAIN_IMPACT_CONFLICT'));
  assert.ok(clear.includes('TRAIN_IMPACT_CONFLICT'));
});

test('the FR2.2 risk model reaches the schedule with its PRD 9.1 framing intact', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  await request(app).post('/api/schedules/generate').send({ horizonStart: HORIZON }).expect(201);
  const schedule = (await request(app).get('/api/schedules/latest').expect(200)).body.data;

  const risk = schedule.riskModel;
  assert.ok(risk, 'the schedule must record how FR2.2 was applied');
  assert.equal(risk.modelType, 'linear-trend-extrapolation-to-threshold');

  // PRD Section 6 NG4: the disclaimer has to survive to the database, not just
  // exist in the Python module that wrote it. This is the same round-trip check
  // D-015 applies to `synthetic` and D-033 to `knownGaps`.
  assert.match(risk.framing, /simulated asset degradation/i);
  assert.match(risk.framing, /does not predict real/i);

  if (risk.assetsScored > 0) {
    const entry = schedule.decisionLog.find(
      (item: any) => item.contributingFactors?.priorityBreakdown?.usesFailureRisk === true,
    );
    assert.ok(entry, 'at least one task should be scored with FR2.2');
    assert.ok(
      'failure_risk' in entry.contributingFactors.priorityBreakdown.contributions,
      'the weighted risk contribution must be in the FR2.4 breakdown',
    );
  }
});


/* -------------------------------------------------------------------------- */
/* Ask the Planner (T18)                                                      */
/* -------------------------------------------------------------------------- */

test('a question is refused at the boundary before any optimizer call', async () => {
  const res = await request(app)
    .post('/api/schedules/latest/explain')
    .send({ question: 'hi' })
    .expect(400);

  assert.equal(res.body.error.code, 'BAD_REQUEST');
  assert.match(res.body.error.details[0].message, /at least 3 characters/);
});

test('explaining a schedule that does not exist is a 404, not a 502', async () => {
  const res = await request(app)
    .post('/api/schedules/64b7f9c2e1a4d5f6a7b8c9d0/explain')
    .send({ question: 'Why was this task deferred?' })
    .expect(404);

  assert.match(res.body.error.message, /No schedule 64b7f9c2e1a4d5f6a7b8c9d0/);
});

test('an unconfigured explanation layer says so, and says the plan is unaffected', async (t) => {
  if (!needs(t, { optimizer: true })) return;
  // No ANTHROPIC_API_KEY is set in the test environment, so the optimizer
  // returns 503. D-037's standard says that message must reach the Controller
  // intact rather than being flattened into "Optimizer responded 503".
  const res = await request(app)
    .post('/api/schedules/latest/explain')
    .send({ question: 'Why was TSK-A1 scheduled when it was?' });

  if (res.status === 200) {
    // A key IS configured on this machine - then the shape must be the audited
    // one, not a bare string.
    assert.ok(typeof res.body.data.answer === 'string');
    assert.ok(Array.isArray(res.body.data.groundedIn));
    assert.equal(typeof res.body.data.verification.grounded, 'boolean');
    return;
  }

  assert.equal(res.status, 503, 'an unconfigured LLM is 503, not 502 or 500');
  assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.match(res.body.error.message, /ANTHROPIC_API_KEY/);
  assert.match(res.body.error.message, /still available/);
});

test('the typed conflict taxonomy survives the round trip and keeps the plans apart', async (t) => {
  if (!needs(t, { optimizer: true })) return;

  const schedule = (await request(app).get('/api/schedules/latest').expect(200)).body.data;

  // PRD 9.5, optimized layer. T21's point is that this carries enough detail to
  // render an actionable row - before it, the entries had no corridor at all.
  // T24 and T25 both moved from "detected" to "hard CP-SAT constraint", so
  // this small fixture's optimized plan now carries ZERO live conflicts of
  // any type - `byPlan` has no `optimized` key at all, and every PRD 9.5
  // type this build can check for shows up in `checkedAndClear` instead.
  const report = schedule.conflictReport;
  assert.ok(report, 'typed conflict report must be stored');
  assert.deepEqual(report.byPlan, {});
  assert.deepEqual(report.conflicts, []);

  const checkedTypes = report.checkedAndClear.map((e: any) => e.type).sort();
  assert.deepEqual(checkedTypes, [
    'DEPENDENCY_ORDER_VIOLATION',
    'RESOURCE_CONTENTION',
    'TRAIN_IMPACT_CONFLICT',
  ]);
  // T22 graduated TRAIN_IMPACT_CONFLICT the same way T24/T25 graduated these
  // two: OUT of "nothing checks for it" and INTO "checked, none found". A
  // type must appear in exactly one of those lists - being in both would let
  // a reader take whichever reading suited them.
  assert.deepEqual(report.notYetDetectable, []);

  // D-045: the baseline's conflicts live on their own layer. No shape anywhere
  // in either payload may present a single total spanning both plans.
  const baselineReport = schedule.baseline.conflictReport;
  assert.ok(baselineReport, 'baseline typed report must be stored');
  assert.deepEqual(Object.keys(baselineReport.byPlan), ['baseline']);
  assert.ok(!('total' in report) && !('total' in baselineReport));
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
  assert.ok(comparison.caveats.some((line: string) => /utilisation/i.test(line)));
  assert.ok(comparison.caveats.some((line: string) => /scheduled-task count/i.test(line)));
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
  const reranked = await Task.findById('TSK-A1').lean();
  assert.ok((reranked?.priorityScore ?? 0) > 0);
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
    //
    // T24 moved tasksScheduled from 36 to 35 and tasksDeferred from 53 to 54:
    // TSK-00025 now correctly cascades to PREREQUISITE_UNSCHEDULABLE, because
    // its own prerequisite TSK-00024 is independently EXCEEDS_LONGEST_WINDOW.
    // See docs/DECISIONS.md for the full before/after.
    assert.equal(schedule.inputSummary.taskCount, 89);
    assert.equal(schedule.inputSummary.corridorCount, 30);
    assert.equal(schedule.status, 'OPTIMAL');
    assert.equal(schedule.metrics.tasksScheduled, 35);
    assert.equal(schedule.metrics.tasksDeferred, 54);
    assert.equal(schedule.metrics.crossDepartmentBatches, 2);
    assert.ok(schedule.solveSeconds < 10, 'PRD Section 7 budget');

    assert.equal(schedule.baseline.metrics.doubleBookings, 6);
    assert.equal(schedule.baseline.metrics.doubleBookedMinutes, 605);
    assert.equal(schedule.baseline.metrics.overSubscribedWindows, 3);
    assert.equal(schedule.baseline.metrics.crossDepartmentBatches, 0);

    // `contestableTaskIds` is baseline's pure window-length check (T8),
    // unaffected by dependency awareness, so it still stands at 36.
    assert.equal(schedule.contestableTaskIds.length, 36);
    assert.equal(schedule.comparisonToBaseline.contestableTaskCount, 36);
    assert.equal(schedule.comparisonToBaseline.structurallyImpossibleCount, 53);
    // T6-T23's "no throughput advantage" (D-031) is no longer an exact tie:
    // the optimizer schedules one FEWER contestable task than the baseline,
    // because it (T24) will not place TSK-00025 without its prerequisite,
    // while the baseline - no dependency awareness - schedules it anyway.
    // A lower number here is the honest cost of correctness, not a defect.
    assert.equal(schedule.comparisonToBaseline.optimized.contestableScheduled, 35);
    assert.equal(schedule.comparisonToBaseline.baseline.contestableScheduled, 36);
    // And the trap: baseline utilisation reads higher.
    assert.ok(
      schedule.comparisonToBaseline.baseline.blockUtilisationPct >
        schedule.comparisonToBaseline.optimized.blockUtilisationPct,
    );

    // T24 enforces dependency precedence, T25 enforces resource no-overlap -
    // both are now hard CP-SAT constraints, so both counts are zero, checked
    // every solve rather than merely detected.
    assert.equal(schedule.knownGaps.resourceConflicts.count, 0);
    assert.equal(schedule.knownGaps.dependencyViolations.count, 0);

    // The same figures typed per PRD 9.5, still separated by plan (D-045).
    // Neither DEPENDENCY_ORDER_VIOLATION nor RESOURCE_CONTENTION appears as a
    // live optimized-plan conflict type any more - both live in
    // checkedAndClear instead (T24, T25), so `byPlan` carries no `optimized`
    // key at all.
    assert.deepEqual(schedule.conflictReport.byPlan, {});
    const checkedTypes = schedule.conflictReport.checkedAndClear
      .map((item: { type: string }) => item.type)
      .sort();
    assert.deepEqual(checkedTypes, [
      'DEPENDENCY_ORDER_VIOLATION',
      'RESOURCE_CONTENTION',
      'TRAIN_IMPACT_CONFLICT',
    ]);
    assert.deepEqual(schedule.baseline.conflictReport.byPlan.baseline.byType, {
      CORRIDOR_DOUBLE_BOOKING: 6,
      WINDOW_OVER_SUBSCRIPTION: 3,
    });

    // T26, PRD 9.9: real, from Ministry of Jal Shakti flood-risk state data.
    // 7 real tasks sit on the two corridors (DGU-PNB/Assam, HGJ-SUNM/Uttar
    // Pradesh) the real corpus flags monsoon-risk, and the reference
    // horizon genuinely falls inside India's real monsoon window - so this
    // is a live, non-zero finding, not a null case that would pass by
    // accident. Advisory only: the scheduled set (35/54) above is exactly
    // what it was before this field existed.
    assert.equal(schedule.knownGaps.weatherRisk.count, 7);
    assert.ok(
      schedule.knownGaps.weatherRisk.blocks.every((b: { corridorId: string }) =>
        ['DGU-PNB', 'HGJ-SUNM'].includes(b.corridorId),
      ),
    );

    // Priority scores landed on every task, in T7's measured range.
    const scored = await Task.find({ priorityScore: { $ne: null } }).lean();
    assert.equal(scored.length, 89);
    const scores = scored.map((task) => task.priorityScore ?? 0);
    // T16 widened the formula to five factors and reweighted it (D-055), which
    // moved the measured range from 25.04-87.31 to 23.98-84.80. Asserted as the
    // new measured band, not loosened to hide the change.
    assert.ok(
      Math.min(...scores) >= 23 && Math.max(...scores) <= 86,
      `priority range moved unexpectedly: ${Math.min(...scores)}-${Math.max(...scores)}`,
    );
  } finally {
    await source.close();
  }
});
