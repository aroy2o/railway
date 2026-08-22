/**
 * Implements PRD Section 5 - the prototype data disclaimer.
 *
 * Must stay visible in the running app so a judge is never unclear about which
 * data is real (corridors, timetable) and which is simulated (maintenance
 * tasks, asset health). Wording comes from config so it is reviewable in one
 * place and cannot be silently reworded per screen.
 */
import { PROTOTYPE_BANNER } from '../config.ts'

export function PrototypeBanner() {
  return (
    <div
      role="note"
      className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 sm:px-6"
    >
      <span className="mr-2 rounded bg-amber-200/70 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
        Prototype
      </span>
      {PROTOTYPE_BANNER}
    </div>
  )
}

export default PrototypeBanner
