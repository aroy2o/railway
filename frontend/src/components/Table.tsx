/**
 * Minimal table primitives.
 *
 * Wide tables scroll inside their own container so the page body never scrolls
 * horizontally on a projector.
 */
import type { ReactNode } from 'react'

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`border-b border-slate-200 px-4 py-2.5 text-xs font-semibold tracking-wide text-slate-500 uppercase ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  mono = false,
}: {
  children: ReactNode
  align?: 'left' | 'right'
  mono?: boolean
}) {
  return (
    <td
      className={`border-b border-slate-100 px-4 py-2.5 text-slate-700 ${
        align === 'right' ? 'text-right tabular-nums' : ''
      } ${mono ? 'font-mono text-xs' : ''}`}
    >
      {children}
    </td>
  )
}

export function PageHeader({
  title,
  subtitle,
  meta,
}: {
  title: string
  subtitle?: string
  meta?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-600">{subtitle}</p>}
      </div>
      {meta}
    </div>
  )
}

/** Severity 1-5 rendered with a label, never colour alone. */
export function SeverityPill({ severity }: { severity: number }) {
  const tone =
    severity >= 4
      ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
      : severity === 3
        ? 'bg-amber-50 text-amber-800 ring-amber-600/20'
        : 'bg-slate-100 text-slate-600 ring-slate-500/20'

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      S{severity}
    </span>
  )
}

const DEPARTMENT_TONES: Record<string, string> = {
  Engineering: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  'S&T': 'bg-teal-50 text-teal-700 ring-teal-600/20',
  TRD: 'bg-orange-50 text-orange-700 ring-orange-600/20',
}

export function DepartmentPill({ department }: { department: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        DEPARTMENT_TONES[department] ?? 'bg-slate-100 text-slate-600 ring-slate-500/20'
      }`}
    >
      {department}
    </span>
  )
}
