/**
 * Model registry - PRD Section 15 collections.
 *
 * Collections still to come as their tasks land:
 *   decision_logs (T17), audit_logs (T19), conflicts (T21)
 *
 * `schedule_overrides` (FR6.2) is T15's; T19's formal audit_logs will likely
 * subsume or reference it when the full approval workflow lands.
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
} from './Schedule.js';
