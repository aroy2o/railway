/**
 * API surface, mounted by app.ts at /api.
 *
 * One router file per resource (CLAUDE.md convention).
 *
 * `/health` and `/auth/login` are the only public routes - everything else
 * requires a valid JWT (FR10.2), enforced once here rather than per file, so
 * no future route can be added without auth by accident. Role gating beyond
 * "authenticated" (FR10.1) is then applied per-route inside each resource
 * router, where the specific action being gated is visible.
 */
import { Router } from 'express';

import healthRouter from './health.js';
import authRouter from './auth.js';
import corridorsRouter from './corridors.js';
import assetsRouter from './assets.js';
import tasksRouter from './tasks.js';
import resourcesRouter from './resources.js';
import provenanceRouter from './provenance.js';
import schedulesRouter from './schedules.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);

// `requireAuth` is mounted per sub-router rather than once for the whole
// `/api` prefix, so a request to a path that matches NONE of them still falls
// through to app.ts's notFoundHandler (a 404) instead of being shadowed by a
// 401 for a route that was never going to exist either way.
router.use('/corridors', requireAuth, corridorsRouter);
router.use('/assets', requireAuth, assetsRouter);
router.use('/tasks', requireAuth, tasksRouter);
router.use('/resources', requireAuth, resourcesRouter);
router.use('/provenance', requireAuth, provenanceRouter);
router.use('/schedules', requireAuth, schedulesRouter);

export default router;
