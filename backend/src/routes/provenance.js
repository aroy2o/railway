/**
 * `/api/provenance` - where every collection's data came from.
 *
 * Implements the delivery half of docs/DECISIONS.md D-015. The disclaimer and
 * the field-level real/synthetic map are generated per file by T4, stored at
 * seed time, and served here so the UI can show a judge exactly which values
 * are measured and which are simulated - the PRD Section 5 requirement reaching
 * the screen rather than stopping at a JSON file.
 */
import { Router } from 'express';

import { DatasetProvenance } from '../models/index.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const data = await DatasetProvenance.find({}).sort({ _id: 1 }).lean();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export default router;
