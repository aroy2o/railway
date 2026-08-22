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
