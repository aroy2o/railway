/**
 * `/api/tasks` - the synthetic maintenance backlog (PRD 5.2).
 *
 * `priorityScore` and `failureRiskScore` come back null until T7 and T16
 * populate them. Null means "not yet scored", never "scored zero".
 */
import { Router } from 'express';
import { z } from 'zod';

import { Task } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { departmentParam, listResponse, paginationSchema } from '../utils/query.js';
import { gatherScenario } from '../services/scheduleGathering.js';
import { requestPriorityQueue } from '../services/optimizerClient.js';
import { persistPriorityScores } from '../services/scheduleOrchestrator.js';

const router = Router();

const listQuerySchema = paginationSchema.extend({
  corridorId: z.string().min(1).max(64).optional(),
  assetId: z.string().min(1).max(64).optional(),
  department: departmentParam.optional(),
  status: z.enum(['pending', 'scheduled', 'deferred']).optional(),
  minSeverity: z.coerce.number().int().min(1).max(5).optional(),
});

router.get('/', validate({ query: listQuerySchema }), async (req, res, next) => {
  try {
    const { limit, offset, corridorId, assetId, department, status, minSeverity } = req.query;

    const filter = {};
    if (corridorId) filter.corridorId = corridorId;
    if (assetId) filter.assetId = assetId;
    if (department) filter.department = department;
    if (status) filter.status = status;
    if (minSeverity !== undefined) filter.severity = { $gte: minSeverity };

    const [data, total] = await Promise.all([
      Task.find(filter)
        // Most severe and soonest-due first. This is NOT the FR2.3 priority
        // ranking - that needs the priority engine (T7) and will replace this
        // ordering once scores exist.
        .sort({ severity: -1, slaDueDate: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Task.countDocuments(filter),
    ]);

    res.json(listResponse(data, { total, limit, offset }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tasks/reprioritize
 *
 * FR2.4 - recompute the ranked queue without running a solve.
 *
 * Generation already refreshes priority scores, so this is not required for the
 * plan to be correct. It exists because the Controller's priority queue (PRD
 * Section 8) is useful on its own, and re-ranking is far cheaper than a CP-SAT
 * run - no reason to make someone wait for a solve to see an updated queue
 * after new defects are logged. See docs/DECISIONS.md D-034.
 */
router.post(
  '/reprioritize',
  validate({
    body: z.object({
      asOf: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be an ISO date (YYYY-MM-DD)')
        .optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { payload } = await gatherScenario({ horizonStart: req.body.asOf });
      const queue = await requestPriorityQueue({
        tasks: payload.tasks,
        asOf: payload.horizonStart,
      });
      const updated = await persistPriorityScores(queue.queue);

      res.json({
        data: {
          asOf: queue.asOf,
          ranked: queue.count,
          tasksUpdated: updated,
          topTaskIds: queue.queue.slice(0, 5).map((entry) => entry.taskId),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:id',
  validate({ params: z.object({ id: z.string().min(1).max(64) }) }),
  async (req, res, next) => {
    try {
      const task = await Task.findById(req.params.id).lean();
      if (!task) throw ApiError.notFound(`No task ${req.params.id}`);
      res.json({ data: task });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
