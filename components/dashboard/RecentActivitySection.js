'use client'

// ─── RecentActivitySection ────────────────────────────────────────────────────
// Compact quick-glance summary of the most recent Retain, Recall, Standby and
// Muster & Dismiss claim for the authenticated user in the active financial year.
//
// ARCHITECTURE:
//   - Reads directly from ClaimsContext (already loaded by page.js — no extra queries)
//   - Resolves data client-side: avoids duplicate Supabase fetches
//   - Renders a compact 2×2 responsive grid of summary tiles
//   - Each tile shows only: icon, claim type label, latest claim date
//   - Empty tiles show the compact value "-"
//   - Clicking a populated tile opens the latest claim for editing (preserves edit flow)
//
// DATA — latest date per type comes from the UNION of two context sources, so
// the tile matches what My Claims shows for every claim type:
//   - claims      → editable claim rows (recalls/retain have rows; date = c.date)
//   - claimGroups → parent groups for ALL types incl. standby/md, which may have
//                   no editable child row in `claims` (date = g.incident_date)
// The tap target is the editable claim row when one exists; standby/md groups
// without an editable row still display their date but are non-interactive,
// mirroring My Claims (which offers no edit affordance for childless groups).
// Date formatted DD/MM/YY to match the rest of the app.
// ─────────────────────────────────────────────────────────────────────────────

import { useClaims } from '@/lib/claims/ClaimsContext'
import { formatDateDDMMYY } from '@/lib/calculations/engine'

// ─── Claim type icon/accent config ────────────────────────────────────────────

const CARD_CONFIG = {
  retain: {
    label:       'Retain',
    accentColor: '#f59e0b',   // amber
    accentAlpha: 'rgba(245,158,11,0.12)',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  recalls: {
    label:       'Recall',
    accentColor: '#3b82f6',   // blue
    accentAlpha: 'rgba(59,130,246,0.12)',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
      </svg>
    ),
  },
  standby: {
    label:       'Standby',
    accentColor: '#8b5cf6',   // violet
    accentAlpha: 'rgba(139,92,246,0.12)',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  md: {
    label:       'Muster & Dismiss',
    accentColor: '#14b8a6',   // teal
    accentAlpha: 'rgba(20,184,166,0.12)',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a4 4 0 10-3-6.65" />
      </svg>
    ),
  },
}

// ─── SummaryTile ──────────────────────────────────────────────────────────────
// Renders a single compact tile: icon, claim type label, latest claim date.
// Props:
//   claimType  — 'recalls' | 'retain' | 'standby' | 'md'
//   date       — latest claim date (ISO string) for this type, or null
//   claim      — the latest editable claim row to open, or null
//   onEdit     — called with the claim object when a populated tile is clicked

function SummaryTile({ claimType, date, claim, onEdit }) {
  const cfg = CARD_CONFIG[claimType]
  const isEmpty = !date
  const clickable = !!claim && typeof onEdit === 'function'

  return (
    <div
      onClick={clickable ? () => onEdit(claim) : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        minWidth: 0,
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: '10px',
        padding: '8px 10px',
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={clickable ? (e) => { e.currentTarget.style.borderColor = cfg.accentColor } : undefined}
      onMouseLeave={clickable ? (e) => { e.currentTarget.style.borderColor = '#2a2a2a' } : undefined}
    >
      {/* Icon */}
      <div style={{
        width: '28px', height: '28px',
        background: cfg.accentAlpha,
        borderRadius: '8px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: cfg.accentColor,
        flexShrink: 0,
      }}>
        {cfg.icon}
      </div>

      {/* Date (primary) + claim type (secondary) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
        <span style={{
          fontSize: '1.05rem',
          fontWeight: 800,
          color: isEmpty ? '#4b5563' : '#f9fafb',
          letterSpacing: '-0.02em',
          lineHeight: 1.15,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {isEmpty ? '-' : formatDateDDMMYY(date)}
        </span>
        <span style={{
          fontSize: '0.65rem',
          fontWeight: 600,
          color: '#8b90a0',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          lineHeight: 1.2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {cfg.label}
        </span>
      </div>
    </div>
  )
}

// ─── RecentActivitySection ────────────────────────────────────────────────────
// Main exported component. Pulls claim data from context (no extra queries).

export default function RecentActivitySection({ onEdit }) {
  const { claims, claimGroups, loading } = useClaims()

  // Groups that still have at least one surviving child claim row. Every child
  // row of a claim group is loaded into `claims` (keyed by claim_group_id), so
  // this Set is the authoritative "does this claim still exist" check.
  //
  // An orphaned claim_group (all child rows deleted, but the parent group row
  // left behind) must NOT contribute a date below — otherwise a fully-deleted
  // claim keeps its tile populated with a stale date even though My Claims
  // (gated on child rows) correctly shows nothing.
  const liveGroupIds = new Set(claims.map((c) => c.claim_group_id).filter(Boolean))

  // Latest DATE per type: max over the union of editable claim rows (c.date) and
  // parent claim groups (g.incident_date). This is what makes standby/md tiles
  // populate even when their entitlements live outside the prototype `claims`
  // array. Only groups that still have surviving children are considered, so
  // orphaned groups can never surface a stale date. `claims` is newest-first;
  // claimGroups is unordered, so compare dates.
  const latestDate = (type) => {
    const dates = [
      ...claims.filter((c) => c.claimType === type).map((c) => c.date),
      ...claimGroups
        .filter((g) => g.claim_type === type && liveGroupIds.has(g.id))
        .map((g) => g.incident_date),
    ].filter(Boolean)
    if (dates.length === 0) return null
    return dates.reduce((a, b) => (new Date(b) > new Date(a) ? b : a))
  }

  // Tap target: the latest editable claim row of that type (claims is newest-first).
  // null for types whose claims live only as groups (e.g. standby/md here) — the
  // tile then shows its date but stays non-interactive.
  const latestClaim = (type) => claims.find((c) => c.claimType === type) || null

  const TYPES = ['retain', 'recalls', 'standby', 'md']
  const latest = Object.fromEntries(
    TYPES.map((t) => [t, { date: latestDate(t), claim: latestClaim(t) }])
  )

  // Don't render during the initial load — ClaimList already shows a spinner
  if (loading) return null

  return (
    <div style={{
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: '16px',
      padding: '12px 14px',
      marginBottom: '16px',
    }}>
      {/* Section header */}
      <h2 style={{ margin: '0 0 10px 0', fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' }}>
        Recent Activity
      </h2>

      {/* Compact 2×2 grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '8px',
      }}>
        <SummaryTile claimType="retain"  date={latest.retain.date}  claim={latest.retain.claim}  onEdit={onEdit} />
        <SummaryTile claimType="recalls" date={latest.recalls.date} claim={latest.recalls.claim} onEdit={onEdit} />
        <SummaryTile claimType="standby" date={latest.standby.date} claim={latest.standby.claim} onEdit={onEdit} />
        <SummaryTile claimType="md"      date={latest.md.date}      claim={latest.md.claim}      onEdit={onEdit} />
      </div>
    </div>
  )
}
