/**
 * Load the data pipeline's output (data/processed/*.json) into MongoDB.
 *
 *     npm run seed
 *
 * IDEMPOTENCY STRATEGY: replace, not upsert.
 *
 * Each collection is emptied and reloaded rather than upserted document by
 * document. That is the right choice here specifically because the source
 * files are themselves deterministic and fully regenerable (D-008, D-014): the
 * database is a mirror of them, so it should match them exactly. Upserting
 * would leave orphans behind whenever the generator's seed or CORRIDOR_COUNT
 * changes and the new dataset is smaller - stale tasks pointing at assets that
 * no longer exist is a far worse failure than a slightly slower reload.
 *
 * The reload is scoped to the six source-of-truth collections. It does not
 * touch schedules, decision logs or audit logs, which are produced by the
 * running system rather than by the pipeline.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose, { type Model } from 'mongoose';

import { config } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';
import {
  Asset,
  Corridor,
  CorridorCalendar,
  DatasetProvenance,
  Resource,
  Task,
  type IAsset,
  type ICorridor,
  type ICorridorCalendar,
  type IDatasetProvenance,
  type IResource,
  type ITask,
} from '../models/index.js';

/** insertMany batch size - keeps peak memory bounded on the 47 MB calendar. */
const BATCH_SIZE = 2000;

/**
 * Build every schema-declared index, and wait for it.
 *
 * This is not optional housekeeping. Mongoose's `autoIndex` kicks off index
 * creation in the background when a model is first used, and the seed script
 * closes its connection as soon as the inserts finish - so the builds were
 * being abandoned mid-flight and the collections ended up with nothing but the
 * default `_id` index. The corridors filter then ran as a full collection scan
 * over 10,149 documents while still *appearing* to work, because the result
 * was correct and only the cost was wrong.
 *
 * `syncIndexes` rather than `createIndexes`: it also drops indexes that are no
 * longer declared, which keeps a re-seed after a schema change honest.
 */
async function syncIndexes(models: Record<string, Model<any>>): Promise<void> {
  for (const [label, model] of Object.entries(models)) {
    await model.syncIndexes();
    const built = await model.collection.indexes();
    logger.info(`indexes synced for ${label}`, {
      count: built.length,
      keys: built.map((index) => Object.keys(index.key).join('+')).join(', '),
    });
  }
}

/** The header every processed file carries, plus its record array. */
interface ProcessedFile {
  synthetic?: boolean;
  disclaimer?: string;
  source?: string;
  seed?: number;
  referenceDate?: string;
  fieldProvenance?: unknown;
}

async function loadJson<T extends ProcessedFile>(filename: string): Promise<T> {
  const filePath = path.join(config.paths.processedData, filename);
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${filePath} not found. Build the pipeline first:\n` +
          `  cd data && .venv/bin/python -m ingestion.download\n` +
          `  .venv/bin/python -m ingestion.build_corridors\n` +
          `  .venv/bin/python -m ingestion.build_timetable\n` +
          `  .venv/bin/python -m ingestion.build_seasonal_risk\n` +
          `  .venv/bin/python -m generators.build_synthetic`,
      );
    }
    throw err;
  }
}

/** Empty a collection then bulk-insert, reporting what actually landed. */
async function replaceCollection<T>(
  model: Model<T>,
  documents: T[],
  label: string,
): Promise<number> {
  const removed = await model.deleteMany({});
  for (let index = 0; index < documents.length; index += BATCH_SIZE) {
    await model.insertMany(documents.slice(index, index + BATCH_SIZE), { ordered: true });
  }
  const count = await model.countDocuments();

  if (count !== documents.length) {
    // Never report success on a partial load - a silently short collection
    // would produce a quietly wrong schedule later.
    throw new Error(`${label}: expected ${documents.length} documents, found ${count}`);
  }

  logger.info(`seeded ${label}`, { inserted: count, removedFirst: removed.deletedCount });
  return count;
}

export async function seed(): Promise<{ counts: Record<string, number>; corridorsWithDemand: number }> {
  logger.info('Reading pipeline output', { from: config.paths.processedData });

  await syncIndexes({
    corridors: Corridor,
    corridor_calendar: CorridorCalendar,
    assets: Asset,
    tasks: Task,
    resources: Resource,
    dataset_provenance: DatasetProvenance,
  });

  const corridorsFile = await loadJson<ProcessedFile & { corridors: ICorridor[] }>(
    'corridors.json',
  );
  const calendarFile = await loadJson<ProcessedFile & { calendar: ICorridorCalendar[] }>(
    'corridor_calendar.json',
  );
  const seasonalRiskFile = await loadJson<
    ProcessedFile & { corridorSeasonalRisk: Array<{ _id: string; seasonalRiskFlag: string | null }> }
  >('corridor_seasonal_risk.json');
  const assetsFile = await loadJson<ProcessedFile & { assets: IAsset[] }>('assets.json');
  const tasksFile = await loadJson<ProcessedFile & { tasks: ITask[] }>('tasks.json');
  const resourcesFile = await loadJson<ProcessedFile & { resources: IResource[] }>(
    'resources.json',
  );

  // --- derive the two denormalised fields --------------------------------
  // Which corridors actually carry generated maintenance demand. This is what
  // lets the dashboard ask for ~30 corridors out of 10,149 without a scan.
  const corridorsWithDemand = new Set(assetsFile.assets.map((asset) => asset.corridorId));

  // Scalar occupancy summary, copied onto the corridor so list views can sort
  // and filter on utilisation without loading the window arrays (D-016).
  const summaryById = new Map(
    calendarFile.calendar.map((entry) => [
      entry._id,
      {
        trainsObserved: entry.trainsObserved,
        occupiedMinutes: entry.occupiedMinutes,
        freeMinutes: entry.freeMinutes,
        utilisationPct: entry.utilisationPct,
        blockWindowCount: entry.maxDailyBlockWindows.length,
        lowConfidence: entry.lowConfidence,
      },
    ]),
  );

  // T26: real Ministry of Jal Shakti flood-risk state data, joined by
  // corridor id the same way T3's occupancy summary is (D-016) - a separate
  // real-data stage, not baked into T2's own corridors.json (D-009's reason
  // applies just as much here: `seasonalRiskFlag` needs data T2's own
  // sources do not carry).
  const seasonalRiskById = new Map(
    seasonalRiskFile.corridorSeasonalRisk.map((entry) => [entry._id, entry.seasonalRiskFlag]),
  );

  const corridorDocuments = corridorsFile.corridors.map((corridor) => ({
    ...corridor,
    hasSyntheticDemand: corridorsWithDemand.has(corridor._id),
    occupancySummary: summaryById.get(corridor._id) ?? ({} as ICorridor['occupancySummary']),
    seasonalRiskFlag: seasonalRiskById.get(corridor._id) ?? null,
  }));

  // --- load ---------------------------------------------------------------
  const counts: Record<string, number> = {
    corridors: await replaceCollection(Corridor, corridorDocuments, 'corridors'),
    corridor_calendar: await replaceCollection(
      CorridorCalendar,
      calendarFile.calendar,
      'corridor_calendar',
    ),
    assets: await replaceCollection(Asset, assetsFile.assets, 'assets'),
    tasks: await replaceCollection(Task, tasksFile.tasks, 'tasks'),
    resources: await replaceCollection(Resource, resourcesFile.resources, 'resources'),
  };

  // --- preserve the honesty framing (D-015) -------------------------------
  // The disclaimer and field provenance live in each file's header, not in any
  // record, so without this they would be lost the moment the data entered the
  // database - exactly the failure D-015 exists to prevent.
  const seededAt = new Date();
  const provenance: IDatasetProvenance[] = [
    provenanceDoc('corridors', 'corridors.json', corridorsFile, counts.corridors!, false),
    provenanceDoc(
      'corridor_calendar',
      'corridor_calendar.json',
      calendarFile,
      counts.corridor_calendar!,
      false,
    ),
    provenanceDoc('assets', 'assets.json', assetsFile, counts.assets!, true),
    provenanceDoc('tasks', 'tasks.json', tasksFile, counts.tasks!, true),
    provenanceDoc('resources', 'resources.json', resourcesFile, counts.resources!, true),
    // Not its own collection - denormalised onto `corridors.seasonalRiskFlag`
    // above (D-016) - but the source citation still has to survive the join,
    // the same D-015 reasoning as every other record here.
    provenanceDoc(
      'corridor_seasonal_risk',
      'corridor_seasonal_risk.json',
      seasonalRiskFile,
      seasonalRiskFile.corridorSeasonalRisk.length,
      false,
    ),
  ].map((doc) => ({ ...doc, seededAt }));

  counts.dataset_provenance = await replaceCollection(
    DatasetProvenance,
    provenance,
    'dataset_provenance',
  );

  await verifyRoundTrip(assetsFile, tasksFile);

  return { counts, corridorsWithDemand: corridorsWithDemand.size };
}

function provenanceDoc(
  collection: string,
  sourceFile: string,
  file: ProcessedFile,
  recordCount: number,
  synthetic: boolean,
): Omit<IDatasetProvenance, 'seededAt'> {
  return {
    _id: collection,
    sourceFile,
    synthetic,
    disclaimer: file.disclaimer ?? file.source ?? null,
    seed: file.seed ?? null,
    referenceDate: file.referenceDate ?? null,
    fieldProvenance: (file.fieldProvenance ?? null) as IDatasetProvenance['fieldProvenance'],
    recordCount,
  };
}

/**
 * Read back what was just written and confirm the real/synthetic framing and
 * the real-anchored values survived the round trip.
 *
 * This runs inside the seed rather than only in a test, because the failure it
 * guards against - provenance quietly dropped by a schema change - would
 * otherwise only surface as a missing badge on a dashboard nobody is checking.
 */
async function verifyRoundTrip(
  assetsFile: { assets: IAsset[] },
  tasksFile: { tasks: ITask[] },
): Promise<void> {
  const sampleAsset = assetsFile.assets[0]!;
  const storedAsset = await Asset.findById(sampleAsset._id).lean();
  const storedTask = await Task.findById(tasksFile.tasks[0]!._id).lean();
  const storedProvenance = await DatasetProvenance.findById('assets').lean();

  const problems: string[] = [];

  if (storedAsset?.synthetic !== true) problems.push('asset.synthetic did not survive');
  if (storedTask?.synthetic !== true) problems.push('task.synthetic did not survive');
  if (!storedProvenance?.fieldProvenance?.real) {
    problems.push('fieldProvenance.real missing from dataset_provenance');
  }
  // The two values that must remain REAL, not regenerated (T4 anchoring).
  if (
    storedAsset?.criticality?.trainsAffectedCount !== sampleAsset.criticality.trainsAffectedCount
  ) {
    problems.push('criticality.trainsAffectedCount changed in the round trip');
  }
  if (storedTask?.priorityScore !== null) {
    problems.push('task.priorityScore should still be null until T7 scores it');
  }

  if (problems.length > 0) {
    throw new Error(`Round-trip verification failed:\n  - ${problems.join('\n  - ')}`);
  }

  logger.info('round-trip verified', {
    syntheticFlag: 'preserved',
    fieldProvenance: 'preserved',
    realTrainsAffectedCount: storedAsset!.criticality.trainsAffectedCount,
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await connectDatabase();
  try {
    const { counts, corridorsWithDemand } = await seed();
    logger.info('Seed complete', {
      ...counts,
      corridorsWithSyntheticDemand: corridorsWithDemand,
      seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
    });
  } finally {
    await disconnectDatabase();
  }
}

// Only run when invoked directly, so tests can import seed() without it firing.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === `file://${invokedPath}`) {
  main().catch((err: Error) => {
    logger.error('Seed failed', { message: err.message, stack: err.stack });
    process.exitCode = 1;
    void mongoose.connection.close().catch(() => {});
  });
}
