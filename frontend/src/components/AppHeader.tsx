/**
 * Application header.
 *
 * Role switching and navigation between the Controller / Engineer / DRM
 * dashboards (PRD Section 8) are added here by task T11.
 */

export function AppHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white"
            aria-hidden="true"
          >
            BP
          </div>
          <div>
            <h1 className="text-base leading-tight font-semibold text-slate-900">
              AI-Assisted Block Planning
            </h1>
            <p className="text-xs text-slate-500">
              Maintenance block planning &amp; decision support
            </p>
          </div>
        </div>

        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
          SIH 26027 &middot; Ministry of Railways
        </span>
      </div>
    </header>
  )
}

export default AppHeader
