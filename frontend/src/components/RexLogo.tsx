/**
 * Rex Planner mark: two rails with a possession block laid across them —
 * same motif and colors as `public/favicon.svg`, so the header icon, the
 * login screen, and the browser-tab icon all read as one identity. A single
 * inline SVG (no external asset) so it can be sized purely via className.
 */
export function RexLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="Rex Planner" className={className}>
      <rect width="32" height="32" rx="7" fill="#0f172a" />
      <line x1="6" y1="12" x2="26" y2="12" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="6" y1="22" x2="26" y2="22" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="10" y1="13.6" x2="10" y2="20.4" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="16" y1="13.6" x2="16" y2="20.4" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="22" y1="13.6" x2="22" y2="20.4" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="13" y="8" width="6" height="18" rx="2" fill="#38bdf8" />
    </svg>
  )
}

export default RexLogo
