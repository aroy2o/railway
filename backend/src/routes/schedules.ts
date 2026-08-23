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
    res.json({ data: schedule });
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
      res.json({ data: await findScheduleById(id) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
