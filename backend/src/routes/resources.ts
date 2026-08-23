/**
 * `/api/resources` - crews, machines and permissions (PRD 9.8).
 *
 * Resources are depot-scoped, so `corridorId` matches against `corridorScope`
 * rather than an equality check - the question being asked is "what can be
 * deployed here", not "what belongs here".
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';

import { Resource, type IResource } from '../models/index.js';
import { validate, validated } from '../middleware/validate.js';
import { departmentParam, listResponse, paginationSchema } from '../utils/query.js';

const router = Router();

const listQuerySchema = paginationSchema.extend({
  corridorId: z.string().min(1).max(64).optional(),
  department: departmentParam.optional(),
  type: z.enum(['crew', 'machine', 'permission']).optional(),
  depot: z.string().min(1).max(16).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

router.get(
  '/',
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit, offset, corridorId, department, type, depot } =
        validated<ListQuery>(req.query);

      const filter: FilterQuery<IResource> = {};
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
  },
);

export default router;
