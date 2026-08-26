/**
 * FR10 - JWT auth and role gating.
 *
 * Three layers, cheapest first: the pure crypto helpers (bcrypt round trip,
 * JWT sign/verify), the `requireAuth`/`requireRole` middleware in isolation
 * (including the super_admin bypass - the one thing this design is most
 * likely to get subtly wrong), then one full HTTP loop per real role hitting
 * a route actually gated to it.
 *
 * Uses its own database (see docs/DECISIONS.md D-018's neighbour note in
 * schedules.test.ts on why: `node --test` runs files in parallel, so a shared
 * database lets one file's fixture wipe another's mid-run).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';

import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { User } from '../src/models/index.js';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/services/authTokens.js';
import { requireAuth, requireRole } from '../src/middleware/auth.js';
import { seedUsers, DEMO_ACCOUNTS } from '../src/scripts/seed.js';

const app = createApp();

/** A database of this file's own; see the note at the top. */
const TEST_DB_URI = config.mongoUri.replace(/(\/[^/?]+)(\?|$)/, '$1_auth$2');

let databaseAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 1500 });
    databaseAvailable = true;
  } catch {
    return;
  }
  await User.deleteMany({});
  await seedUsers();
});

after(async () => {
  if (databaseAvailable) await mongoose.connection.close();
});

/* -------------------------------------------------------------------------- */
/* Pure crypto helpers - no I/O                                                */
/* -------------------------------------------------------------------------- */

void test('hashPassword/verifyPassword round-trips correctly', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

void test('two hashes of the same password differ (salted)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
});

void test('signToken/verifyToken round-trips the payload', () => {
  const token = signToken({
    sub: 'USR-1',
    username: 'controller',
    role: 'controller',
    department: null,
    name: 'Controller (demo)',
  });
  const payload = verifyToken(token);
  assert.ok(payload);
  assert.equal(payload?.sub, 'USR-1');
  assert.equal(payload?.role, 'controller');
});

void test('verifyToken rejects a malformed token', () => {
  assert.equal(verifyToken('not-a-real-token'), null);
});

void test('verifyToken rejects a token signed with a different secret', () => {
  // A hand-rolled sign with jsonwebtoken directly, bypassing config.jwt.secret.
  const foreign = jwt.sign({ sub: 'X' }, 'a-completely-different-secret-value');
  assert.equal(verifyToken(foreign), null);
});

/* -------------------------------------------------------------------------- */
/* Middleware, in isolation - no HTTP, no database                             */
/* -------------------------------------------------------------------------- */

function fakeReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

void test('requireAuth rejects a missing Authorization header', () => {
  let calledWith: unknown;
  requireAuth(fakeReq(), {} as Response, (err) => {
    calledWith = err;
  });
  assert.ok(calledWith);
  assert.equal((calledWith as { status: number }).status, 401);
});

void test('requireAuth rejects a non-Bearer header', () => {
  let calledWith: unknown;
  requireAuth(fakeReq({ authorization: 'Basic abc123' }), {} as Response, (err) => {
    calledWith = err;
  });
  assert.equal((calledWith as { status: number }).status, 401);
});

void test('requireAuth rejects an invalid token', () => {
  let calledWith: unknown;
  requireAuth(fakeReq({ authorization: 'Bearer garbage' }), {} as Response, (err) => {
    calledWith = err;
  });
  assert.equal((calledWith as { status: number }).status, 401);
});

void test('requireAuth attaches req.user on a valid token', () => {
  const token = signToken({
    sub: 'USR-2',
    username: 'engineer',
    role: 'dept_engineer',
    department: 'Engineering',
    name: 'Dept Engineer (demo)',
  });
  const req = fakeReq({ authorization: `Bearer ${token}` });
  let nextCalledCleanly = false;
  requireAuth(req, {} as Response, (err) => {
    nextCalledCleanly = err === undefined;
  });
  assert.equal(nextCalledCleanly, true);
  assert.equal(req.user?.role, 'dept_engineer');
  assert.equal(req.user?.department, 'Engineering');
});

void test('requireRole passes when the role matches', () => {
  const req = fakeReq();
  req.user = { id: 'U', username: 'c', role: 'controller', department: null, name: 'C' };
  let calledWith: unknown = 'not-called';
  requireRole('controller', 'drm')(req, {} as Response, (err) => {
    calledWith = err;
  });
  assert.equal(calledWith, undefined);
});

void test('requireRole refuses when the role does not match', () => {
  const req = fakeReq();
  req.user = { id: 'U', username: 'e', role: 'dept_engineer', department: 'Engineering', name: 'E' };
  let calledWith: unknown;
  requireRole('controller', 'drm')(req, {} as Response, (err) => {
    calledWith = err;
  });
  assert.equal((calledWith as { status: number }).status, 403);
});

void test('requireRole: super_admin bypasses ANY role list - the one explicit check', () => {
  const req = fakeReq();
  req.user = { id: 'U', username: 'a', role: 'super_admin', department: null, name: 'A' };
  let calledWith: unknown = 'not-called';
  // A role list that does not even mention super_admin - the bypass must not
  // depend on it being listed.
  requireRole('controller', 'drm', 'dept_engineer')(req, {} as Response, (err) => {
    calledWith = err;
  });
  assert.equal(calledWith, undefined);
});

/* -------------------------------------------------------------------------- */
/* HTTP loop - login, then one gated route per real role                       */
/* -------------------------------------------------------------------------- */

async function loginAs(username: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.token as string;
}

void test('POST /api/auth/login: unknown username is refused with the same message as a wrong password', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const unknown = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'x' });
  const wrongPassword = await request(app)
    .post('/api/auth/login')
    .send({ username: DEMO_ACCOUNTS[0]!.username, password: 'definitely-wrong' });
  assert.equal(unknown.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknown.body.error.message, wrongPassword.body.error.message);
});

void test('GET /api/corridors without a token is 401', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const res = await request(app).get('/api/corridors');
  assert.equal(res.status, 401);
});

void test('dept_engineer: can log in and reach an authenticated-only route', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const token = await loginAs('engineer', 'engineer123');
  const res = await request(app).get('/api/corridors?limit=1').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
});

void test('dept_engineer: refused on a controller-only route (POST /api/schedules/generate)', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const token = await loginAs('engineer', 'engineer123');
  const res = await request(app)
    .post('/api/schedules/generate')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(res.status, 403);
});

void test('controller: can log in and reach a controller+drm route (GET /api/schedules)', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const token = await loginAs('controller', 'controller123');
  const res = await request(app).get('/api/schedules').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
});

void test('controller: refused on the dept_engineer-only submission route', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const token = await loginAs('controller', 'controller123');
  const res = await request(app).post('/api/tasks').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(res.status, 403);
});

void test('drm: can log in and reach a controller+drm route, refused on a controller-only one', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const token = await loginAs('drm', 'drm123');
  const readable = await request(app).get('/api/schedules').set('Authorization', `Bearer ${token}`);
  assert.equal(readable.status, 200);

  const writeOnly = await request(app)
    .post('/api/schedules/generate')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(writeOnly.status, 403);
});

void test('super_admin: reaches routes gated to every other role, including dept_engineer-only', async (t) => {
  if (!databaseAvailable) return t.skip('MongoDB not reachable');
  const token = await loginAs('admin', 'admin123');

  const controllerRoute = await request(app).get('/api/schedules').set('Authorization', `Bearer ${token}`);
  assert.equal(controllerRoute.status, 200);

  // A dept_engineer-only route still validates its body, so a bad payload is
  // a 400 - but that IS the proof the bypass worked: a non-bypassed role gets
  // 403 before validation ever runs (see the controller test above).
  const engineerRoute = await request(app).post('/api/tasks').set('Authorization', `Bearer ${token}`).send({});
  assert.notEqual(engineerRoute.status, 403);
});
