/**
 * Read-only API route tests (T10 slice).
 *
 * These need a real MongoDB, unlike tests/health.test.js which is deliberately
 * dependency-free. They connect to the throwaway database named in
 * tests/.env.test - never the seeded development one - insert a small hand-built
 * fixture, and skip the whole file if no mongod is reachable, so the suite still
 * passes on a machine without one.
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
  DatasetProvenance,
  Resource,
  Task,
} from '../src/models/index.js';

const app = createApp();
let databaseAvailable = false;

/** Two corridors: one carrying synthetic demand, one not. */
const CORRIDORS = [
  {
    _id: 'AA-BB',
    name: 'ALPHA – BRAVO',
    section: 'AA-BB',
    zone: 'NR',
    stationA: { code: 'AA', name: 'ALPHA' },
    stationB: { code: 'BB', name: 'BRAVO' },
    hasSyntheticDemand: true,
    occupancySummary: { trainsObserved: 120, utilisationPct: 55, blockWindowCount: 2 },
  },
  {
    _id: 'CC-DD',
    name: 'CHARLIE – DELTA',
    section: 'CC-DD',
    zone: 'WR',
    stationA: { code: 'CC', name: 'CHARLIE' },
    stationB: { code: 'DD', name: 'DELTA' },
    hasSyntheticDemand: false,
    occupancySummary: { trainsObserved: 3, utilisationPct: 1.2, blockWindowCount: 9 },
  },
];

before(async () => {
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 1500 });
    databaseAvailable = true;
  } catch {
    return; // every test below skips
  }

  await Promise.all([
    Corridor.deleteMany({}),
    CorridorCalendar.deleteMany({}),
    Asset.deleteMany({}),
    Task.deleteMany({}),
    Resource.deleteMany({}),
    DatasetProvenance.deleteMany({}),
  ]);

  await Corridor.insertMany(CORRIDORS);
  await CorridorCalendar.create({
    _id: 'AA-BB',
    corridorId: 'AA-BB',
    trainsObserved: 120,
    utilisationPct: 55,
    occupiedMinutes: 792,
    freeMinutes: 600,
    maxDailyBlockWindows: [
      { start: '01:00', end: '03:00', startMin: 60, endMin: 180, durationMin: 120 },
    ],
    occupiedWindows: [
      { start: '05:00', end: '06:00', startMin: 300, endMin: 360, durationMin: 60 },
    ],
  });
  await Asset.create({
    _id: 'AST-AA-BB-1',
    corridorId: 'AA-BB',
    assetType: 'signal',
    department: 'S&T',
    criticality: {
      passengerDependency: 0.8,
      alternateRouteAvailable: false,
      safetyImportance: 0.9,
      historicalFailureFreq: 1.2,
      trainsAffectedCount: 120,
    },
    criticalityScore: 84.5,
    dominantCriticalityFactor: 'safety_importance',
    synthetic: true,
  });
  await Task.insertMany([
    {
      _id: 'TSK-00001',
      department: 'S&T',
      corridorId: 'AA-BB',
      assetId: 'AST-AA-BB-1',
      defectType: 'relay fault',
      severity: 4,
      dateRaised: '2026-07-01',
      slaDueDate: '2026-07-31',
      estBlockDurationMins: 90,
      status: 'pending',
      synthetic: true,
    },
    {
      _id: 'TSK-00002',
      department: 'Engineering',
      corridorId: 'AA-BB',
      assetId: 'AST-AA-BB-1',
      defectType: 'rail fracture',
      severity: 2,
      dateRaised: '2026-06-01',
      slaDueDate: '2026-08-30',
      estBlockDurationMins: 180,
      status: 'pending',
      synthetic: true,
    },
  ]);
  await Resource.create({
    _id: 'RES-D01-tower-wagon',
    type: 'machine',
    name: 'Tower Wagon (D01)',
    corridorScope: ['AA-BB', 'CC-DD'],
    department: 'TRD',
    depot: 'D01',
    synthetic: true,
  });
  await DatasetProvenance.create({
    _id: 'assets',
    sourceFile: 'assets.json',
    synthetic: true,
    disclaimer: 'SYNTHETIC DATA. …retrained on real historical asset-health data.',
    seed: 20260822,
    referenceDate: '2026-08-22',
    fieldProvenance: {
      real: { 'criticality.trainsAffectedCount': 'T3 - observed trains per day' },
      synthetic: { degradationHistory: 'simulated' },
      computedDownstream: { 'tasks.priorityScore': 'T7' },
    },
    recordCount: 1,
    seededAt: new Date(),
  });
});

after(async () => {
  if (databaseAvailable) await mongoose.connection.close();
});

/** Marks a test skipped rather than failed when no mongod is present. */
function requireDatabase(t: TestContext): boolean {
  if (!databaseAvailable) {
    t.skip('no MongoDB reachable at MONGODB_URI');
    return false;
  }
  return true;
}

test('the synthetic-demand filter genuinely narrows the corridor set', async (t) => {
  if (!requireDatabase(t)) return;

  const all = await request(app).get('/api/corridors').expect(200);
  const filtered = await request(app)
    .get('/api/corridors?hasSyntheticDemand=true')
    .expect(200);

  assert.equal(all.body.pagination.total, 2);
  assert.equal(filtered.body.pagination.total, 1);
  assert.equal(filtered.body.data[0]._id, 'AA-BB');
});

test('hasSyntheticDemand=false is honoured, not treated as truthy', async (t) => {
  if (!requireDatabase(t)) return;

  // A plain boolean coercion turns the string "false" into true; this asserts
  // the query parser does not make that mistake.
  const res = await request(app).get('/api/corridors?hasSyntheticDemand=false').expect(200);

  assert.equal(res.body.pagination.total, 1);
  assert.equal(res.body.data[0]._id, 'CC-DD');
});

test('corridor detail joins maxDailyBlockWindows from corridor_calendar', async (t) => {
  if (!requireDatabase(t)) return;

  const res = await request(app).get('/api/corridors/AA-BB').expect(200);

  // Stored in a separate collection (D-009/D-016) but presented on the corridor,
  // which is the shape PRD Section 15 describes.
  assert.equal(res.body.data.maxDailyBlockWindows.length, 1);
  assert.equal(res.body.data.maxDailyBlockWindows[0].durationMin, 120);
  assert.equal(res.body.data.occupancy.utilisationPct, 55);
});

test('a missing corridor returns the standard error envelope', async (t) => {
  if (!requireDatabase(t)) return;

  const res = await request(app).get('/api/corridors/NOPE-NOPE').expect(404);

  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('synthetic flag survives the MongoDB round trip on assets and tasks', async (t) => {
  if (!requireDatabase(t)) return;

  const assets = await request(app).get('/api/assets').expect(200);
  const tasks = await request(app).get('/api/tasks').expect(200);

  assert.equal(assets.body.data[0].synthetic, true);
  assert.equal(tasks.body.data[0].synthetic, true);
  // The real-anchored criticality input must come back unchanged.
  assert.equal(assets.body.data[0].criticality.trainsAffectedCount, 120);
});

test('fieldProvenance survives the round trip and is served to the UI', async (t) => {
  if (!requireDatabase(t)) return;

  const res = await request(app).get('/api/provenance').expect(200);
  const assets = res.body.data.find((entry: { _id: string }) => entry._id === 'assets');

  assert.equal(assets.synthetic, true);
  assert.match(assets.disclaimer, /SYNTHETIC DATA/);
  assert.equal(assets.seed, 20260822);
  assert.ok(assets.fieldProvenance.real['criticality.trainsAffectedCount']);
  assert.ok(assets.fieldProvenance.computedDownstream['tasks.priorityScore']);
});

test('tasks filter by corridor, department and status', async (t) => {
  if (!requireDatabase(t)) return;

  const byDept = await request(app).get('/api/tasks?department=S%26T').expect(200);
  assert.equal(byDept.body.pagination.total, 1);
  assert.equal(byDept.body.data[0]._id, 'TSK-00001');

  const byCorridor = await request(app).get('/api/tasks?corridorId=AA-BB').expect(200);
  assert.equal(byCorridor.body.pagination.total, 2);

  const none = await request(app).get('/api/tasks?status=scheduled').expect(200);
  assert.equal(none.body.pagination.total, 0);
});

test('tasks come back with unscored fields null, not zero', async (t) => {
  if (!requireDatabase(t)) return;

  const res = await request(app).get('/api/tasks').expect(200);

  // T7 and T16 populate these. Null must never be read as "scored zero".
  assert.equal(res.body.data[0].priorityScore, null);
  assert.equal(res.body.data[0].failureRiskScore, null);
});

test('resources match on corridorScope, not equality', async (t) => {
  if (!requireDatabase(t)) return;

  // The resource is scoped to two corridors; asking for either must find it.
  const res = await request(app).get('/api/resources?corridorId=CC-DD').expect(200);

  assert.equal(res.body.pagination.total, 1);
  assert.equal(res.body.data[0]._id, 'RES-D01-tower-wagon');
});

test('assets filter by corridorId', async (t) => {
  if (!requireDatabase(t)) return;

  const hit = await request(app).get('/api/assets?corridorId=AA-BB').expect(200);
  const miss = await request(app).get('/api/assets?corridorId=CC-DD').expect(200);

  assert.equal(hit.body.pagination.total, 1);
  assert.equal(miss.body.pagination.total, 0);
});

test('list responses are bounded and paginate', async (t) => {
  if (!requireDatabase(t)) return;

  const res = await request(app).get('/api/tasks?limit=1&offset=0').expect(200);

  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.pagination.hasMore, true);
  assert.equal(res.body.pagination.total, 2);
});

test('invalid query parameters are rejected at the boundary', async (t) => {
  if (!requireDatabase(t)) return;

  // Over the hard cap - guards against an unbounded scan of 10k corridors.
  const overLimit = await request(app).get('/api/corridors?limit=5000').expect(400);
  assert.equal(overLimit.body.error.code, 'BAD_REQUEST');
  assert.equal(overLimit.body.error.details[0].location, 'query');

  await request(app).get('/api/tasks?department=Catering').expect(400);
  await request(app).get('/api/tasks?minSeverity=99').expect(400);
});
