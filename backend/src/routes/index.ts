/**
 * API surface, mounted by app.ts at /api.
 *
 * One router file per resource (CLAUDE.md convention). The data routes are
 * read-only; the write paths (auth, task submission) arrive with the rest of
 * T10.
 */
import { Router } from 'express';

import healthRouter from './health.js';
import corridorsRouter from './corridors.js';
import assetsRouter from './assets.js';
import tasksRouter from './tasks.js';
import resourcesRouter from './resources.js';
import provenanceRouter from './provenance.js';
import schedulesRouter from './schedules.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/corridors', corridorsRouter);
router.use('/assets', assetsRouter);
router.use('/tasks', tasksRouter);
router.use('/resources', resourcesRouter);
router.use('/provenance', provenanceRouter);
router.use('/schedules', schedulesRouter);

export default router;
