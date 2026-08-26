/**
 * `/api/schedules` - generate, list and read block plans.
 *
 * Generation is the orchestration loop: gather from MongoDB, call the optimizer
 * over HTTP, persist the result. Read paths exist so a dashboard (T13) or a
 * comparison screen (T14) can retrieve a plan without re-running the solver.
 *
 * The FR6.1 approval workflow wraps these: a generated plan is a `draft`, and
 * `POST /:id/workflow` walks it through review, approval and publication. The
 * state is never stored on the schedule document - it is a fold over the
 * append-only `schedule_approvals` rows (D-057).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { Schedule } from '../models/index.js';
import { validate, validated } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { listResponse, paginationSchema, type Pagination } from '../utils/query.js';
import {
  findLatestSchedule,
  findScheduleById,
  generateSchedule,
} from '../services/scheduleOrchestrator.js';
import { explainSchedule } from '../services/explainService.js';
import { runWhatIf } from '../services/whatIfService.js';
import { runEmergencyReoptimization } from '../services/emergencyService.js';
import {
  findPublishedSchedule,
  getAuditTrail,
  getWorkflowState,
  listApprovals,
  recordTransition,
  workflowStates,
} from '../services/scheduleApprovals.js';
import { allowedActions } from '../services/approvalEngine.js';
import {
  getEffectivePlan,
  listOverrides,
  listValidTargets,
  recordOverride,
} from '../services/scheduleOverrides.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

/**
 * T23's policy sliders (PRD 13.1). Bounds are the SAME range D-061 verified
 * safe on the real corpus - duplicated here (a simple numeric range, not
 * complex logic) so an out-of-range slider is refused immediately with a
 * specific reason, rather than round-tripping to the optimizer for the same
 * answer. The optimizer's own validation stays authoritative regardless: this
 * is a fast-fail convenience, not the source of truth.
 */
const policyWeightsSchema = z
  .object({
    coverage: z.coerce.number().int().min(1000).max(100_000).optional(),
    slaCompliance: z.coerce.number().int().min(200).max(20_000).optional(),
    batching: z.coerce.number().int().min(300).max(30_000).optional(),
    unusedMinute: z.coerce.number().int().min(1).max(10).optional(),
    fragmentation: z.coerce.number().int().min(50).max(5_000).optional(),
  })
  // zod silently STRIPS unknown keys by default. A typo'd slider name -
  // `coveragee` for `coverage` - would then be dropped and the request would
  // proceed as if no override had been requested at all: the Controller sees
  // 201 and believes their change was applied when nothing happened. `.strict()`
  // turns that into a 400 naming the field, the same "refuse, don't silently
  // reinterpret" rule PRD Section 6 already applies everywhere else.
  .strict()
  .optional();

const generateSchema = z.object({
  // ISO date the plan starts from. Defaults to today when omitted; pinning it
  // is what makes a run reproducible against a fixed corpus.
  horizonStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'horizonStart must be an ISO date (YYYY-MM-DD)')
    .optional(),
  horizonDays: z.coerce.number().int().min(1).max(90).default(7),
  policyWeights: policyWeightsSchema,
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
  requireRole('controller'),
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
  requireRole('controller', 'drm'),
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
      // FR6.3's version history is this list, so each row carries its workflow
      // state. Fetched in one query for the whole page rather than per row.
      const states = await workflowStates(data.map((schedule) => schedule._id));
      res.json(
        listResponse(
          data.map((schedule) => ({ ...schedule, workflowState: states.get(schedule._id) })),
          { total, limit, offset },
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

/** Declared before `/:id` so "latest" is never read as a schedule id. */
router.get(
  '/latest',
  requireRole('controller', 'drm'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const schedule = await findLatestSchedule();
      if (!schedule) {
        throw ApiError.notFound('No schedule has been generated yet. POST /api/schedules/generate');
      }
      // `blocks` stays exactly as the solver produced it - the decision log
      // explains those. `effectivePlan` is that plan with manual overrides
      // replayed on top, which is what a Controller is looking at (D-043).
      const { overrides, effectivePlan } = await getEffectivePlan(schedule._id);
      const workflowState = await getWorkflowState(schedule._id);
      res.json({
        data: {
          ...schedule,
          overrides,
          effectivePlan,
          workflowState,
          allowedActions: allowedActions(workflowState),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/schedules/published - the plan currently in force (FR6.3).
 *
 * Deliberately a different query from `/latest`. Generating a new plan does not
 * retract the published one: `/latest` is the newest plan, this is the one
 * crews are working to, and PRD Section 8 gives department engineers a
 * read-only view of exactly this. Declared before `/:id` for the same reason
 * `/latest` is.
 */
router.get('/published', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const published = await findPublishedSchedule();
    if (!published) {
      throw ApiError.notFound(
        'No plan has been published yet. Approve and publish a plan first (FR6.1).',
      );
    }
    const schedule = await findScheduleById(published.scheduleId);
    const { overrides, effectivePlan } = await getEffectivePlan(published.scheduleId);
    res.json({
      data: {
        ...schedule,
        overrides,
        effectivePlan,
        version: published.version,
        publishedAt: published.publishedAt,
        workflowState: 'published',
      },
    });
  } catch (err) {
    next(err);
  }
});

const idParamSchema = z.object({ id: z.string().min(1).max(64) });
type IdParam = z.infer<typeof idParamSchema>;

router.get(
  '/:id',
  requireRole('controller', 'drm'),
  validate({ params: idParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const schedule = await findScheduleById(id);
      const { overrides, effectivePlan } = await getEffectivePlan(id);
      const workflowState = await getWorkflowState(id);
      res.json({
        data: {
          ...schedule,
          overrides,
          effectivePlan,
          workflowState,
          allowedActions: allowedActions(workflowState),
        },
      });
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
  requireRole('controller'),
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
  requireRole('controller'),
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

const whatIfSchema = z.object({
  taskId: z.string().min(1).max(64),
});
type WhatIfBody = z.infer<typeof whatIfSchema>;

/**
 * POST /api/schedules/:id/whatif - FR5, 9.4.
 *
 * A real re-solve of the real CP-SAT model with one task's placement forced,
 * using the current backlog and this schedule's own objective weights.
 * Nothing here is persisted (D-064): the response is the entire effect of
 * the call.
 */
router.post(
  '/:id/whatif',
  requireRole('controller'),
  validate({ params: idParamSchema, body: whatIfSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const { taskId } = validated<WhatIfBody>(req.body);
      res.json({ data: await runWhatIf({ scheduleId: id, taskId }) });
    } catch (err) {
      next(err);
    }
  },
);

const emergencySchema = z.object({
  corridorId: z.string().min(1).max(64),
  // At least one: an emergency re-solve with nothing disrupted is not a real
  // request - matches the optimizer's own `min_length=1` on the same field.
  disruptedWindows: z
    .array(
      z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be an ISO date (YYYY-MM-DD)'),
        windowIndex: z.coerce.number().int().min(0).max(200),
      }),
    )
    .min(1),
  // FR6.2's mandatory-reason discipline, applied here too: this commits.
  reason: z.string().min(8, 'A reason of at least 8 characters is required').max(500),
});
type EmergencyBody = z.infer<typeof emergencySchema>;

/**
 * POST /api/schedules/:id/emergency - FR3.5, PRD 9.10.
 *
 * "Simulate an emergency block request": re-solves ONE corridor's remaining
 * time around a disruption that has consumed one or more of its windows,
 * holding every other corridor and everything already executed on this one
 * exactly fixed. Unlike /whatif, this COMMITS - the response is a newly
 * PERSISTED schedule (D-034), not a disposable hypothetical (D-064).
 */
router.post(
  '/:id/emergency',
  requireRole('controller'),
  validate({ params: idParamSchema, body: emergencySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const body = validated<EmergencyBody>(req.body);
      const schedule = await runEmergencyReoptimization({ scheduleId: id, ...body });
      res.status(201).json({ data: schedule });
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
  requireRole('controller'),
  validate({ params: idParamSchema, body: overrideSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const body = validated<OverrideBody>(req.body);
      // `actorRole` predates real auth and was a client-asserted field
      // (default 'controller', never actually checked against anything). Now
      // that a verified identity exists, the audit trail records the real
      // authenticated role (normally 'controller', or 'super_admin' when the
      // bypass role used this route) rather than trusting what the request
      // body claims.
      const override = await recordOverride({ scheduleId: id, ...body, actorRole: req.user!.role });
      res.status(201).json({ data: override });
    } catch (err) {
      next(err);
    }
  },
);

/** The audit trail for one plan: what was changed, by whom, and why (FR6.2). */
router.get(
  '/:id/overrides',
  requireRole('controller', 'drm'),
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
  requireRole('controller'),
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

/* -------------------------------------------------------------------------- */
/* Approval workflow - FR6.1, FR6.3                                            */
/* -------------------------------------------------------------------------- */

const workflowSchema = z
  .object({
    action: z.enum(['submit', 'approve', 'reject', 'publish']),
    // Free-text on every action, and MANDATORY on reject - the same call FR6.2
    // made for an override. A rejection with no stated reason tells the next
    // reader that a plan was refused and nothing about why, which is the one
    // thing an audit trail exists to answer.
    reason: z.string().trim().max(500).optional(),
    actorRole: z.enum(['controller', 'drm']).default('controller'),
  })
  .refine((body) => body.action !== 'reject' || (body.reason ?? '').length >= 8, {
    message: 'Rejecting a plan requires a reason of at least 8 characters',
    path: ['reason'],
  });
type WorkflowBody = z.infer<typeof workflowSchema>;

/**
 * POST /api/schedules/:id/workflow
 *
 * One route for the whole FR6.1 chain rather than four near-identical ones: the
 * interesting behaviour is the transition TABLE, and splitting it across routes
 * would put the guard in four places. An illegal transition is refused with the
 * state it was attempted from and the actions that are legal there.
 */
router.post(
  '/:id/workflow',
  requireRole('controller'),
  validate({ params: idParamSchema, body: workflowSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      const body = validated<WorkflowBody>(req.body);
      // Same reasoning as the override route above: record the real
      // authenticated role rather than the client-asserted default.
      const approval = await recordTransition({ scheduleId: id, ...body, actorRole: req.user!.role });
      res.status(201).json({ data: approval });
    } catch (err) {
      next(err);
    }
  },
);

/** The approval/rejection history alone. The merged trail is `/:id/audit`. */
router.get(
  '/:id/approvals',
  requireRole('controller', 'drm'),
  validate({ params: idParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      res.json({ data: await listApprovals(id) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/schedules/:id/audit - PRD Section 8 screen 5, FR6.2, FR6.3.
 *
 * Who or what generated the plan, every override with its reason and
 * re-validation result, and the approval history - one time-ordered list. The
 * two record kinds keep their own collections and are merged here, because they
 * are one narrative and two shapes (D-057).
 */
router.get(
  '/:id/audit',
  requireRole('controller', 'drm'),
  validate({ params: idParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = validated<IdParam>(req.params);
      res.json({ data: await getAuditTrail(id) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
