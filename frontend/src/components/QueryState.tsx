/**
 * Loading and error states for an RTK Query result.
 *
 * Centralised so every page reports a failure the same way, and so no page
 * silently renders an empty table when the request actually errored.
 */
import type { ReactNode } from 'react'
import { describeApiError } from '../api/apiSlice.ts'
import { useSlowLoadHint } from '../lib/useSlowLoadHint.ts'

interface QueryStateProps {
  isLoading: boolean
  error: unknown
  isEmpty?: boolean
  emptyMessage?: string
  children: ReactNode
}

export function QueryState({
  isLoading,
  error,
  isEmpty,
  emptyMessage = 'Nothing to show.',
  children,
}: QueryStateProps) {
  const showSlowLoadHint = useSlowLoadHint(isLoading)

  if (isLoading) {
    return (
      <div className="px-5 py-8">
        <p className="text-sm text-slate-500">Loading…</p>
        {showSlowLoadHint && (
          <p className="mt-1 text-xs text-slate-400">
            Starting up the service — this can take up to 30s after a break.
          </p>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-5 py-8">
        <p className="text-sm font-medium text-rose-700">{describeApiError(error)}</p>
        <p className="mt-1 text-xs text-slate-500">
          Is the backend running, and has <code>npm run seed</code> been run?
        </p>
      </div>
    )
  }

  if (isEmpty) {
    return <p className="px-5 py-8 text-sm text-slate-500">{emptyMessage}</p>
  }

  return <>{children}</>
}

export default QueryState
