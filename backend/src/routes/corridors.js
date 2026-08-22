/**
 * `/api/corridors` - real corridor sections (T2) with their occupancy summary.
 *
 * Read-only. Write paths arrive with the full T10 CRUD slice.
 */
import { Router } from 'express';
import { z } from 'zod';

import { Corridor, CorridorCalendar } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { booleanParam, listResponse, paginationSchema } from '../utils/query.js';

const router = Router();

const listQuerySchema = paginationSchema.extend({
  /**
   * The filter that makes the dashboard viable. Only ~30 of the 10,149 real
   * sections carry generated maintenance demand, and `hasSyntheticDemand` is
   * indexed, so this is an index lookup rather than a collection scan.
   */
  hasSyntheticDemand: booleanParam.optional(),
  zone: z.string().min(1).max(10).optional(),
  search: z.string().min(1).max(64).optional(),
});

router.get('/', validate({ query: listQuerySchema }), async (req, res, next) => {
  try {
    const { limit, offset, hasSyntheticDemand, zone, search } = req.query;

    const filter = {};
    if (hasSyntheticDemand !== undefined) filter.hasSyntheticDemand = hasSyntheticDemand;
    if (zone) filter.zone = zone;
    if (search) {
      // Escaped so a user-supplied regex character cannot alter the query.
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ _id: new RegExp(safe, 'i') }, { name: new RegExp(safe, 'i') }];
    }

    const [data, total] = await Promise.all([
      Corridor.find(filter)
        .sort({ 'occupancySummary.utilisationPct': -1, _id: 1 })
        .skip(offset)
        .limit(limit)
        // Window arrays deliberately excluded - they live in corridor_calendar
        // and would make a list request drag megabytes it never renders.
        .lean(),
      Corridor.countDocuments(filter),
    ]);

    res.json(listResponse(data, { total, limit, offset }));
  } catch (err) {
    next(err);
  }
});

const idParamSchema = z.object({ id: z.string().min(1).max(64) });

router.get('/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const corridor = await Corridor.findById(req.params.id).lean();
    if (!corridor) throw ApiError.notFound(`No corridor ${req.params.id}`);

    // Joined on read rather than embedded - see docs/DECISIONS.md D-016.
    const calendar = await CorridorCalendar.findById(req.params.id).lean();

    res.json({
      data: {
        ...corridor,
        // PRD Section 15 puts this field on the corridor. It is stored in
        // corridor_calendar and surfaced here, so the API still presents the
        // shape the PRD describes.
        maxDailyBlockWindows: calendar?.maxDailyBlockWindows ?? [],
        occupancy: calendar
          ? {
              trainsObserved: calendar.trainsObserved,
              trainClassMix: calendar.trainClassMix,
              occupiedMinutes: calendar.occupiedMinutes,
              freeMinutes: calendar.freeMinutes,
              utilisationPct: calendar.utilisationPct,
              transitWindows: calendar.transitWindows,
              lowConfidence: calendar.lowConfidence,
              lowConfidenceReasons: calendar.lowConfidenceReasons,
              occupiedWindows: calendar.occupiedWindows,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
