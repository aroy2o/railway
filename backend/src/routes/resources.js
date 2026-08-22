/**
 * `/api/resources` - crews, machines and permissions (PRD 9.8).
 *
 * Resources are depot-scoped, so `corridorId` matches against `corridorScope`
 * rather than an equality check - the question being asked is "what can be
 * deployed here", not "what belongs here".
 */
import { Router } from 'express';
import { z } from 'zod';

import { Resource } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { departmentParam, listResponse, paginationSchema } from '../utils/query.js';

const router = Router();

const listQuerySchema = paginationSchema.extend({
  corridorId: z.string().min(1).max(64).optional(),
  department: departmentParam.optional(),
  type: z.enum(['crew', 'machine', 'permission']).optional(),
  depot: z.string().min(1).max(16).optional(),
});

router.get('/', validate({ query: listQuerySchema }), async (req, res, next) => {
  try {
    const { limit, offset, corridorId, department, type, depot } = req.query;

    const filter = {};
    if (corridorId) filter.corridorScope = corridorId; // array-contains match
    if (department) filter.department = department;
    if (type) filter.type = type;
    if (depot) filter.depot = depot;

    const [data, total] = await Promise.all([
      Resource.find(filter).sort({ depot: 1, type: 1, _id: 1 }).skip(offset).limit(limit).lean(),
      Resource.countDocuments(filter),
    ]);

    res.json(listResponse(data, { total, limit, offset }));
  } catch (err) {
    next(err);
  }
});

export default router;
