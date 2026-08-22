/**
 * Service health endpoints.
 *
 * /health       - liveness. Answers as long as the process is up, with no
 *                 dependency checks, so an orchestrator can tell "process dead"
 *                 apart from "dependency down".
 * /health/ready - readiness. 503 unless MongoDB is actually connected.
 * /health/dependencies
 *               - end-to-end wiring probe: reports MongoDB and the Python
 *                 optimizer in one call, so the dashboard can show which link
 *                 of the chain is broken instead of a generic failure.
 */
import { Router } from 'express';
import { databaseStatus } from '../config/db.js';
import { config } from '../config/env.js';
import { checkOptimizerHealth } from '../services/optimizerClient.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'backend',
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

router.get('/ready', (_req, res) => {
  const database = databaseStatus();
  const ready = database.connected;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    checks: { database },
    timestamp: new Date().toISOString(),
  });
});

router.get('/dependencies', async (_req, res, next) => {
  try {
    const [database, optimizer] = [databaseStatus(), await checkOptimizerHealth()];

    res.json({
      status: database.connected && optimizer.ready ? 'ok' : 'degraded',
      checks: { database, optimizer },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // checkOptimizerHealth never throws, but a future check here might - route
    // the error into the central handler rather than letting it escape async.
    next(err);
  }
});

export default router;
