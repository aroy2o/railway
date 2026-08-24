/**
 * Model registry - PRD Section 15 collections.
 *
 * PRD Section 15's `audit_logs` is stored as TWO append-only collections -
 * `schedule_overrides` (FR6.2, T15) and `schedule_approvals` (FR6.1/6.3, T19) -
 * and merged into one time-ordered trail on read by `getAuditTrail`. The two
 * records have different arity, so a single table would leave `taskId` and both
 * assignment fields structurally null on every approve/reject row. See D-057.
 */
export { Corridor } from './Corridor.js';
export type { ICorridor, CorridorDocument, StationRef, OccupancySummary } from './Corridor.js';

export { CorridorCalendar } from './CorridorCalendar.js';
export type {
  ICorridorCalendar,
  CorridorCalendarDocument,
  TimeWindow,
} from './CorridorCalendar.js';

export { Asset } from './Asset.js';
export type { IAsset, AssetDocument, Department, AssetType, AssetCriticality } from './Asset.js';

export { Task } from './Task.js';
export type { ITask, TaskDocument, TaskStatus, PriorityBreakdown } from './Task.js';

export { Resource } from './Resource.js';
export type { IResource, ResourceDocument, ResourceType } from './Resource.js';

export { DatasetProvenance } from './DatasetProvenance.js';
export type { IDatasetProvenance, FieldProvenance } from './DatasetProvenance.js';

export { ScheduleOverride } from './ScheduleOverride.js';
export type {
  IScheduleOverride,
  ScheduleOverrideDocument,
  OverrideAssignment,
  RevalidationCheck,
  RevalidationResult,
} from './ScheduleOverride.js';

export { Schedule } from './Schedule.js';
export type {
  ISchedule,
  ScheduleDocument,
  ScheduleBlock,
  ScheduleDeferredTask,
  GenerationError,
  PolicyWeights,
  EmergencyContext,
} from './Schedule.js';

export { ScheduleApproval } from './ScheduleApproval.js';
export type {
  IScheduleApproval,
  ScheduleApprovalDocument,
  WorkflowState,
  WorkflowAction,
  PlanCheck,
  PlanValidation,
} from './ScheduleApproval.js';
