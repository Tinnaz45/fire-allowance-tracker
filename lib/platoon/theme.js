// Centralized platoon colour theme.
//
// Single source of truth for platoon identity colours, used by the segmented
// picker on the Profile page and anywhere else platoon-coloured UI is needed.
// Keep additions/edits here — do not redefine colours inline.
//
// Per-platoon shape:
//   key          – single-letter platoon key ('A' | 'B' | 'C' | 'D' | 'Z')
//   name         – full display label ("A Platoon")
//   inactive     – { bg, border, text } for the unselected segmented state
//   selected     – { bg, border, text } for the active segmented state
//                  (selected.text is chosen to remain WCAG-AA on selected.bg —
//                   notably D Platoon yellow uses near-black text)

export const PLATOONS = ['A', 'B', 'C', 'D', 'Z']

export const PLATOON_THEME = {
  A: {
    name: 'A Platoon',
    inactive: { bg: 'rgba(220,38,38,0.06)',  border: 'rgba(220,38,38,0.45)',  text: '#fca5a5' },
    selected: { bg: '#dc2626',               border: '#ef4444',               text: '#ffffff' },
  },
  B: {
    name: 'B Platoon',
    inactive: { bg: 'rgba(59,130,246,0.06)', border: 'rgba(59,130,246,0.45)', text: '#93c5fd' },
    selected: { bg: '#2563eb',               border: '#3b82f6',               text: '#ffffff' },
  },
  C: {
    name: 'C Platoon',
    inactive: { bg: 'rgba(34,197,94,0.06)',  border: 'rgba(34,197,94,0.45)',  text: '#86efac' },
    selected: { bg: '#16a34a',               border: '#22c55e',               text: '#ffffff' },
  },
  D: {
    name: 'D Platoon',
    // D uses yellow. Inactive text is a pale amber that stays readable on the
    // dark page background; the selected fill is a saturated amber paired with
    // near-black text so the contrast ratio clears WCAG-AA on dark mode.
    inactive: { bg: 'rgba(234,179,8,0.06)',  border: 'rgba(234,179,8,0.55)',  text: '#fde047' },
    selected: { bg: '#eab308',               border: '#facc15',               text: '#1a1a1a' },
  },
  Z: {
    // Canonical Z Platoon pink — selected fill is the deep magenta (#831843)
    // paired with the pink-500 border and pink-300 text. Inactive mirrors the
    // tinted/translucent pattern used by the other platoons, keyed off the
    // same pink-500 hue so the row reads as one family.
    name: 'Z Platoon',
    inactive: { bg: 'rgba(236,72,153,0.06)', border: 'rgba(236,72,153,0.45)', text: '#f9a8d4' },
    selected: { bg: '#831843',               border: '#ec4899',               text: '#ffffff' },
  },
}

export function getPlatoonTheme(key) {
  return PLATOON_THEME[key] || null
}
