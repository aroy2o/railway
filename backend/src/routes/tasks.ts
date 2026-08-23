/**
 * `/api/tasks` - the synthetic maintenance backlog (PRD 5.2).
 *
 * `failureRiskScore` comes back null until T16 populates it. Null means "not
 * yet scored", never "scored zero".
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';

import { Task, type ITask } from '../models/index.js';
import { validate, validated } from '../middleware/validate.js';
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
type ListQuery = z.infer<typeof listQuerySchema>;

router.get(
  '/',
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit, offset, corridorId, assetId, department, status, minSeverity } =
        validated<ListQuery>(req.query);

      const filter: FilterQuery<ITask> = {};
      if (corridorId) filter.corridorId = corridorId;
      if (assetId) filter.assetId = assetId;
      if (department) filter.department = department;
      if (status) filter.status = status;
      if (minSeverity !== undefined) filter.severity = { $gte: minSeverity };

      const [data, total] = await Promise.all([
        Task.find(filter)
          // Most severe and soonest-due first. This is NOT the FR2.3 priority
          // ranking - real scores now exist (T10), so this ordering should move
          // to priorityScore server-side; see D-038's follow-up note.
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
  },
);

const reprioritizeSchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be an ISO date (YYYY-MM-DD)')
    .optional(),
});
type ReprioritizeBody = z.infer<typeof reprioritizeSchema>;

/**
 * POST /api/tasks/reprioritize
 *
 * FR2.4 - recompute the ranked queue without running a solve.
 *
 * Generation already refreshes priority scores, so this is not required for the
 * plan to be correct. It exists because the Controller's priority queue (PRD
 * Section 8) is useful on its own, and re-ranking is far cheaper than a CP-SAT
 * run - no reason to make someone wait for a solve to see an updated queue
 * after new defects are logged. See docs/DECISIONS.md D-035.
 */
router.post(
  '/reprioritize',
  validate({ body: reprioritizeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { asOf } = validated<ReprioritizeBody>(req.body);
      const { payload } = await gatherScenario({ horizonStart: asOf });
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

const idParamSchema = z.object({ id: z.string().min(1).max(64) });
type IdParam = z.infer<typeof idParamSchema>;

router.get(
  '/:id',
  validate({ params: idParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const task = await Task.findById(id).lean();
      if (!task) throw ApiError.notFound(`No task ${id}`);
      res.json({ data: task });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
