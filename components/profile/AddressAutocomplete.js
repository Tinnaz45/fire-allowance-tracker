'use client'

// ─── AddressAutocomplete ─────────────────────────────────────────────────────
// Profile-page input that converts free-typed home addresses into a verified,
// geocoded address by querying Photon (with a Nominatim fallback). Behaviour:
//
//   - Debounced 350 ms while typing; in-flight request is aborted whenever a
//     newer keystroke supersedes it, so only the latest query's results land.
//   - Suggestions render as a dropdown directly under the input. Arrow keys
//     navigate, Enter selects, Escape closes. The dropdown also closes on
//     outside click / blur (with a small delay so mouse-click selection works).
//   - "Verified" state is owned by the parent (the parent holds canonical text
//     + lat + lng + verifiedAt). The parent decides what to do with that on
//     save — this component just emits selection events.
//
// Mobile considerations:
//   - Touch-target ≥ 44 px per suggestion.
//   - autoComplete="off" so the OS keyboard doesn't suggest competing values.
//   - inputMode="search" hints search keyboard.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from 'react'
import { searchAddress } from '@/lib/distance/photon'

const DEBOUNCE_MS = 350
const MIN_QUERY_LEN = 3

// ── Styles (kept inline to match the existing profile-page look-and-feel) ────

const S = {
  wrapper: { position: 'relative' },
  input: {
    width: '100%',
    padding: '10px 12px',
    background: '#111',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: '#333',
    borderRadius: '8px',
    color: '#e5e7eb',
    fontSize: '0.9rem',
    outline: 'none',
    boxSizing: 'border-box',
  },
  inputVerified: { borderColor: 'rgba(34,197,94,0.45)' },
  inputUnverified: { borderColor: 'rgba(251,191,36,0.45)' },
  dropdown: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    zIndex: 30,
    background: '#111',
    border: '1px solid #333',
    borderRadius: '8px',
    maxHeight: '280px',
    overflowY: 'auto',
    boxShadow: '0 10px 32px rgba(0,0,0,0.55)',
  },
  item: {
    display: 'block',
    width: '100%',
    minHeight: '44px',
    textAlign: 'left',
    padding: '10px 14px',
    background: 'none',
    border: 'none',
    borderBottom: '1px solid #1f1f1f',
    color: '#e5e7eb',
    fontSize: '0.88rem',
    lineHeight: 1.35,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  itemActive: {
    background: 'rgba(220,38,38,0.12)',
    color: '#fca5a5',
  },
  emptyMsg: { padding: '12px 14px', color: '#6b7280', fontSize: '0.85rem' },
  loadingMsg: { padding: '12px 14px', color: '#9ca3af', fontSize: '0.85rem' },
  statusRow: {
    display: 'flex', alignItems: 'center', gap: '6px',
    marginTop: '6px', fontSize: '0.78rem',
  },
  statusVerified: { color: '#4ade80' },
  statusWarn:     { color: '#fbbf24' },
  badge: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '16px', height: '16px', borderRadius: '50%',
    fontSize: '0.7rem', fontWeight: 700,
  },
  badgeVerified: { background: 'rgba(34,197,94,0.2)', color: '#4ade80' },
  badgeWarn:     { background: 'rgba(251,191,36,0.2)', color: '#fbbf24' },
}

/**
 * @param {object} props
 * @param {string}   props.value          The current text shown in the input.
 * @param {function} props.onChange       (text:string) => void — fired on every keystroke.
 * @param {function} props.onSelect       (suggestion:{label,lat,lng,source}) => void
 *                                        Fired when the user picks a suggestion.
 * @param {function} [props.onClearVerified] () => void — called when the user
 *                                            edits the input away from the
 *                                            verified label.
 * @param {boolean}  props.verified       Parent-owned verified flag.
 * @param {string}   [props.placeholder]
 * @param {string}   [props.id]
 */
export default function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  onClearVerified,
  verified,
  placeholder = '12 Smith Street, Brunswick VIC 3056',
  id,
}) {
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [hasSearched, setHasSearched] = useState(false)

  const debounceRef = useRef(null)
  const abortRef    = useRef(null)
  const wrapperRef  = useRef(null)
  const inputRef    = useRef(null)
  // Guard so picking a suggestion doesn't re-trigger a search for the
  // canonical label we just wrote into the input.
  const skipNextSearchFor = useRef(null)

  // ── Search effect ──────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q) => {
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setLoading(true)
    try {
      const results = await searchAddress(q, { signal: ctrl.signal })
      // Discard if a newer search has already taken over.
      if (abortRef.current !== ctrl) return
      setSuggestions(results)
      setActiveIdx(results.length > 0 ? 0 : -1)
      setHasSearched(true)
    } catch (err) {
      if (err?.name === 'AbortError') return
      setSuggestions([])
      setActiveIdx(-1)
      setHasSearched(true)
    } finally {
      if (abortRef.current === ctrl) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Clear any pending debounce when value changes.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    if (skipNextSearchFor.current && skipNextSearchFor.current === value) {
      skipNextSearchFor.current = null
      return
    }

    const q = (value || '').trim()
    if (q.length < MIN_QUERY_LEN) {
      setSuggestions([])
      setActiveIdx(-1)
      setHasSearched(false)
      setLoading(false)
      return
    }

    debounceRef.current = setTimeout(() => runSearch(q), DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [value, runSearch])

  // Abort any in-flight request on unmount.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort() }, [])

  // ── Outside-click close ────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleChange = (e) => {
    const next = e.target.value
    onChange?.(next)
    if (verified && onClearVerified) onClearVerified()
    setOpen(true)
  }

  const handleFocus = () => {
    if ((value || '').trim().length >= MIN_QUERY_LEN) setOpen(true)
  }

  const pick = (s) => {
    if (!s) return
    skipNextSearchFor.current = s.label
    onChange?.(s.label)
    onSelect?.(s)
    setOpen(false)
    setSuggestions([])
    setActiveIdx(-1)
    setHasSearched(false)
    // Return focus to the input after a tick so screen readers announce the
    // selection and so the field stays interactive.
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true)
      return
    }
    if (!open) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(suggestions.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && activeIdx < suggestions.length) {
        e.preventDefault()
        pick(suggestions[activeIdx])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const trimmed = (value || '').trim()
  const showDropdown =
    open &&
    trimmed.length >= MIN_QUERY_LEN &&
    (loading || suggestions.length > 0 || hasSearched)

  const inputStyle = {
    ...S.input,
    ...(verified ? S.inputVerified : (trimmed.length > 0 ? S.inputUnverified : {})),
  }

  return (
    <div style={S.wrapper} ref={wrapperRef}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value || ''}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        inputMode="search"
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        aria-controls={id ? `${id}-listbox` : undefined}
        aria-activedescendant={
          activeIdx >= 0 && id ? `${id}-option-${activeIdx}` : undefined
        }
        style={inputStyle}
      />

      {showDropdown && (
        <div
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          style={S.dropdown}
        >
          {loading && suggestions.length === 0 && (
            <div style={S.loadingMsg}>Searching addresses…</div>
          )}
          {!loading && suggestions.length === 0 && hasSearched && (
            <div style={S.emptyMsg}>
              No matching addresses. You can still type manually and save.
            </div>
          )}
          {suggestions.map((s, idx) => (
            <button
              key={s.id || `${s.lat},${s.lng}`}
              id={id ? `${id}-option-${idx}` : undefined}
              role="option"
              type="button"
              aria-selected={idx === activeIdx}
              onMouseDown={(e) => { e.preventDefault(); pick(s) }}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                ...S.item,
                ...(idx === activeIdx ? S.itemActive : {}),
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
