'use client'

// Segmented platoon picker.
//
// Renders A / B / C / D / Z as rounded-square buttons in a single row of five.
// Visual rules (kept in sync with lib/platoon/theme.js):
//   - selected    → filled platoon colour, strong border, high-contrast text
//   - inactive    → near-transparent tinted bg, coloured border + subtle text
//   - <=480px     → label collapses to first-letter only to preserve the
//                   5-across layout without wrapping
//   - focus-visible outlines remain visible for keyboard users
//   - D Platoon yellow uses dark text on its selected fill for WCAG-AA contrast
//
// The component is deterministic / additive: it owns no state, just calls
// onChange(key) with one of 'A'|'B'|'C'|'D'|'Z' (or '' to clear, when the user
// reselects the active platoon — opt-in via allowDeselect).

import { PLATOONS, PLATOON_THEME } from '@/lib/platoon/theme'

export default function PlatoonPicker({ value, onChange, allowDeselect = true, idPrefix = 'platoon' }) {
  return (
    <div
      role="radiogroup"
      aria-label="Platoon"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        gap: '8px',
        width: '100%',
      }}
    >
      {PLATOONS.map((key) => {
        const theme    = PLATOON_THEME[key]
        const isActive = value === key
        const state    = isActive ? theme.selected : theme.inactive
        return (
          <button
            key={key}
            id={`${idPrefix}-${key}`}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={theme.name}
            onClick={() => {
              if (isActive && allowDeselect) onChange('')
              else onChange(key)
            }}
            className={`pp-btn${isActive ? ' pp-btn--active' : ''}`}
            style={{
              // Rounded square with soft corners + comfortable tap target.
              minHeight: '44px',
              padding: '8px 10px',
              borderRadius: '10px',
              border: `1.5px solid ${state.border}`,
              background: state.bg,
              color: state.text,
              fontSize: '0.86rem',
              fontWeight: isActive ? 700 : 600,
              letterSpacing: '0.02em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
              outline: 'none',
              whiteSpace: 'nowrap',
              // CSS variable used by focus-visible rule in the <style> block
              // below so the outline picks up the platoon colour at runtime.
              '--pp-focus': theme.selected.border,
            }}
          >
            <span
              className="pp-letter"
              aria-hidden="true"
              style={{
                fontWeight: 800,
                fontSize: '0.95rem',
                lineHeight: 1,
                padding: '2px 5px',
                borderRadius: '6px',
                // Subtle badge: on inactive a faint tint of the platoon colour,
                // on selected a softly translucent inset so the letter still
                // reads as a badge over the saturated fill.
                background: isActive ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.04)',
                color: 'inherit',
              }}
            >
              {key}
            </span>
            <span className="pp-word">Platoon</span>
          </button>
        )
      })}

      <style jsx>{`
        .pp-btn:focus-visible {
          outline: 2px solid var(--pp-focus);
          outline-offset: 2px;
        }
        .pp-btn:hover:not(.pp-btn--active) {
          filter: brightness(1.15);
        }
        @media (max-width: 480px) {
          .pp-word { display: none; }
          :global(.pp-btn) { padding: 8px 6px; }
        }
      `}</style>
    </div>
  )
}
