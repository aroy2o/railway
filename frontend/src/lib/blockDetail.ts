/**
 * Data assembly for the Task/Block Detail Drill-down (PRD Section 8 screen 7,
 * TX5). Pure functions, the same split `gantt.ts`/`conflicts.ts`/
 * `oversight.ts` already use: the arithmetic and lookups are unit-testable
 * without a DOM, and CLAUDE.md puts frontend coverage last for the parts that
 * are pure rendering, not for logic like this.
 *
 * Every field this module reads already exists somewhere in the API surface
 * (task documents, the schedule's own `decisionLog`, assets, resources) - this
 * is assembly and display of records this project already computes, not a new
 * scoring or explanation layer. The one thing it does that no other screen
 * does is walk `dependsOnTaskId` into a full chain and turn a decision-log
 * entry's `contributingFactors` into a sentence, rather than a bare number.
 */
import type { DecisionLogEntry, Department, ScheduleBlock, Task } from '../api/apiSlice.ts'
import { FACTOR_LABEL } from './priorityFraming.ts'

/** One task in a block, grouped by department for the "department mix" view. */
export interface DepartmentGroup {
  department: Department
  taskIds: string[]
}

/**
 * Group a block's tasks by department, preserving first-seen order.
 *
 * `block.departments` is parallel-indexed to `block.taskIds` (same source as
 * `BlockBar`'s own per-task department lookup in `GanttTimeline.tsx`) - this
 * reads the same pairing rather than re-deriving it a second way.
 */
export function departmentMix(block: Pick<ScheduleBlock, 'taskIds' | 'departments'>): DepartmentGroup[] {
  const order: Department[] = []
  const byDept = new Map<Department, string[]>()
  block.taskIds.forEach((taskId, index) => {
    const department = block.departments[index]
    if (!department) return
    if (!byDept.has(department)) {
      byDept.set(department, [])
      order.push(department)
    }
    byDept.get(department)!.push(taskId)
  })
  return order.map((department) => ({ department, taskIds: byDept.get(department)! }))
}

/** One link in a dependency chain - the prerequisite task and what is known about it. */
export interface DependencyLink {
  taskId: string
  defectType: string | null
  /** Whether this prerequisite itself has a block in the CURRENT plan. */
  scheduledInThisPlan: boolean
}

/**
 * Walk `dependsOnTaskId` from a task back through its prerequisites.
 *
 * PRD asks for "the prerequisite task and its own status, not just its id".
 * Deliberately NOT `Task.status`: `oversight.ts`'s own header comment already
 * documents that field as written once at seed time and never updated after
 * generation - every task in this corpus reads `'pending'` regardless of
 * whether a real plan schedules it, confirmed against the live database
 * while building this (all three tasks in the real 3-stage chain this
 * feature was verified against carry `status: 'pending'`, block or no
 * block). Rendering it next to "has its own block in this plan" would show
 * two facts that look contradictory but are not - exactly the class of
 * confusing-but-technically-true pairing this project's other screens
 * (`oversight.ts`, `KnownLimitations.tsx`) go out of their way to avoid.
 * `scheduledInThisPlan` is the one truthful, current answer this data model
 * actually has to "what is this prerequisite's status" - so it is the only
 * one shown.
 *
 * T24's dependency constraint is transitive (a 3-stage chain can exist, per
 * `docs/DECISIONS.md` D-066), so a Controller asking "what does this
 * actually wait on" gets the whole chain, not just the immediate parent -
 * PRD's own wording is singular ("the prerequisite task"), widened
 * deliberately here.
 *
 * Bounded at 10 links and guarded against revisiting an id already seen, so a
 * corrupted `dependsOnTaskId` cycle - which should never happen given T24's
 * constraint, but this function must not assume the data it is handed is
 * clean - degrades to a truncated chain instead of an infinite loop.
 */
export function dependencyChain(
  task: Pick<Task, '_id' | 'dependsOnTaskId'>,
  tasksById: Map<string, Task>,
  scheduledTaskIds: Set<string>,
  maxDepth = 10,
): DependencyLink[] {
  const chain: DependencyLink[] = []
  const seen = new Set<string>([task._id])
  let nextId = task.dependsOnTaskId

  while (nextId && chain.length < maxDepth) {
    if (seen.has(nextId)) break
    seen.add(nextId)
    const prereq = tasksById.get(nextId)
    if (!prereq) {
      chain.push({ taskId: nextId, defectType: null, scheduledInThisPlan: false })
      break
    }
    chain.push({
      taskId: prereq._id,
      defectType: prereq.defectType,
      scheduledInThisPlan: scheduledTaskIds.has(prereq._id),
    })
    nextId = prereq.dependsOnTaskId
  }
  return chain
}

/** A required resource, resolved to what it actually is rather than left as an id. */
export interface ResolvedResource {
  _id: string
  name: string
  type: 'crew' | 'machine' | 'permission'
  /** `false` when the id did not resolve - flagged, not silently dropped. */
  resolved: boolean
}

export function resolveResources(
  resourceIds: string[],
  resourcesById: Map<string, { _id: string; name: string; type: 'crew' | 'machine' | 'permission' }>,
): ResolvedResource[] {
  return resourceIds.map((id) => {
    const resource = resourcesById.get(id)
    return resource
      ? { ...resource, resolved: true }
      : { _id: id, name: id, type: 'crew' as const, resolved: false }
  })
}

/** The subset of a decision-log entry's `contributingFactors` this panel reads. */
interface ContributingFactors {
  priorityScore?: number
  dominantPriorityFactor?: string | null
  isCrossDepartmentBatch?: boolean
  sharedWithDepartments?: string[]
  withinSla?: boolean
  windowUsedMinutes?: number
  windowCapacityMinutes?: number
}

/**
 * Turn a decision-log entry into the plain-English "why" PRD screen 7 asks
 * for, grounded entirely in `contributingFactors` - the same structured data
 * `PriorityQueue.tsx` already renders as a one-line summary, expanded here
 * into full sentences. Deliberately NOT an LLM call: Ask the Planner (T18)
 * already owns free-text grounded explanation, and invoking it once per block
 * click would mean a real API call (latency, cost) just to open a read-only
 * panel. This is template text over numbers the solver already computed,
 * which is exactly what a demo needs to render instantly and needs zero
 * grounding-verification step, because there is nothing here an LLM invented.
 */
export function describeReasoning(
  entry: Pick<DecisionLogEntry, 'decision' | 'contributingFactors'> | undefined,
): string {
  if (!entry || entry.decision !== 'scheduled') {
    return 'No decision-log entry for this task in this plan.'
  }
  const factors = entry.contributingFactors as ContributingFactors

  const sentences: string[] = []

  if (typeof factors.priorityScore === 'number') {
    const factorLabel = factors.dominantPriorityFactor
      ? (FACTOR_LABEL[factors.dominantPriorityFactor] ?? factors.dominantPriorityFactor)
      : null
    sentences.push(
      `Scheduled with a priority score of ${factors.priorityScore.toFixed(1)}` +
        (factorLabel ? `, driven mainly by ${factorLabel}.` : '.'),
    );
  } else {
    sentences.push('Scheduled.')
  }

  if (factors.isCrossDepartmentBatch && (factors.sharedWithDepartments?.length ?? 0) > 0) {
    sentences.push(
      `Batched into this window alongside ${factors.sharedWithDepartments!.join(', ')} - one ` +
        'possession serving two departments instead of two separate ones.',
    )
  }

  if (factors.withinSla === false) {
    sentences.push('This placement lands after the task\'s SLA due date.')
  } else if (factors.withinSla === true) {
    sentences.push('This placement lands within the task\'s SLA due date.')
  }

  if (
    typeof factors.windowUsedMinutes === 'number' &&
    typeof factors.windowCapacityMinutes === 'number' &&
    factors.windowCapacityMinutes > 0
  ) {
    const pct = Math.round((100 * factors.windowUsedMinutes) / factors.windowCapacityMinutes)
    sentences.push(
      `Uses ${factors.windowUsedMinutes} of the window's ${factors.windowCapacityMinutes} free minutes (${pct}%).`,
    )
  }

  return sentences.join(' ')
}
