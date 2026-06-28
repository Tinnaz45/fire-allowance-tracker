'use client'

// ─── StationPicker ────────────────────────────────────────────────────────────
// Canonical station picker used across Recall / Standby / M&D claim forms.
//
// Behaves identically to the proven picker in app/profile/page.js:
//   - A search input and a separate dropdown of buttons.
//   - The dropdown is visible ONLY when the user has typed search text AND
//     the field is active — there is no invisible fuzzy-resolve path.
//   - Selection happens by an explicit button click; that click is the only
//     thing that mutates `value`.
//   - When `value` resolves to a station record, a badge sits above the search
//     input to confirm the current selection.
//
// Identity is EXPLICIT — the picker speaks station ids, never display text:
//   props.value     -> station id as a string ('' when nothing picked)
//   props.onChange  -> called with the station id string on selection or '' on
//                      clear. NEVER called from raw keystrokes — the search
//                      input is internal state only. The visible label is
//                      derived from the resolved record (displayLabelForStation),
//                      so non-fire locations show their name only and nothing
//                      ever parses an id back out of the label.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState, useEffect, useId } from 'react'
import {
  stationById,
  displayLabelForStation,
} from '@/lib/distance/stationParser'

const S = {
  wrap:   { position: 'relative' },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: '10px',
    padding: '5px 12px',
    background: 'rgba(220,38,38,0.12)',
    border: '1px solid rgba(220,38,38,0.3)',
    borderRadius: '6px',
    color: '#fca5a5',
    fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.04em',
    marginBottom: '8px',
    flexWrap: 'wrap',
  },
  badgeSource: {
    fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em',
    color: '#9ca3af', textTransform: 'uppercase',
  },
  badgeSep: { color: '#4b5563', fontWeight: 400 },
  badgeChange: {
    background: 'none', border: 'none', padding: 0,
    color: '#9ca3af', fontSize: '0.74rem', fontWeight: 600,
    cursor: 'pointer', textDecoration: 'underline',
  },
  input: {
    width: '100%', padding: '10px 12px',
    background: '#111', border: '1px solid #333', borderRadius: '8px',
    color: '#e5e7eb', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box',
  },
  dropdown: {
    background: '#111', border: '1px solid #333', borderRadius: '8px',
    marginTop: '4px', maxHeight: '260px', overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  option: {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '12px 14px', minHeight: '44px',
    background: 'none', border: 'none', borderBottom: '1px solid #1f1f1f',
    color: '#e5e7eb', fontSize: '0.88rem', cursor: 'pointer',
    touchAction: 'manipulation',
  },
  optionHighlight: {
    background: 'rgba(220,38,38,0.14)',
    color: '#fef2f2',
  },
  optionSelected: {
    boxShadow: 'inset 3px 0 0 #dc2626',
  },
  optionAbbr: { fontWeight: 700, color: '#fca5a5', marginRight: '4px' },
  empty: { padding: '12px 14px', color: '#6b7280', fontSize: '0.85rem' },
}

const MAX_OPTIONS = 20

// Mirrors the lightweight name/id/abbr filter used by the Profile picker.
// We deliberately don't reuse the fuzzy ranking in the old combobox — its
// behaviour was tuned for the broken auto-resolve flow and isn't needed once
// selection is gated on an explicit click.
function filterStations(query, stations) {
  if (!Array.isArray(stations) || stations.length === 0) return []
  const q = String(query || '').trim().toLowerCase()
  if (!q) return stations
  return stations.filter((s) => {
    const id   = String(s.id)
    const name = (s.name || '').toLowerCase()
    // Match the real abbreviation only — no synthetic "fs{id}" so a non-fire
    // location can never be found by a fabricated FS number.
    const abbr = (s.abbreviation || '').toLowerCase()
    return id.includes(q) || name.includes(q) || (abbr && abbr.includes(q))
  })
}

export default function StationPicker({
  id,
  value,
  onChange,
  stations,
  placeholder,
  ariaLabel,
  // Optional station id that originated from the user's profile (e.g. their
  // rostered station). When provided AND the current `value` equals it, the
  // badge labels the selection "From Profile"; once the user picks a different
  // station the badge flips to "Custom". For pickers with no profile default
  // (recall stn, standby stn) leave this undefined.
  profileStationId,
}) {
  const [searchText, setSearchText]             = useState('')
  const [showDropdown, setShowDropdown]         = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const wrapRef  = useRef(null)
  const inputRef = useRef(null)
  const listRef  = useRef(null)
  const reactId  = useId()
  const baseId   = id || `station-picker-${reactId}`
  const listId   = `${baseId}-list`
  const optionId = (i) => `${listId}-opt-${i}`

  // The currently selected station is resolved by EXPLICIT id from `value`
  // against the loaded stations list — no display-text parsing. Resolves to
  // null while the list is still loading or when nothing is picked.
  const selected = useMemo(
    () => stationById(value, stations),
    [value, stations],
  )

  const filtered = useMemo(
    () => filterStations(searchText, stations).slice(0, MAX_OPTIONS),
    [searchText, stations],
  )

  // Reset highlight whenever the filter changes so ArrowDown/Enter always
  // start from the top of the visible list.
  useEffect(() => { setHighlightedIndex(0) }, [searchText])

  // Keep the highlighted row scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!showDropdown) return
    const el = listRef.current?.querySelector(`[data-option-index="${highlightedIndex}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedIndex, showDropdown, filtered])

  // Outside-click closes the dropdown so the user can't be confused by a
  // floating panel after they've moved on.
  useEffect(() => {
    if (!showDropdown) return
    function onDocPointer(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', onDocPointer)
    document.addEventListener('touchstart', onDocPointer)
    return () => {
      document.removeEventListener('mousedown', onDocPointer)
      document.removeEventListener('touchstart', onDocPointer)
    }
  }, [showDropdown])

  function commit(station) {
    if (!station) return
    onChange(String(station.id))
    setSearchText('')
    setShowDropdown(false)
    setHighlightedIndex(0)
  }

  function handleClear() {
    onChange('')
    setSearchText('')
    setShowDropdown(true)
    setHighlightedIndex(0)
    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (showDropdown) {
        e.preventDefault()
        e.stopPropagation()
        setShowDropdown(false)
      }
    } else if (e.key === 'Enter') {
      // Enter commits the highlighted option only when the user has narrowed
      // the list — never on an empty search, so a stray Enter can't silently
      // pick a station.
      if (showDropdown && searchText && filtered.length > 0) {
        e.preventDefault()
        const idx = Math.min(highlightedIndex, filtered.length - 1)
        commit(filtered[idx])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!showDropdown && searchText) setShowDropdown(true)
      setHighlightedIndex((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.max(0, i - 1))
    }
  }

  // Display the picker in two modes:
  //   1. A station is selected → badge + "Change" link, no live dropdown
  //      unless the user starts typing again.
  //   2. No station selected → just the search field; dropdown opens when
  //      the user types.
  const showingSelectionBadge = !!selected

  // Provenance tag: only meaningful when a profileStationId was supplied AND
  // there is a committed selection. Match → auto-populated; mismatch → user
  // picked something else. With no profileStationId (recall/standby pickers) we
  // suppress the tag entirely so the badge stays clean.
  const provenance = (showingSelectionBadge && profileStationId != null && profileStationId !== '')
    ? (String(value) === String(profileStationId) ? 'From Profile' : 'Custom')
    : null

  const activeOptionId = (showDropdown && searchText && filtered.length > 0)
    ? optionId(Math.min(highlightedIndex, filtered.length - 1))
    : undefined

  return (
    <div ref={wrapRef} style={S.wrap} data-station-picker="new">
      {showingSelectionBadge && (
        <div style={S.badge}>
          <span>{selected.label || displayLabelForStation(selected)}</span>
          {provenance && <span style={S.badgeSource}>{provenance}</span>}
          <span style={S.badgeSep}>·</span>
          <button
            type="button"
            onClick={handleClear}
            style={S.badgeChange}
            aria-label="Change station"
          >
            Change
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        id={baseId}
        type="text"
        value={searchText}
        onChange={(e) => { setSearchText(e.target.value); setShowDropdown(true) }}
        onFocus={() => { if (searchText) setShowDropdown(true) }}
        onKeyDown={handleKeyDown}
        placeholder={selected ? 'Search to change station…' : placeholder}
        aria-label={ariaLabel}
        aria-controls={listId}
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        role="combobox"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        style={S.input}
      />

      {showDropdown && searchText && (
        <div ref={listRef} id={listId} role="listbox" aria-label="Stations" style={S.dropdown}>
          {filtered.length === 0 ? (
            <div style={S.empty}>
              {(!stations || stations.length === 0)
                ? 'Loading stations…'
                : `No stations match “${searchText.trim()}”`}
            </div>
          ) : (
            filtered.map((s, i) => {
              const isHighlighted = i === Math.min(highlightedIndex, filtered.length - 1)
              const isSelected    = selected?.id === s.id
              const optionStyle = {
                ...S.option,
                ...(isHighlighted ? S.optionHighlight : null),
                ...(isSelected    ? S.optionSelected  : null),
              }
              return (
                <button
                  key={s.id}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-option-index={i}
                  // onMouseDown ensures the click registers before the input
                  // blur tears down the dropdown on some mobile browsers.
                  onMouseDown={(e) => { e.preventDefault(); commit(s) }}
                  onClick={() => commit(s)}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  style={optionStyle}
                >
                  {s.abbreviation
                    ? <><span style={S.optionAbbr}>{s.abbreviation}</span>— {s.name || '—'}</>
                    : (s.name || '—')}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
