'use client'

// ─── StationContextLine ────────────────────────────────────────────────────────
// Compact, muted display of a claim's captured station context, rendered beneath
// the date/shift/platoon line on claim cards. Shapes (from resolveClaimStations):
//   - rostered + dest → "📍 FS45 Brooklyn → FS44 Sunshine"  (Recall / Standby / M&D)
//   - dest only       → "📍 Operational: FS43 Deer Park"     (Spoilt / Delayed meal)
//
// Degrades gracefully: renders nothing when `stations` is null/empty, so claims
// without captured context (retain, legacy rows) are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
  marginTop: '4px',
  fontSize: '0.72rem',
  color: '#9ca3af',
  lineHeight: 1.4,
}

const roleStyle = {
  fontSize: '0.6rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#6b7280',
}

/**
 * @param {object} props
 * @param {{ rostered: string|null, dest: string|null, destRole: string }|null} props.stations
 * @param {object} [props.style]
 */
export default function StationContextLine({ stations, style }) {
  if (!stations) return null
  const { rostered, dest, destRole } = stations
  if (!rostered && !dest) return null

  return (
    <div style={{ ...rowStyle, ...style }}>
      <span aria-hidden="true">📍</span>
      {rostered && dest ? (
        <span>
          <span style={{ color: '#d1d5db' }}>{rostered}</span>
          <span style={{ color: '#4b5563', margin: '0 4px' }}>→</span>
          <span style={{ color: '#d1d5db' }}>{dest}</span>
          <span style={{ ...roleStyle, marginLeft: '6px' }}>{destRole}</span>
        </span>
      ) : (
        <span>
          <span style={roleStyle}>{destRole}:</span>{' '}
          <span style={{ color: '#d1d5db' }}>{rostered || dest}</span>
        </span>
      )}
    </div>
  )
}
