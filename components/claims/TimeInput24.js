'use client'

// ─── TimeInput24 ──────────────────────────────────────────────────────────────
// Enforced 24-hour HH:MM controlled input.
//
// Why this exists: native <input type="time"> renders 12-hour AM/PM under many
// browser/OS locale combinations (Mobile Safari, Windows English-AU, etc.).
// FRV claims are recorded in 24-hour time, so the UI must guarantee 24-hour
// display and entry regardless of the user's locale.
//
// Behaviour:
//   - Filters keystrokes down to digits, max 4.
//   - Auto-inserts the colon after the 2nd digit (1930 → "19:30").
//   - Rejects invalid prefixes (hour > 23, minute tens > 5) by ignoring the
//     keystroke — the controlled value snaps back.
//   - Accepts partial entry ("", "1", "19", "19:3") so downstream parsers
//     that tolerate empty / incomplete values keep working.
//   - inputMode="numeric" surfaces the numeric keypad on mobile.
//   - Dark theme styling via consumer-provided style override.

import { forwardRef } from 'react'

const DEFAULT_STYLE = {
  width: '100%',
  padding: '10px 12px',
  background: '#111',
  border: '1px solid #333',
  borderRadius: '8px',
  color: '#e5e7eb',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
}

const TimeInput24 = forwardRef(function TimeInput24(
  {
    id,
    value,
    onChange,
    placeholder = 'HH:MM',
    required = false,
    ariaLabel,
    style,
    disabled = false,
  },
  ref,
) {
  const handleChange = (e) => {
    const digits = (e.target.value || '').replace(/\D/g, '').slice(0, 4)
    if (digits.length >= 1 && parseInt(digits[0], 10) > 2) return
    if (digits.length >= 2 && parseInt(digits.slice(0, 2), 10) > 23) return
    if (digits.length >= 3 && parseInt(digits[2], 10) > 5) return
    const formatted = digits.length <= 2
      ? digits
      : `${digits.slice(0, 2)}:${digits.slice(2)}`
    onChange(formatted)
  }

  return (
    <input
      ref={ref}
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={5}
      placeholder={placeholder}
      value={value || ''}
      onChange={handleChange}
      required={required}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{ ...DEFAULT_STYLE, ...(style || {}) }}
    />
  )
})

export default TimeInput24
