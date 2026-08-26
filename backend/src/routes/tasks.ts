/**
 * `/api/tasks` - the maintenance backlog (PRD 5.2, FR1.1).
 *
 * `failureRiskScore` comes back null until T16 populates it. Null means "not
 * yet scored", never "scored zero".
 *
 * Every route here already sits behind `requireAuth` (routes/index.ts).
 * `POST /` (FR1.1 submission) is further gated to `dept_engineer` -
 * submitting a defect report is that role's one write action, per the auth
 * session's role table. `POST /reprioritize` is a Controller action (it
 * writes `priorityScore` back onto tasks, the same effect a generation has).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';

import { Asset, Corridor, Resource, Task, type ITask } from '../models/index.js';
import { validate, validated } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
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
  /** Backs the Dept Engineer Portal's "my submitted requests" list (FR1.1). */
  raisedByUserId: z.string().min(1).max(64).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

router.get(
  '/',
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit, offset, corridorId, assetId, department, status, minSeverity, raisedByUserId } =
        validated<ListQuery>(req.query);

      const filter: FilterQuery<ITask> = {};
      if (corridorId) filter.corridorId = corridorId;
      if (assetId) filter.assetId = assetId;
      if (department) filter.department = department;
      if (status) filter.status = status;
      if (minSeverity !== undefined) filter.severity = { $gte: minSeverity };
      if (raisedByUserId) filter.raisedByUserId = raisedByUserId;

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

/**
 * PRD 5.2's severity -> SLA-window mapping, mirrored from
 * `data/generators/config.py`'s `SLA_DAYS_BY_SEVERITY`. Duplicated rather than
 * shared across the Python/TypeScript boundary - the same call D-023's policy
 * weight bounds already made for the same reason (schedules.ts).
 */
const SLA_DAYS_BY_SEVERITY: Record<number, number> = { 5: 30, 4: 30, 3: 60, 2: 90, 1: 90 };

const createTaskSchema = z
  .object({
    corridorId: z.string().min(1).max(64),
    assetId: z.string().min(1).max(64),
    defectType: z.string().trim().min(3).max(120),
    severity: z.coerce.number().int().min(1).max(5),
    estBlockDurationMins: z.coerce.number().int().min(1).max(1440),
    requiredResourceIds: z.array(z.string().min(1).max(64)).max(5).default([]),
    dependsOnTaskId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();
type CreateTaskBody = z.infer<typeof createTaskSchema>;

/** Zero-padded to match the seed's `TSK-00042` style (D-017). */
async function nextTaskId(): Promise<string> {
  const [last] = await Task.find({}).sort({ _id: -1 }).limit(1).lean();
  const lastNumber = last ? Number(last._id.replace(/^TSK-/, '')) : 0;
  const next = (Number.isFinite(lastNumber) ? lastNumber : 0) + 1;
  return `TSK-${String(next).padStart(5, '0')}`;
}

/**
 * POST /api/tasks - FR1.1, the Dept Engineer Portal's request-submission form.
 *
 * `department` and `raisedByUserId` come from the authenticated session, never
 * from the request body - an engineer can only ever file a request as
 * themselves, into their own department's queue.
 */
router.post(
  '/',
  requireRole('dept_engineer'),
  validate({ body: createTaskSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = validated<CreateTaskBody>(req.body);
      const user = req.user!;

      if (!user.department) {
        throw ApiError.badRequest(
          'Your account has no department assigned; task submission requires one.',
        );
      }

      const corridor = await Corridor.findById(body.corridorId).lean();
      if (!corridor) throw ApiError.badRequest(`No corridor ${body.corridorId}`);

      const asset = await Asset.findById(body.assetId).lean();
      if (!asset) throw ApiError.badRequest(`No asset ${body.assetId}`);
      if (asset.corridorId !== body.corridorId) {
        throw ApiError.badRequest(`Asset ${body.assetId} is not on corridor ${body.corridorId}`);
      }
      if (asset.department !== user.department) {
        throw ApiError.forbidden(
          `Asset ${body.assetId} belongs to ${asset.department}, not your department (${user.department})`,
        );
      }

      if (body.requiredResourceIds.length > 0) {
        const foundCount = await Resource.countDocuments({ _id: { $in: body.requiredResourceIds } });
        if (foundCount !== body.requiredResourceIds.length) {
          throw ApiError.badRequest('One or more requiredResourceIds do not exist');
        }
      }

      if (body.dependsOnTaskId) {
        const prerequisite = await Task.findById(body.dependsOnTaskId).lean();
        if (!prerequisite) {
          throw ApiError.badRequest(`dependsOnTaskId ${body.dependsOnTaskId} does not exist`);
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const slaDays = SLA_DAYS_BY_SEVERITY[body.severity] ?? 90;
      const slaDueDate = new Date(Date.now() + slaDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const task = await Task.create({
        _id: await nextTaskId(),
        department: user.department,
        corridorId: body.corridorId,
        assetId: body.assetId,
        defectType: body.defectType,
        severity: body.severity,
        dateRaised: today,
        slaDueDate,
        estBlockDurationMins: body.estBlockDurationMins,
        requiredResourceId: body.requiredResourceIds[0] ?? null,
        requiredResourceIds: body.requiredResourceIds,
        dependsOnTaskId: body.dependsOnTaskId ?? null,
        workflowStage: null,
        priorityScore: null,
        failureRiskScore: null,
        priorityBreakdown: null,
        dominantPriorityFactor: null,
        priorityComputedAt: null,
        status: 'pending',
        // A real request, not generated - see docs/DECISIONS.md D-015's
        // real/synthetic framing, now extended to a third real source.
        synthetic: false,
        raisedByUserId: user.id,
      });

      res.status(201).json({ data: task.toObject() });
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
  requireRole('controller'),
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
