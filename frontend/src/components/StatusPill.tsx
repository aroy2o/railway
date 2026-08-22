/**
 * Small colour-coded state indicator, shared by the status panel.
 *
 * Colour is never the only signal - each pill also carries a text label - so
 * the state stays readable on a projector and to a colour-blind viewer.
 */

export type StatusTone = 'ok' | 'warn' | 'down' | 'pending'

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  down: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  pending: 'bg-slate-100 text-slate-600 ring-slate-500/20',
}

const DOT_CLASSES: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  down: 'bg-rose-500',
  pending: 'bg-slate-400 animate-pulse',
}

interface StatusPillProps {
  tone: StatusTone
  label: string
}

export function StatusPill({ tone, label }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} aria-hidden="true" />
      {label}
    </span>
  )
}

export default StatusPill
