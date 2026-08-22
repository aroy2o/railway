/**
 * Gather the current planning picture from MongoDB into an optimizer payload.
 *
 * This is Node's half of the architecture in PRD Section 11: the Python service
 * never touches the database, so everything a solve needs - corridors, their
 * free windows, the backlog, and the asset-criticality join - is assembled
 * here and POSTed across.
 *
 * TWO FIELD-NAME SEAMS ARE TRANSLATED HERE, DELIBERATELY
 * -----------------------------------------------------
 * The two schemas were designed independently and do not agree on names. That
 * is not an accident to paper over with a rename on one side; each name is
 * right in its own context, and the translation belongs at the boundary:
 *
 *   corridor_calendar stores `startMin` / `endMin`   (T3's window shape)
 *   the optimizer contract expects `startMinute` / `endMinute`  (D-032)
 *
 *   task documents key on `_id`
 *   the optimizer contract expects `taskId`
 *
 * The optimizer's request models are `extra="forbid"`, so an unmapped field is
 * a 422 rather than a silent drop - which is exactly why the mapping is written
 * out explicitly below instead of spreading the document and hoping.
 */
import { Asset, Corridor, CorridorCalendar, Task } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Build the scenario payload for /optimize and /baseline.
 *
 * @param {object} [options]
 * @param {string} [options.horizonStart] ISO date the plan starts from.
 * @param {number} [options.horizonDays]
 * @returns {Promise<{payload: object, taskCount: number, corridorCount: number}>}
 */
export async function gatherScenario({ horizonStart, horizonDays = 7 } = {}) {
  // Only corridors carrying generated demand. Indexed (D-018), so this is 30
  // documents out of 10,149 rather than a collection scan.
  const corridors = await Corridor.find({ hasSyntheticDemand: true }).lean();
  if (corridors.length === 0) {
    throw ApiError.conflict(
      'No corridors carry maintenance demand. Has the database been seeded? (npm run seed)',
    );
  }

  const corridorIds = corridors.map((corridor) => corridor._id);
  const [calendars, tasks] = await Promise.all([
    CorridorCalendar.find({ _id: { $in: corridorIds } })
      .select('_id maxDailyBlockWindows lowConfidence')
      .lean(),
    Task.find({ corridorId: { $in: corridorIds } }).lean(),
  ]);

  const calendarById = new Map(calendars.map((calendar) => [calendar._id, calendar]));

  // The FR2.1 criticality score is real measured-anchored data and only Node
  // can reach it, so the join happens here (D-032).
  const assets = await Asset.find({ _id: { $in: tasks.map((task) => task.assetId) } })
    .select('_id criticalityScore')
    .lean();
  const criticalityByAsset = new Map(assets.map((asset) => [asset._id, asset.criticalityScore]));

  const corridorPayload = corridors.map((corridor) => {
    const calendar = calendarById.get(corridor._id);
    return {
      corridorId: corridor._id,
      dailyWindows: (calendar?.maxDailyBlockWindows ?? []).map((window) => ({
        // The seam: T3's startMin/endMin -> the contract's startMinute/endMinute.
        startMinute: window.startMin,
        endMinute: window.endMin,
      })),
      lowConfidence: Boolean(calendar?.lowConfidence),
    };
  });

  const missingCriticality = [];
  const taskPayload = tasks.map((task) => {
    const criticality = criticalityByAsset.get(task.assetId);
    if (criticality === undefined) missingCriticality.push(task._id);

    return {
      taskId: task._id,
      corridorId: task.corridorId,
      department: task.department,
      estBlockDurationMins: task.estBlockDurationMins,
      slaDueDate: task.slaDueDate,
      severity: task.severity,
      assetCriticalityScore: criticality ?? null,
      // Unused by the solver but load-bearing for the baseline's
      // first-come-first-served ordering (D-029). Dropping it would silently
      // degrade FCFS to "everything sorts last".
      dateRaised: task.dateRaised ?? null,
      dependsOnTaskId: task.dependsOnTaskId ?? null,
      requiredResourceIds: task.requiredResourceIds ?? [],
      // FR2.2 stays null until T16 computes it.
      failureRiskScore: task.failureRiskScore ?? null,
    };
  });

  if (missingCriticality.length > 0) {
    // Not fatal - the optimizer degrades honestly to severity and reports
    // priorityIsPlaceholder: true - but it means an asset join failed, which is
    // worth knowing about rather than discovering as a weaker ranking.
    logger.warn('tasks missing asset criticality; priority will fall back to severity', {
      count: missingCriticality.length,
      sample: missingCriticality.slice(0, 5),
    });
  }

  // Send a clean payload rather than relying on the optimizer's 422 as the only
  // check. Its validators remain the backstop; this catches the same class of
  // problem with a message that names Node's own data.
  assertReferentialIntegrity(taskPayload, corridorPayload);

  return {
    payload: {
      tasks: taskPayload,
      corridors: corridorPayload,
      horizonStart: horizonStart ?? defaultHorizonStart(),
      horizonDays,
    },
    taskCount: taskPayload.length,
    corridorCount: corridorPayload.length,
    tasksMissingCriticality: missingCriticality,
  };
}

function assertReferentialIntegrity(tasks, corridors) {
  const known = new Set(corridors.map((corridor) => corridor.corridorId));
  const dangling = [...new Set(tasks.map((t) => t.corridorId))].filter((id) => !known.has(id));
  if (dangling.length > 0) {
    throw ApiError.conflict(
      `Tasks reference corridors absent from the gathered set: ${dangling.slice(0, 5).join(', ')}`,
      { details: { corridorIds: dangling } },
    );
  }

  const taskIds = new Set(tasks.map((task) => task.taskId));
  const brokenDependencies = tasks
    .filter((task) => task.dependsOnTaskId && !taskIds.has(task.dependsOnTaskId))
    .map((task) => task.taskId);
  if (brokenDependencies.length > 0) {
    throw ApiError.conflict(
      `Tasks depend on prerequisites outside the gathered set: ${brokenDependencies
        .slice(0, 5)
        .join(', ')}`,
      { details: { taskIds: brokenDependencies } },
    );
  }
}

/** Today, as an ISO date, when the caller does not pin the horizon. */
function defaultHorizonStart() {
  return new Date().toISOString().slice(0, 10);
}
