'use client'

// ─── ShiftPlatoonLine ──────────────────────────────────────────────────────────
// Card sub-header line: "[Date]  [Shift] [Platoon]".
//
// The date LEADS the line — rendered larger and high-contrast so it reads as the
// primary scannable fact, no longer visually lost beside the chips. The shift and
// platoon chips follow as compact colour-coded tags. Colours mirror the canonical
// sources of truth:
//   - Shift chip → ShiftPicker theme (Day = amber, Night = indigo)
//   - Platoon chip → shared platoon theme (lib/platoon/theme.js)
//
// Gracefully degrades: any missing field is simply omitted (the line still
// renders the date, and never crashes on a claim that predates these fields).
// Mobile-first: chips wrap and stay readable at narrow widths.
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatoonTheme } from '@/lib/platoon/theme'
import { formatDateDDMMYY } from '@/lib/calculations/engine'

const SHIFT_CHIP = {
  Day:   { label: 'Day',   icon: '☀', bg: 'rgba(234,179,8,0.12)',  border: 'rgba(234,179,8,0.4)',  color: '#fde68a' },
  Night: { label: 'Night', icon: '🌙', bg: 'rgba(99,102,241,0.14)', border: 'rgba(99,102,241,0.4)', color: '#c7d2fe' },
}

const chipBase = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  padding: '1px 7px',
  borderRadius: '5px',
  fontSize: '0.66rem',
  fontWeight: 700,
  letterSpacing: '0.02em',
  flexShrink: 0,
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
}

export function ShiftChip({ shift }) {
  const s = SHIFT_CHIP[shift]
  if (!s) return null
  return (
    <span style={{ ...chipBase, background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      <span aria-hidden="true">{s.icon}</span>{s.label}
    </span>
  )
}

export function PlatoonChip({ platoon }) {
  const theme = platoon ? getPlatoonTheme(platoon) : null
  if (!theme) return null
  const { inactive, name } = theme
  return (
    <span
      title={name}
      style={{ ...chipBase, background: inactive.bg, border: `1px solid ${inactive.border}`, color: inactive.text }}
    >
      Platoon {platoon}
    </span>
  )
}

/**
 * @param {object} props
 * @param {'Day'|'Night'|null} props.shift
 * @param {'A'|'B'|'C'|'D'|null} props.platoon
 * @param {string|null} props.date — ISO date string
 * @param {object} [props.style] — extra styles merged onto the row container
 */
export default function ShiftPlatoonLine({ shift, platoon, date, style }) {
  if (!shift && !platoon && !date) return null
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      ...style,
    }}>
      {date && (
        <span style={{
          fontSize: '0.86rem',
          fontWeight: 700,
          color: '#e5e7eb',
          letterSpacing: '0.01em',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {formatDateDDMMYY(date)}
        </span>
      )}
      <ShiftChip shift={shift} />
      <PlatoonChip platoon={platoon} />
    </div>
  )
}
