/**
 * `/api/assets` - synthetic physical assets with their FR2.1 criticality score.
 *
 * Records carry `synthetic: true`; the field-level real/synthetic split for the
 * collection is served by `/api/provenance` (D-015).
 */
import { Router } from 'express';
import { z } from 'zod';

import { Asset } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { departmentParam, listResponse, paginationSchema } from '../utils/query.js';

const router = Router();

const listQuerySchema = paginationSchema.extend({
  corridorId: z.string().min(1).max(64).optional(),
  department: departmentParam.optional(),
  assetType: z.enum(['track', 'signal', 'OHE']).optional(),
  minCriticality: z.coerce.number().min(0).max(100).optional(),
});

router.get('/', validate({ query: listQuerySchema }), async (req, res, next) => {
  try {
    const { limit, offset, corridorId, department, assetType, minCriticality } = req.query;

    const filter = {};
    if (corridorId) filter.corridorId = corridorId;
    if (department) filter.department = department;
    if (assetType) filter.assetType = assetType;
    if (minCriticality !== undefined) filter.criticalityScore = { $gte: minCriticality };

    const [data, total] = await Promise.all([
      Asset.find(filter)
        // Most critical first - the ranking FR2.4 asks the UI to surface.
        .sort({ criticalityScore: -1, _id: 1 })
        .skip(offset)
        .limit(limit)
        // The 12-point degradation series is detail-view data; excluding it
        // keeps the list response small.
        .select('-degradationHistory')
        .lean(),
      Asset.countDocuments(filter),
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
      const asset = await Asset.findById(req.params.id).lean();
      if (!asset) throw ApiError.notFound(`No asset ${req.params.id}`);
      res.json({ data: asset });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
