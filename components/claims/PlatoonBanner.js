'use client'

// ─── PlatoonBanner ────────────────────────────────────────────────────────────
// Auto-resolves and displays the operational FRV platoon for a claim's
// date + shift, rendered beside the shift selector on every claim form.
//
// The platoon is derived deterministically by resolveOperationalPlatoon (the
// single source of truth — the FRV 2026 repeating rotation). Colours come from
// the shared platoon theme (lib/platoon/theme.js) so the banner matches the
// Profile-page picker exactly.
//
// Renders a muted placeholder when the shift hasn't been chosen yet (e.g. a
// Recall before the user picks Day/Night) so the banner slot stays stable.

import { resolveOperationalPlatoon } from '@/lib/platoon/resolveOperationalPlatoon'
import { getPlatoonTheme } from '@/lib/platoon/theme'

export default function PlatoonBanner({ date, shift }) {
  const platoon = resolveOperationalPlatoon(date, shift)
  const theme   = platoon ? getPlatoonTheme(platoon) : null

  if (!platoon || !theme) {
    return (
      <div
        role="status"
        aria-label="Operational platoon — pending shift selection"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '8px 12px', borderRadius: '8px',
          background: 'rgba(107,114,128,0.08)',
          border: '1px solid rgba(107,114,128,0.3)',
          color: '#9ca3af', fontSize: '0.8rem', fontWeight: 600,
        }}
      >
        <span style={{
          fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: '#6b7280',
        }}>
          Platoon
        </span>
        <span>Select shift to resolve</span>
      </div>
    )
  }

  const { selected, name } = theme
  return (
    <div
      role="status"
      aria-label={`Operational platoon: ${name}, ${shift} shift`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '8px 12px', borderRadius: '8px',
        background: selected.bg,
        border: `1.5px solid ${selected.border}`,
        color: selected.text, fontSize: '0.84rem', fontWeight: 700,
        letterSpacing: '0.02em',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontWeight: 800, fontSize: '0.92rem', lineHeight: 1,
          padding: '2px 6px', borderRadius: '6px',
          background: 'rgba(255,255,255,0.18)', color: 'inherit',
        }}
      >
        {platoon}
      </span>
      <span>{name}</span>
      <span style={{ opacity: 0.85, fontWeight: 600, fontSize: '0.74rem' }}>
        · {shift} shift
      </span>
    </div>
  )
}
