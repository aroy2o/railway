/**
 * Reset the database to the exact state a judge should see right before
 * "Generate schedule" is clicked for the first time: real pipeline data
 * freshly loaded, four working demo logins, and zero schedule history.
 *
 *     npm run demo:reset
 *
 * TX3, cross-cutting housekeeping - no PRD FR maps to this.
 *
 * Deliberately NOT folded into seed.ts. Dev sessions rely on `npm run seed`
 * staying pipeline-only and fast (D-019): it reloads six source-of-truth
 * collections and explicitly does not touch runtime output. This script is
 * additive, demo-day-only tooling built on top of it: it reuses seed()'s and
 * seedUsers()'s exact logic unchanged, then explicitly empties the three
 * collections the pipeline seed intentionally skips - `schedules`,
 * `schedule_overrides` and `schedule_approvals` (the append-only audit-log
 * split from D-057) - which accumulate across every dev session's testing.
 * Left alone, a judge opening the Approval & Audit Trail or the DRM
 * Oversight view on demo day would see that entire messy history instead of
 * a clean first run.
 *
 * These three are confirmed as the *complete* set of runtime-accumulating
 * collections against the model registry (backend/src/models/index.ts) and a
 * live `db.getCollectionNames()` check, not assumed from a prior console
 * log: the database holds exactly the ten collections ten models declare,
 * six pipeline + `users` + these three. There is no separate decision-log or
 * cached-comparison collection to also wipe.
 *
 * Safe to run repeatedly: seed()/seedUsers() replace rather than upsert
 * (D-019), and emptying an already-empty collection is a no-op.
 */
import mongoose from 'mongoose';
import type { Model } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { Schedule, ScheduleOverride, ScheduleApproval } from '../models/index.js';
import { seed, seedUsers, DEMO_ACCOUNTS } from './seed.js';

/**
 * The three collections a running system produces rather than the pipeline
 * (see seed.ts's own header comment, and D-057). Sourced from the model
 * registry, not hardcoded string literals guessed from memory.
 */
const RUNTIME_MODELS: ReadonlyArray<{ label: string; model: Model<any> }> = [
  { label: 'schedules', model: Schedule },
  { label: 'schedule_overrides', model: ScheduleOverride },
  { label: 'schedule_approvals', model: ScheduleApproval },
];

/**
 * Empty every runtime collection. `syncIndexes` runs first for the same
 * reason D-018 requires it in seed.ts: this script may be the very first
 * thing to touch a fresh database before the app has ever run, so an index
 * build cannot be assumed to already exist.
 */
async function wipeRuntimeState(): Promise<Record<string, number>> {
  const wiped: Record<string, number> = {};
  for (const { label, model } of RUNTIME_MODELS) {
    await model.syncIndexes();
    const result = await model.deleteMany({});
    wiped[label] = result.deletedCount ?? 0;
  }
  return wiped;
}

function renderSummary(params: {
  counts: Record<string, number>;
  corridorsWithDemand: number;
  usersSeeded: number;
  wiped: Record<string, number>;
  seconds: string;
}): string {
  const { counts, corridorsWithDemand, usersSeeded, wiped, seconds } = params;
  return [
    '',
    '========================================================',
    '  DEMO RESET COMPLETE',
    '========================================================',
    '',
    'Reseeded pipeline data (real corridors + synthetic demand):',
    `  corridors             ${counts.corridors}`,
    `  corridor_calendar     ${counts.corridor_calendar}`,
    `  assets                ${counts.assets}`,
    `  tasks                 ${counts.tasks}`,
    `  resources             ${counts.resources}`,
    `  dataset_provenance    ${counts.dataset_provenance}`,
    `  corridors w/ demand   ${corridorsWithDemand}`,
    `  demo accounts         ${usersSeeded}`,
    '',
    'Wiped schedule history (now zero - as if "Generate schedule"',
    'has never been clicked):',
    `  schedules             ${wiped.schedules} removed -> 0`,
    `  schedule_overrides    ${wiped.schedule_overrides} removed -> 0`,
    `  schedule_approvals    ${wiped.schedule_approvals} removed -> 0`,
    '',
    'Demo logins (full details in DEMO_ACCOUNTS.md):',
    ...DEMO_ACCOUNTS.map(
      (account) =>
        `  ${account.username.padEnd(12)} ${account.password.padEnd(14)} (${account.role})`,
    ),
    '',
    `Done in ${seconds}s. Database is ready for the pitch.`,
    '========================================================',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await connectDatabase();
  try {
    const { counts, corridorsWithDemand } = await seed();
    const usersSeeded = await seedUsers();
    const wiped = await wipeRuntimeState();

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      renderSummary({ counts, corridorsWithDemand, usersSeeded, wiped, seconds }),
    );
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err: Error) => {
  logger.error('Demo reset failed', { message: err.message, stack: err.stack });
  process.exitCode = 1;
  void mongoose.connection.close().catch(() => {});
});
