'use client'

// ─── Tax Return Page ──────────────────────────────────────────────────────────
// Calculates ATO tax return summary for the active financial year.
//
// Includes:
//   - Small meal count + total
//   - Large meal count + total
//   - Total meal count + dollars
//   - Travel km + rate + total dollars
//
// Excludes: payslip-only allowances (Callback-Ops, Maint stn N/N, etc.)
// Double meal counts as 1 small + 1 large (ATO).
//
// Export options: Copy Table | Download CSV | Download PDF
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { useRates } from '@/lib/calculations/RatesContext'
import { useFY } from '@/lib/fy/FinancialYearContext'
import { calcTaxSummary, roundMoney, formatFYLabel } from '@/lib/calculations/engine'
import AppShell from '@/components/nav/AppShell'

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  inner: { maxWidth: '640px', margin: '0 auto', padding: '32px 20px', boxSizing: 'border-box' },
  card: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '16px',
    padding: '24px',
    marginBottom: '20px',
  },
  cardTitle: {
    margin: '0 0 20px 0',
    fontSize: '0.95rem',
    fontWeight: 700,
    color: '#f9fafb',
    borderBottom: '1px solid #2a2a2a',
    paddingBottom: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 0',
    borderBottom: '1px solid #222',
  },
  rowLabel: { fontSize: '0.875rem', color: '#d1d5db' },
  rowValue: { fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' },
  totalRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 0',
    borderTop: '2px solid #333',
    marginTop: '4px',
  },
  totalLabel: { fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' },
  totalValue: { fontSize: '1.1rem', fontWeight: 800, color: '#dc2626' },
  exportBtn: {
    padding: '8px 16px',
    background: 'transparent',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#9ca3af',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'border-color 0.15s, color 0.15s',
  },
  exportBtnRow: {
    display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '20px',
  },
  fyBadge: {
    display: 'inline-block',
    padding: '3px 10px',
    background: 'rgba(220,38,38,0.12)',
    border: '1px solid rgba(220,38,38,0.3)',
    borderRadius: '6px',
    color: '#fca5a5',
    fontSize: '0.78rem',
    fontWeight: 700,
  },
  empty: {
    textAlign: 'center',
    padding: '40px 20px',
    color: '#6b7280',
    fontSize: '0.875rem',
  },
}

// ─── Tax Row ──────────────────────────────────────────────────────────────────

function TaxRow({ label, value, sub }) {
  return (
    <div style={S.row}>
      <div>
        <div style={S.rowLabel}>{label}</div>
        {sub && <div style={{ fontSize: '0.74rem', color: '#6b7280', marginTop: '2px' }}>{sub}</div>}
      </div>
      <div style={S.rowValue}>{value}</div>
    </div>
  )
}

// ─── CSV Builder ──────────────────────────────────────────────────────────────

function buildCSV(summary, totalMealDollars, fyLabel) {
  const rows = [
    ['Fire Allowance Tracker — Tax Summary', fyLabel],
    [],
    ['Category', 'Count', 'Rate', 'Total ($)'],
    ['Small Meals', summary.smallMealCount, `$${summary.travelRate.toFixed(2)}/km`, `$${summary.smallMealTotal.toFixed(2)}`],
    ['Large Meals', summary.largeMealCount, '', `$${summary.largeMealTotal.toFixed(2)}`],
    ['Total Meals', summary.totalMeals, '', `$${totalMealDollars.toFixed(2)}`],
    ['Travel', `${summary.travelKm} km`, `$${summary.travelRate.toFixed(2)}/km`, `$${summary.travelTotal.toFixed(2)}`],
    [],
    ['Grand Total (Meals + Travel)', '', '', `$${summary.grandTotal.toFixed(2)}`],
  ]
  return rows.map((r) => r.join(',')).join('\n')
}

// ─── Tax Page ─────────────────────────────────────────────────────────────────

export default function TaxPage() {
  const router = useRouter()
  const { claims, loadClaims } = useClaims()
  const { rates, loadRates }   = useRates()
  const { activeFY, loadFYs }  = useFY()

  const [session, setSession]         = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [copied, setCopied]           = useState(false)

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return }
      setSession(data.session)
      setAuthLoading(false)
      const uid = data.session.user.id
      loadFYs(uid)
      loadRates(uid)
      loadClaims(uid)
    })
  }, [router, loadFYs, loadRates, loadClaims])

  // ── Filter claims to active FY ────────────────────────────────────────────

  const fyClaims = (() => {
    if (!activeFY) return claims
    const start = new Date(activeFY.start_date)
    const end   = new Date(activeFY.end_date)
    return claims.filter((c) => {
      if (!c.date) return false
      const d = new Date(c.date)
      return d >= start && d <= end
    })
  })()

  // ── Compute summary ───────────────────────────────────────────────────────

  const summary          = calcTaxSummary(fyClaims, rates)
  const totalMealDollars = roundMoney(summary.smallMealTotal + summary.largeMealTotal)
  const grandTotal       = summary.grandTotal.toFixed(2)

  // ── Export handlers ───────────────────────────────────────────────────────

  const handleCopy = async () => {
    const lines = [
      `Tax Summary — ${activeFY ? formatFYLabel(activeFY.label) : 'All Years'}`,
      '',
      `Small Meals: ${summary.smallMealCount} × $${rates.smallMealAllowance.toFixed(2)} = $${summary.smallMealTotal.toFixed(2)}`,
      `Large Meals: ${summary.largeMealCount} × $${rates.largeMealAllowance.toFixed(2)} = $${summary.largeMealTotal.toFixed(2)}`,
      `Total Meals: ${summary.totalMeals} = $${totalMealDollars.toFixed(2)}`,
      '',
      `Travel: ${summary.travelKm} km × $${summary.travelRate.toFixed(2)}/km = $${summary.travelTotal.toFixed(2)}`,
      '',
      `Grand Total: $${grandTotal}`,
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch (err) {
      console.error('Copy failed', err)
    }
  }

  const handleDownloadCSV = () => {
    const csv  = buildCSV(summary, totalMealDollars, activeFY ? formatFYLabel(activeFY.label) : 'All')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `fire-allowance-tax-${formatFYLabel(activeFY?.label || 'summary').replace(/[^a-z0-9]+/gi, '-')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDownloadPDF = () => { window.print() }

  // ── Guards ────────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f0f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        Loading…
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppShell>
      <div style={S.inner}>

        <div style={{ marginBottom: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <h1 style={{ margin: '0 0 4px', fontSize: '1.35rem', fontWeight: 700, color: '#f9fafb' }}>
              Tax Return
            </h1>
            {activeFY && <span style={S.fyBadge}>{formatFYLabel(activeFY.label)}</span>}
          </div>
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#6b7280' }}>
            ATO meal and travel allowance summary. Excludes payslip-only allowances.
          </p>
        </div>

        {fyClaims.length === 0 ? (
          <div style={S.card}>
            <div style={S.empty}>
              No claims found for {activeFY ? formatFYLabel(activeFY.label) : 'this financial year'}.
            </div>
          </div>
        ) : (
          <>
            {/* Meals */}
            <div style={S.card}>
              <div style={S.cardTitle}>
                <span>Meal Allowances</span>
                <span style={{ fontSize: '0.78rem', color: '#6b7280', fontWeight: 400 }}>
                  {activeFY?.start_date} → {activeFY?.end_date}
                </span>
              </div>

              <TaxRow
                label="Small Meals"
                sub={`${summary.smallMealCount} × $${rates.smallMealAllowance.toFixed(2)}`}
                value={`$${summary.smallMealTotal.toFixed(2)}`}
              />
              <TaxRow
                label="Large Meals"
                sub={`${summary.largeMealCount} × $${rates.largeMealAllowance.toFixed(2)}`}
                value={`$${summary.largeMealTotal.toFixed(2)}`}
              />

              <div style={S.totalRow}>
                <span style={S.totalLabel}>Total Meals ({summary.totalMeals})</span>
                <span style={S.totalValue}>${totalMealDollars.toFixed(2)}</span>
              </div>

              <div style={{ marginTop: '8px', fontSize: '0.74rem', color: '#6b7280' }}>
                Double meal claims counted as 1 small + 1 large. Spoilt Meal and Delayed Meal claims counted as 1 small.
              </div>
            </div>

            {/* Travel */}
            <div style={S.card}>
              <div style={S.cardTitle}>
                <span>Travel Allowance</span>
              </div>

              <TaxRow label="Total km travelled" value={`${summary.travelKm.toFixed(1)} km`} />
              <TaxRow label="Rate (per km)" value={`$${summary.travelRate.toFixed(2)}/km`} />

              <div style={S.totalRow}>
                <span style={S.totalLabel}>Travel Total</span>
                <span style={S.totalValue}>${summary.travelTotal.toFixed(2)}</span>
              </div>
            </div>

            {/* Grand total */}
            <div style={{
              ...S.card,
              background: 'rgba(220,38,38,0.06)',
              border: '1px solid rgba(220,38,38,0.25)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f9fafb' }}>
                    Total Allowances
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginTop: '2px' }}>
                    Meals + Travel (excludes payslip-only items)
                  </div>
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#dc2626' }}>
                  ${grandTotal}
                </div>
              </div>
            </div>

            {/* Export buttons */}
            <div style={S.exportBtnRow}>
              <button onClick={handleCopy} style={S.exportBtn}>
                {copied ? '✓ Copied!' : '📋 Copy Table'}
              </button>
              <button onClick={handleDownloadCSV} style={S.exportBtn}>
                ⬇ Download CSV
              </button>
              <button onClick={handleDownloadPDF} style={S.exportBtn}>
                🖨 Download PDF
              </button>
            </div>

            <div style={{ marginTop: '16px', fontSize: '0.74rem', color: '#6b7280', lineHeight: 1.6 }}>
              This summary is for your personal tax records. Verify all figures against your payslips before lodging your tax return. This app does not provide tax advice.
            </div>
          </>
        )}

      </div>
    </AppShell>
  )
}
