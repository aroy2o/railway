/**
 * `/api/schedules` - generate, list and read block plans.
 *
 * Generation is the orchestration loop: gather from MongoDB, call the optimizer
 * over HTTP, persist the result. Read paths exist so a dashboard (T13) or a
 * comparison screen (T14) can retrieve a plan without re-running the solver.
 *
 * Not in this slice: approval workflow and versioned publishing (FR6, task
 * T19), and manual override (T15). Every generation is stored, so the audit
 * trail those tasks need is already accumulating.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { Schedule } from '../models/index.js';
import { validate, validated } from '../middleware/validate.js';
import { listResponse, paginationSchema, type Pagination } from '../utils/query.js';
import {
  findLatestSchedule,
  findScheduleById,
  generateSchedule,
} from '../services/scheduleOrchestrator.js';
import { explainSchedule } from '../services/explainService.js';
import {
  getEffectivePlan,
  listOverrides,
  listValidTargets,
  recordOverride,
} from '../services/scheduleOverrides.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

const generateSchema = z.object({
  // ISO date the plan starts from. Defaults to today when omitted; pinning it
  // is what makes a run reproducible against a fixed corpus.
  horizonStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'horizonStart must be an ISO date (YYYY-MM-DD)')
    .optional(),
  horizonDays: z.coerce.number().int().min(1).max(90).default(7),
});
type GenerateBody = z.infer<typeof generateSchema>;

/**
 * POST /api/schedules/generate
 *
 * Runs a full generation and returns the persisted schedule. Slow by API
 * standards - it waits on a CP-SAT solve - but bounded by the optimizer's own
 * time limit and this service's OPTIMIZER_TIMEOUT_MS.
 */
router.post(
  '/generate',
  validate({ body: generateSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schedule = await generateSchedule(validated<GenerateBody>(req.body));
      res.status(201).json({ data: schedule });
    } catch (err) {
      // An unreachable or erroring optimizer already arrives as a 502 ApiError
      // from optimizerClient; anything else falls through to the central handler.
      next(err);
    }
  },
);

router.get(
  '/',
  validate({ query: paginationSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit, offset } = validated<Pagination>(req.query);
      const [data, total] = await Promise.all([
        Schedule.find({})
          .sort({ generatedAt: -1 })
          // The heavy fields are detail-view data; a list of plans does not need
          // every block and decision-log entry.
          .select('-blocks -decisionLog -baseline -deferredTasks')
          .skip(offset)
          .limit(limit)
          .lean(),
        Schedule.countDocuments({}),
      ]);
      res.json(listResponse(data, { total, limit, offset }));
    } catch (err) {
      next(err);
    }
  },
);

/** Declared before `/:id` so "latest" is never read as a schedule id. */
router.get('/latest', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const schedule = await findLatestSchedule();
    if (!schedule) {
      throw ApiError.notFound('No schedule has been generated yet. POST /api/schedules/generate');
    }
    // `blocks` stays exactly as the solver produced it - the decision log
    // explains those. `effectivePlan` is that plan with manual overrides
    // replayed on top, which is what a Controller is looking at (D-043).
    const { overrides, effectivePlan } = await getEffectivePlan(schedule._id);
    res.json({ data: { ...schedule, overrides, effectivePlan } });
  } catch (err) {
    next(err);
  }
});

const idParamSchema = z.object({ id: z.string().min(1).max(64) });
type IdParam = z.infer<typeof idParamSchema>;

router.get(
  '/:id',
  validate({ params: idParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const schedule = await findScheduleById(id);
      const { overrides, effectivePlan } = await getEffectivePlan(id);
      res.json({ data: { ...schedule, overrides, effectivePlan } });
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Manual override - FR6.2                                                     */
/* -------------------------------------------------------------------------- */

const overrideSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    action: z.enum(['move', 'defer']),
    targetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'targetDate must be an ISO date (YYYY-MM-DD)')
      .optional(),
    targetWindowIndex: z.coerce.number().int().min(0).max(200).optional(),
    // FR6.2 makes the reason mandatory: an unexplained override is not
    // auditable, and a minimum length keeps "x" from satisfying it.
    reason: z.string().min(8, 'A reason of at least 8 characters is required').max(500),
    actorRole: z.enum(['controller', 'drm']).default('controller'),
  })
  .refine(
    (body) =>
      body.action !== 'move' || (body.targetDate !== undefined && body.targetWindowIndex !== undefined),
    { message: 'A move requires targetDate and targetWindowIndex' },
  );
type OverrideBody = z.infer<typeof overrideSchema>;

const explainSchema = z.object({
  question: z.string().trim().min(3, 'question must be at least 3 characters').max(1000),
});
type ExplainBody = z.infer<typeof explainSchema>;

/**
 * POST /api/schedules/latest/explain - Ask the Planner (FR8.2).
 *
 * Registered before `/:id/explain` so "latest" is never read as an id.
 */
router.post(
  '/latest/explain',
  validate({ body: explainSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { question } = validated<ExplainBody>(req.body);
      res.json({ data: await explainSchedule({ question }) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/schedules/:id/explain
 *
 * A free-text question about one plan, answered strictly from that plan's own
 * records. The response carries what the answer was grounded in, and a
 * verification of every number in it - PRD Section 18 treats an invented figure
 * as the headline risk of this feature, so the check travels with the answer
 * rather than being assumed.
 */
router.post(
  '/:id/explain',
  validate({ params: idParamSchema, body: explainSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const { question } = validated<ExplainBody>(req.body);
      res.json({ data: await explainSchedule({ scheduleId: id, question }) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/schedules/:id/override
 *
 * Move a task to a different free window on its own corridor, or defer it.
 * Re-validated against the same constraints the solver honoured; an invalid
 * move is refused with the specific check that failed, never a generic error.
 */
router.post(
  '/:id/override',
  validate({ params: idParamSchema, body: overrideSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const body = validated<OverrideBody>(req.body);
      const override = await recordOverride({ scheduleId: id, ...body });
      res.status(201).json({ data: override });
    } catch (err) {
      next(err);
    }
  },
);

/** The audit trail for one plan: what was changed, by whom, and why (FR6.2). */
router.get(
  '/:id/overrides',
  validate({ params: idParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      res.json({ data: await listOverrides(id) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Windows a given task could legally move into.
 *
 * Computed with the same validator the write path uses, so the UI can never
 * offer an option that would then be refused.
 */
router.get(
  '/:id/override-targets/:taskId',
  validate({
    params: z.object({
      id: z.string().min(1).max(64),
      taskId: z.string().min(1).max(64),
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, taskId } = validated<{ id: string; taskId: string }>(req.params);
      res.json({ data: await listValidTargets(id, taskId) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
