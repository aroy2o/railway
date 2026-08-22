/**
 * API surface, mounted by app.js at /api.
 *
 * One router file per resource (CLAUDE.md convention). Resource routers -
 * tasks, corridors, assets, schedules, auth - are added here as task T10
 * builds them out.
 */
import { Router } from 'express';
import healthRouter from './health.js';

const router = Router();

router.use('/health', healthRouter);

export default router;
