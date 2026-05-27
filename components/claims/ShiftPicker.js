'use client'

// Segmented shift picker (Day / Night).
//
// Mirrors the visual language of PlatoonPicker so the Standby form's Shift
// selector reads as one family with the Profile platoon row. Two buttons in a
// 2-column grid; single-select; no deselect by default (a shift is always
// required for a Standby entitlement to resolve).
//
// Theme rationale:
//   - Day   → warm amber (sun)
//   - Night → cool indigo (moon)
// Selected = saturated fill, inactive = tinted translucent fill, both keyed off
// the same hue so the row stays visually coherent.

const SHIFTS = ['Day', 'Night']

const SHIFT_THEME = {
  Day: {
    label: 'Day',
    inactive: { bg: 'rgba(234,179,8,0.06)', border: 'rgba(234,179,8,0.45)', text: '#fde047' },
    selected: { bg: '#eab308',              border: '#facc15',              text: '#1a1a1a' },
  },
  Night: {
    label: 'Night',
    inactive: { bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.45)', text: '#a5b4fc' },
    selected: { bg: '#4338ca',               border: '#6366f1',               text: '#ffffff' },
  },
}

export default function ShiftPicker({ value, onChange, idPrefix = 'shift' }) {
  return (
    <div
      role="radiogroup"
      aria-label="Shift"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '8px',
        width: '100%',
      }}
    >
      {SHIFTS.map((key) => {
        const theme    = SHIFT_THEME[key]
        const isActive = value === key
        const state    = isActive ? theme.selected : theme.inactive
        return (
          <button
            key={key}
            id={`${idPrefix}-${key}`}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={theme.label}
            onClick={() => onChange(key)}
            className={`sp-btn${isActive ? ' sp-btn--active' : ''}`}
            style={{
              minHeight: '44px',
              padding: '8px 10px',
              borderRadius: '10px',
              border: `1.5px solid ${state.border}`,
              background: state.bg,
              color: state.text,
              fontSize: '0.9rem',
              fontWeight: isActive ? 700 : 600,
              letterSpacing: '0.02em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
              outline: 'none',
              whiteSpace: 'nowrap',
              '--sp-focus': theme.selected.border,
            }}
          >
            {theme.label}
          </button>
        )
      })}

      <style jsx>{`
        .sp-btn:focus-visible {
          outline: 2px solid var(--sp-focus);
          outline-offset: 2px;
        }
        .sp-btn:hover:not(.sp-btn--active) {
          filter: brightness(1.15);
        }
      `}</style>
    </div>
  )
}
