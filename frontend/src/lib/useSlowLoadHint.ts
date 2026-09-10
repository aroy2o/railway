import { useEffect, useState } from 'react'

/**
 * The deployed backend scales to zero when idle (docs/deploy/README.md) - a
 * request after a few minutes' break can take up to ~30s to cold-start. Local
 * dev and docker-compose never scale to zero, so this only ever fires there.
 * Delayed rather than shown immediately: a fast, warm request should never
 * flash an explanation nobody needs.
 */
const SLOW_LOAD_HINT_DELAY_MS = 3_500

export function useSlowLoadHint(isLoading: boolean): boolean {
  const [showHint, setShowHint] = useState(false)

  useEffect(() => {
    if (!isLoading) return undefined
    const timer = setTimeout(() => setShowHint(true), SLOW_LOAD_HINT_DELAY_MS)
    // Cleanup, not the effect body, resets the flag: this runs on unmount and
    // on every dependency change (isLoading going true -> false, or a new
    // loading cycle starting), so the next cycle never inherits a stale hint.
    return () => {
      clearTimeout(timer)
      setShowHint(false)
    }
  }, [isLoading])

  return isLoading && showHint
}
