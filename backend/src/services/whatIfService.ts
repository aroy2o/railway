/**
 * What-if simulation - PRD FR5, 9.4, task T20.
 *
 * The thinnest service in this codebase on purpose. D-064 decided a what-if
 * result needs no persistence of any kind - not a field, not a fold - because
 * it is a pure function of the current backlog, the schedule's own objective
 * weights, and a candidate task id. So this file gathers those three things
 * and hands them to the optimizer; nothing here writes to MongoDB.
 */
import { requestWhatIf, type WhatIfResult } from './optimizerClient.js';
import { gatherScenario } from './scheduleGathering.js';
import { findScheduleById } from './scheduleOrchestrator.js';

export interface WhatIfOptions {
  scheduleId: string;
  taskId: string;
}

/**
 * Run a what-if against the CURRENT real backlog, using the REFERENCED
 * schedule's own objective weights.
 *
 * Deliberately the current backlog, not a frozen snapshot of what that
 * schedule was generated from: a Controller asking "what if" wants to
 * explore against the live data, the same real corpus `/generate` would use
 * today. The schedule id supplies the weights it was actually built with
 * (T23's `policyWeights`, never the D-023 default) so the what-if's own
 * baseline solve reproduces the committed plan when nothing in the backlog
 * has changed since - and is honestly different, not silently wrong, on the
 * rare occasion something has.
 */
export async function runWhatIf({ scheduleId, taskId }: WhatIfOptions): Promise<WhatIfResult> {
  const schedule = await findScheduleById(scheduleId);
  const { payload } = await gatherScenario({});

  return requestWhatIf({
    ...payload,
    taskId,
    ...(schedule.policyWeights ? { policyWeights: schedule.policyWeights } : {}),
  });
}
