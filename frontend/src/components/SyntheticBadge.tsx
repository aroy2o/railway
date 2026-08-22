/**
 * Marks a record as simulated rather than measured.
 *
 * Implements PRD Section 5 / docs/DECISIONS.md D-015 at the point it actually
 * matters - on screen. The `synthetic` flag was written per record by T4 and
 * carried through MongoDB specifically so this badge could be driven by the
 * data itself rather than by a hardcoded assumption in the UI.
 */

interface SyntheticBadgeProps {
  synthetic: boolean
  /** Set on a value that is real even though its record is synthetic. */
  realNote?: string
}

export function SyntheticBadge({ synthetic, realNote }: SyntheticBadgeProps) {
  if (realNote) {
    return (
      <span
        title={realNote}
        className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-700 uppercase ring-1 ring-emerald-600/30 ring-inset"
      >
        Real
      </span>
    )
  }

  return (
    <span
      title={
        synthetic
          ? 'Simulated data — Indian Railways maintenance data is internal and not public'
          : 'Derived from published railway data'
      }
      className={
        synthetic
          ? 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-violet-700 uppercase ring-1 ring-violet-600/30 ring-inset'
          : 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-700 uppercase ring-1 ring-emerald-600/30 ring-inset'
      }
    >
      {synthetic ? 'Synthetic' : 'Real'}
    </span>
  )
}

export default SyntheticBadge
