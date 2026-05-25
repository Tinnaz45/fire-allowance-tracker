'use client'

// ─── RecentActivitySection ────────────────────────────────────────────────────
// Displays the most recent Retain, Recall, and Standby claim for the
// authenticated user in the active financial year.
//
// ARCHITECTURE:
//   - Reads directly from ClaimsContext (already loaded by page.js — no extra queries)
//   - Filters claims array client-side: avoids duplicate Supabase fetches
//   - Each claim type gets its own RecentClaimCard
//   - Empty states handled gracefully per card
//   - Mobile responsive — single-column stacks below 560px
//
// DATA:
//   - 'recalls'  → claimType === 'recalls'
//   - 'retain'   → claimType === 'retain'
//   - 'standby'  → claimType === 'standby'
//   - Amount resolved via resolveEffectiveAmount (respects adjusted_amount)
//   - Date formatted DD/MM/YY to match the rest of the app
// ─────────────────────────────────────────────────────────────────────────────

import { useClaims } from '@/lib/claims/ClaimsContext'
import { resolveEffectiveAmount, formatDateDDMMYY } from '@/lib/calculations/engine'

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const lower = (status || '').toLowerCase()
  const map = {
    paid:     { bg: 'rgba(34,197,94,0.15)',  border: 'rgba(34,197,94,0.4)',  color: '#4ade80' },
    pending:  { bg: 'rgba(234,179,8,0.15)',  border: 'rgba(234,179,8,0.4)', color: '#facc15' },
    disputed: { bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.4)', color: '#f87171' },
  }
  const s = map[lower] || { bg: 'rgba(107,114,128,0.15)', border: 'rgba(107,114,128,0.4)', color: '#9ca3af' }

  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: '999px',
      fontSize: '0.7rem',
      fontWeight: 600,
      textTransform: 'capitalize',
      letterSpacing: '0.03em',
      background: s.bg,
      border: `1px solid ${s.border}`,
      color: s.color,
    }}>
      {status || '—'}
    </span>
  )
}

// ─── Claim type icon/accent config ────────────────────────────────────────────

const CARD_CONFIG = {
  recalls: {
    label:       'Recall',
    emptyLabel:  'No recall claims yet',
    accentColor: '#3b82f6',   // blue
    accentAlpha: 'rgba(59,130,246,0.12)',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
      </svg>
    ),
  },
  retain: {
    label:       'Retain',
    emptyLabel:  'No retain claims yet',
    accentColor: '#f59e0b',   // amber
    accentAlpha: 'rgba(245,158,11,0.12)',
    icon: (
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  standby: {
    label:       'Standby',
    emptyLabel:  'No standby claims yet',
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
    emptyLabel:  'No M&D claims yet',
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

// ─── RecentClaimCard ──────────────────────────────────────────────────────────
// Renders a single "most recent" card for one claim type.
// Props:
//   claimType  — 'recalls' | 'retain' | 'standby' | 'md'
//   claim      — the most recent claim row, or null
//   onEdit     — called with the claim object when Edit is clicked

function RecentClaimCard({ claimType, claim, onEdit }) {
  const cfg = CARD_CONFIG[claimType]
  const isEmpty = !claim

  return (
    <div style={{
      flex: '1 1 200px',
      minWidth: 0,
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: '12px',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }}>
      {/* Card header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{
          width: '28px', height: '28px',
          background: cfg.accentAlpha,
          borderRadius: '7px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: cfg.accentColor,
          flexShrink: 0,
        }}>
          {cfg.icon}
        </div>
        <span style={{
          fontSize: '0.75rem',
          fontWeight: 700,
          color: '#9ca3af',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          {cfg.label}
        </span>
      </div>

      {/* Empty state */}
      {isEmpty ? (
        <p style={{
          margin: 0,
          fontSize: '0.82rem',
          color: '#4b5563',
          fontStyle: 'italic',
          paddingBottom: '4px',
        }}>
          {cfg.emptyLabel}
        </p>
      ) : (
        <>
          {/* Amount */}
          <div style={{
            fontSize: '1.35rem',
            fontWeight: 800,
            color: '#f9fafb',
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}>
            ${resolveEffectiveAmount(claim).toFixed(2)}
          </div>

          {/* Meta row — date + status */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.78rem', color: '#6b7280' }}>
              {formatDateDDMMYY(claim.date)}
            </span>
            <StatusBadge status={claim.status} />
          </div>

          {/* Extra details row */}
          <ClaimDetails claimType={claimType} claim={claim} />

          {/* Edit button */}
          {onEdit && (
            <button
              onClick={() => onEdit(claim)}
              style={{
                marginTop: 'auto',
                padding: '6px 0',
                background: 'transparent',
                border: `1px solid #2a2a2a`,
                borderRadius: '7px',
                color: '#6b7280',
                cursor: 'pointer',
                fontSize: '0.78rem',
                fontWeight: 600,
                width: '100%',
                transition: 'border-color 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = cfg.accentColor
                e.currentTarget.style.color = cfg.accentColor
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#2a2a2a'
                e.currentTarget.style.color = '#6b7280'
              }}
            >
              Edit
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─── ClaimDetails — type-specific detail lines ────────────────────────────────
// Shows relevant contextual metadata per claim type.

function ClaimDetails({ claimType, claim }) {
  const lines = []

  if (claimType === 'recalls') {
    if (claim.recall_stn_label) {
      lines.push({ label: 'Station', value: claim.recall_stn_label })
    }
    if (claim.dist_home_km != null || claim.dist_stn_km != null) {
      const totalKm = (Number(claim.dist_home_km) || 0) + (Number(claim.dist_stn_km) || 0)
      if (totalKm > 0) lines.push({ label: 'Distance', value: `${totalKm} km` })
    }
  }

  if (claimType === 'retain') {
    if (claim.retain_amount != null && Number(claim.retain_amount) > 0) {
      lines.push({ label: 'Retain', value: `$${Number(claim.retain_amount).toFixed(2)}` })
    }
    if (claim.overnight_cash != null && Number(claim.overnight_cash) > 0) {
      lines.push({ label: 'Overnight', value: `$${Number(claim.overnight_cash).toFixed(2)}` })
    }
  }

  if (claimType === 'standby' || claimType === 'md') {
    if (claimType === 'standby' && claim.standby_type) {
      lines.push({ label: 'Type', value: claim.standby_type })
    }
    if (claim.shift) {
      lines.push({ label: 'Shift', value: claim.shift })
    }
    if (claim.dist_km != null && Number(claim.dist_km) > 0) {
      lines.push({ label: 'Distance', value: `${Number(claim.dist_km)} km` })
    }
  }

  if (lines.length === 0) return null

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      padding: '8px 10px',
      background: '#111',
      borderRadius: '7px',
      border: '1px solid #222',
    }}>
      {lines.map(({ label, value }) => (
        <div key={label} style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{ fontSize: '0.72rem', color: '#6b7280' }}>{label}</span>
          <span style={{ fontSize: '0.75rem', color: '#d1d5db', fontWeight: 600 }}>{value}</span>
        </div>
      ))}
    </div>
  )
}

// ─── RecentActivitySection ────────────────────────────────────────────────────
// Main exported component. Pulls claim data from context (no extra queries).

export default function RecentActivitySection({ onEdit }) {
  const { claims, loading } = useClaims()

  // Derive the single most-recent claim per type from the already-loaded claims.
  // Claims are already sorted newest-first by ClaimsContext.
  const latest = {
    retain:  claims.find((c) => c.claimType === 'retain')  || null,
    recalls: claims.find((c) => c.claimType === 'recalls') || null,
    standby: claims.find((c) => c.claimType === 'standby') || null,
    md:      claims.find((c) => c.claimType === 'md')      || null,
  }

  // Don't render during the initial load — ClaimList already shows a spinner
  if (loading) return null

  return (
    <div style={{
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: '16px',
      padding: '24px',
      marginBottom: '20px',
    }}>
      {/* Section header */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: '1rem', fontWeight: 700, color: '#f9fafb' }}>
          Recent Activity
        </h2>
        <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>
          Latest claim per type this financial year
        </p>
      </div>

      {/* Cards — flex row, wraps to single column on mobile */}
      <div style={{
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        <RecentClaimCard claimType="retain"  claim={latest.retain}  onEdit={onEdit} />
        <RecentClaimCard claimType="recalls" claim={latest.recalls} onEdit={onEdit} />
        <RecentClaimCard claimType="standby" claim={latest.standby} onEdit={onEdit} />
        <RecentClaimCard claimType="md"      claim={latest.md}      onEdit={onEdit} />
      </div>
    </div>
  )
}
