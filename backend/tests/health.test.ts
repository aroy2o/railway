/**
 * Smoke tests for the API shell: health endpoints, the error envelope, and the
 * validation middleware contract.
 *
 * These exist mainly to prove the wiring holds - the real testing effort goes
 * into the CP-SAT solver and the baseline algorithm (CLAUDE.md testing
 * priorities 1-2).
 *
 * The suite is self-contained by design: `npm test` loads tests/.env.test,
 * which points MONGODB_URI at a database that is never connected to and
 * OPTIMIZER_URL at a port nothing listens on. That is what makes the
 * "dependency is down" assertions deterministic rather than depending on
 * whether the developer happens to have those services running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { validate } from '../src/middleware/validate.js';
import { ApiError } from '../src/utils/ApiError.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import express from 'express';

const app = createApp();

test('GET /api/health reports liveness without touching dependencies', async () => {
  const res = await request(app).get('/api/health').expect(200);

  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'backend');
  assert.ok(Number.isInteger(res.body.uptimeSeconds));
});

test('GET /api/health/ready reports 503 while MongoDB is not connected', async () => {
  const res = await request(app).get('/api/health/ready');

  // Tests run without a database, so readiness must fail closed.
  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'not-ready');
  assert.equal(res.body.checks.database.connected, false);
});

test('GET /api/health/dependencies reports a down dependency instead of throwing', async () => {
  // The optimizer is stubbed as unreachable so this exercises the failure path
  // deterministically: a dependency being down must be *reported* as part of a
  // 200 response, never propagated as an error from the health endpoint itself.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
  };
  let res;
  try {
    res = await request(app).get('/api/health/dependencies').expect(200);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.optimizer.reachable, false);
  assert.equal(res.body.checks.optimizer.ready, false);
  assert.equal(res.body.checks.optimizer.solverAvailable, false);
  assert.ok(res.body.checks.optimizer.url.startsWith('http'));
  // The reason is surfaced rather than swallowed, so the UI can say *why*.
  assert.ok(res.body.checks.optimizer.error);
});

test('unknown routes return the standard error envelope, not an HTML page', async () => {
  const res = await request(app).get('/api/does-not-exist').expect(404);

  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.match(res.body.error.message, /No route matches GET/);
});

test('validate() rejects a bad body with per-field details', async () => {
  const probe = express();
  probe.use(express.json());
  probe.post(
    '/probe',
    validate({ body: z.object({ severity: z.coerce.number().int().min(1).max(5) }) }),
    (req, res) => res.json({ severity: req.body.severity }),
  );
  probe.use(errorHandler);

  const bad = await request(probe).post('/probe').send({ severity: 9 }).expect(400);
  assert.equal(bad.body.error.code, 'BAD_REQUEST');
  assert.equal(bad.body.error.details[0].location, 'body');
  assert.equal(bad.body.error.details[0].path, 'severity');

  // On success the coerced value replaces req.body, so handlers see a number.
  const good = await request(probe).post('/probe').send({ severity: '3' }).expect(200);
  assert.strictEqual(good.body.severity, 3);
});

test('ApiError helpers carry status and machine-readable code', () => {
  assert.equal(ApiError.notFound().status, 404);
  assert.equal(ApiError.badGateway().code, 'BAD_GATEWAY');
  assert.equal((ApiError.badRequest('nope', { details: [1] }).details as number[])[0], 1);
});
