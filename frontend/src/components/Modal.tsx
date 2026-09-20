/**
 * Centered overlay for a panel that used to render inline in the page flow.
 *
 * The Task/Block Detail Drill-down (TX5) and the override flow it hands off
 * to used to render below the Gantt, which on a busy plan sits well past the
 * fold - a first-time user clicking a block saw nothing happen, because
 * "something changed" was true only if you kept scrolling. This puts it
 * directly over the screen instead, matching the backdrop + centered-card
 * pattern the guided tour's own dialog already uses (`TourOverlay.tsx`).
 *
 * Deliberately just a positioning shell: the panel inside supplies its own
 * border/shadow/rounded-corner styling, so nesting stays a single visible
 * card, not two.
 */
import { useEffect } from 'react'

export function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    // Background scroll fights the modal's own overflow otherwise - the page
    // scrolls out from under a card that is supposed to stay put on screen.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-100 flex items-start justify-center overflow-y-auto px-4 py-[6vh]"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-slate-950/60"
      />
      <div className="relative w-full max-w-2xl">{children}</div>
    </div>
  )
}

export default Modal
