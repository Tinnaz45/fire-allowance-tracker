'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { useRates } from '@/lib/calculations/RatesContext'
import { useFY } from '@/lib/fy/FinancialYearContext'
import { CLAIM_TYPE_ORDER, CLAIM_TYPE_LABELS } from '@/lib/claims/claimTypes'
import ClaimForm from '@/components/claims/ClaimForm'
import ExpandableClaimList from '@/components/claims/ExpandableClaimList'
import GroupedClaimList from '@/components/claims/GroupedClaimList'
import AppShell from '@/components/nav/AppShell'
import RecentActivitySection from '@/components/dashboard/RecentActivitySection'
import ReconciliationSummary from '@/components/dashboard/ReconciliationSummary'

// ─── Shared input styles ──────────────────────────────────────────────────────

const INPUT_STYLE = {
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

const LABEL_STYLE = {
  display: 'block',
  fontSize: '0.78rem',
  fontWeight: 600,
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '6px',
}

// ─── Edit Claim Modal ─────────────────────────────────────────────────────────

function EditClaimModal({ claim, session, activeFY, onClose, onSuccess }) {
  const { updateClaim } = useClaims()
  const [date, setDate] = useState(claim.date || '')
  const [amount, setAmount] = useState(
    String(claim.total_amount ?? claim.amount ?? claim.meal_amount ?? '')
  )
  const [status, setStatus] = useState(claim.status || 'Pending')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    if (!date) { setError('Please select a date.'); return }
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      setError('Please enter a valid amount.'); return
    }

    setSubmitting(true)
    try {
      await updateClaim({
        userId: session.user.id,
        claim,
        date,
        amount,
        status,
        financialYearId: activeFY?.id || null,
      })
      onSuccess()
    } catch (err) {
      console.error('[EditClaim] Update error:', err)
      setError(err.message || 'Failed to update claim. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#f9fafb' }}>
            Edit Claim
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: '#6b7280' }}>
            {CLAIM_TYPE_LABELS[claim.claimType] || claim.claimType}
          </p>
        </div>
        <ModalCloseBtn onClose={onClose} />
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div style={{ marginBottom: '16px' }}>
          <label style={LABEL_STYLE}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={LABEL_STYLE}>Amount ($)</label>
          <input type="number" min="0.01" step="0.01" placeholder="0.00"
            value={amount} onChange={(e) => setAmount(e.target.value)}
            style={INPUT_STYLE} />
        </div>

        <div style={{ marginBottom: '24px' }}>
          <label style={LABEL_STYLE}>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
            <option value="Pending">Pending</option>
            <option value="Paid">Paid</option>
            <option value="Disputed">Disputed</option>
          </select>
        </div>

        {error && <ErrorBox message={error} />}

        <ModalActions onCancel={onClose} submitting={submitting} submitLabel="Save Changes" />
      </form>
    </ModalBackdrop>
  )
}

// ─── New Claim Modal ──────────────────────────────────────────────────────────

function NewClaimModal({ session, activeFY, onClose, onSuccess, initialClaimType }) {
  return (
    <ModalBackdrop onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#f9fafb' }}>
          New Claim
        </h2>
        <ModalCloseBtn onClose={onClose} />
      </div>
      <ClaimForm
        userId={session.user.id}
        financialYearId={activeFY?.id || null}
        onSuccess={onSuccess}
        onCancel={onClose}
        initialClaimType={initialClaimType}
      />
    </ModalBackdrop>
  )
}

// ─── Quick-action button row ──────────────────────────────────────────────────
// Sits between Recent Activity and My Claims. Each button opens the existing
// New Claim modal with the corresponding claim type pre-selected.

const QUICK_ACTIONS = [
  { key: 'retain',       label: 'Retain'        },
  { key: 'recalls',      label: 'Recall'        },
  { key: 'standby',      label: 'Standby'       },
  { key: 'md',           label: 'M&D'           },
  { key: 'spoilt',       label: 'Spoilt Meal'   },
  { key: 'delayed_meal', label: 'Delayed Meal'  },
]

function QuickActionRow({ onSelect }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '8px',
      margin: '0 0 16px 0',
    }}>
      {QUICK_ACTIONS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onSelect(key)}
          style={{
            flex: '1 1 auto',
            minWidth: '92px',
            padding: '10px 14px',
            background: 'rgba(220,38,38,0.08)',
            border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: '10px',
            color: '#fca5a5',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          + {label}
        </button>
      ))}
    </div>
  )
}

// ─── Shared modal primitives ──────────────────────────────────────────────────

function ModalBackdrop({ onClose, children }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a1a',
          border: '1px solid #2a2a2a',
          borderRadius: '16px',
          padding: '28px 24px',
          width: '100%',
          maxWidth: '480px',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          position: 'relative',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function ModalCloseBtn({ onClose }) {
  return (
    <button
      type="button"
      onClick={onClose}
      style={{
        background: 'none', border: 'none',
        color: '#6b7280', cursor: 'pointer',
        fontSize: '1.4rem', lineHeight: 1,
        padding: '0 4px', flexShrink: 0,
      }}
      aria-label="Close"
    >×</button>
  )
}

function ErrorBox({ message }) {
  return (
    <div style={{
      marginBottom: '16px',
      background: 'rgba(239,68,68,0.1)',
      border: '1px solid rgba(239,68,68,0.3)',
      color: '#f87171',
      borderRadius: '8px',
      padding: '10px 14px',
      fontSize: '0.85rem',
    }}>
      {message}
    </div>
  )
}

function ModalActions({ onCancel, submitting, submitLabel }) {
  return (
    <div style={{ display: 'flex', gap: '10px' }}>
      <button type="button" onClick={onCancel} disabled={submitting}
        style={{
          flex: 1, padding: '10px',
          background: 'transparent', border: '1px solid #333',
          borderRadius: '8px', color: '#9ca3af',
          cursor: submitting ? 'not-allowed' : 'pointer',
          fontSize: '0.9rem', fontWeight: 600,
        }}>
        Cancel
      </button>
      <button type="submit" disabled={submitting}
        style={{
          flex: 1, padding: '10px',
          background: submitting ? '#7f1d1d' : '#dc2626',
          border: 'none', borderRadius: '8px',
          color: 'white',
          cursor: submitting ? 'not-allowed' : 'pointer',
          fontSize: '0.9rem', fontWeight: 600,
          transition: 'background 0.15s',
        }}>
        {submitting ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

// ─── FY Selector Dropdown ─────────────────────────────────────────────────────

function FYSelector() {
  const { allFYs, activeFY, switchFY, createFY, availableFYLabels } = useFY()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  if (!activeFY) return null

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '5px 12px',
          background: 'rgba(220,38,38,0.12)',
          border: '1px solid rgba(220,38,38,0.35)',
          borderRadius: '7px',
          color: '#fca5a5',
          fontSize: '0.8rem',
          fontWeight: 700,
          cursor: 'pointer',
          letterSpacing: '0.04em',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        {activeFY.label}
        <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          background: '#1a1a1a',
          border: '1px solid #2a2a2a',
          borderRadius: '10px',
          padding: '6px',
          minWidth: '160px',
          zIndex: 100,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
          {allFYs.map((fy) => (
            <button key={fy.id}
              onClick={async () => { await switchFY(fy.id); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 12px',
                border: 'none',
                borderRadius: '6px',
                color: fy.id === activeFY.id ? '#fca5a5' : '#e5e7eb',
                fontSize: '0.85rem', fontWeight: fy.id === activeFY.id ? 700 : 400,
                cursor: 'pointer',
                background: fy.id === activeFY.id ? 'rgba(220,38,38,0.1)' : 'transparent',
              }}
            >
              {fy.label} {fy.id === activeFY.id ? '✓' : ''}
            </button>
          ))}

          {availableFYLabels.length > 0 && (
            <>
              <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 0' }} />
              {availableFYLabels.slice(0, 3).map((lbl) => (
                <button key={lbl}
                  onClick={async () => {
                    setCreating(true)
                    try {
                      const newFY = await createFY(lbl)
                      if (newFY) await switchFY(newFY.id)
                    } finally {
                      setCreating(false)
                      setOpen(false)
                    }
                  }}
                  disabled={creating}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 12px', background: 'none', border: 'none',
                    borderRadius: '6px', color: '#6b7280',
                    fontSize: '0.82rem', cursor: creating ? 'not-allowed' : 'pointer',
                  }}
                >
                  + {lbl}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

export default function HomePage() {
  const { loadClaims, claims, claimGroups, groupedView } = useClaims()
  const { loadRates } = useRates()
  const { loadFYs, activeFY } = useFY()
  const router = useRouter()

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sessionResolved, setSessionResolved] = useState(false)

  const [showNewClaimModal, setShowNewClaimModal] = useState(false)
  const [quickActionType, setQuickActionType] = useState(null)        // claimType for prefill (e.g. 'standby')
  const [editingClaim, setEditingClaim] = useState(null)
  const [successMessage, setSuccessMessage] = useState(null)

  // activeTab: 'all' | 'pending' | 'paid' | 'payslip' | 'petty-cash'
  const [activeTab, setActiveTab] = useState('all')
  const [sortBy, setSortBy] = useState('date-desc')
  const [filterType, setFilterType] = useState('all')
  // Phase 4: additional filters
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('all') // 'all' | 'Payslip' | 'Petty Cash'
  const [paymentDateFrom, setPaymentDateFrom] = useState('')
  const [paymentDateTo, setPaymentDateTo] = useState('')
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const getSession = async () => {
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
      setLoading(false)
      setSessionResolved(true)
    }
    getSession()

    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
      setSessionResolved(true)
    })
    return () => { listener.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!sessionResolved || !session) return
    const uid = session.user.id
    loadRates(uid)
    loadFYs(uid)
  }, [sessionResolved, session, loadRates, loadFYs])

  useEffect(() => {
    if (!session || !activeFY) return
    loadClaims(
      session.user.id,
      activeFY.id,
      activeFY.start_date,
      activeFY.end_date,
    ).catch((err) => console.error('[HomePage] loadClaims failed', err))
  }, [session, activeFY, loadClaims])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleClaimSuccess = () => {
    setShowNewClaimModal(false)
    setQuickActionType(null)
    setSuccessMessage('Claim saved successfully!')
    setTimeout(() => setSuccessMessage(null), 4000)
  }

  // Quick-action click: open modal with the chosen claim type pre-selected.
  const handleQuickAction = (key) => {
    setQuickActionType(key)
    setShowNewClaimModal(true)
  }

  const handleCloseNewClaim = () => {
    setShowNewClaimModal(false)
    setQuickActionType(null)
  }

  const handleEditSuccess = () => {
    setEditingClaim(null)
    setSuccessMessage('Claim updated successfully!')
    setTimeout(() => setSuccessMessage(null), 4000)
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0f0f0f',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#9ca3af', fontSize: '0.95rem',
      }}>
        Loading…
      </div>
    )
  }

  if (sessionResolved && !session) {
    router.replace('/login')
    return null
  }

  // ── Style helpers ─────────────────────────────────────────────────────────

  const tabStyle = (isActive) => ({
    padding: '6px 14px',
    borderRadius: '8px',
    border: 'none',
    background: isActive ? '#dc2626' : 'transparent',
    color: isActive ? 'white' : '#6b7280',
    fontWeight: 600,
    fontSize: '0.82rem',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
    whiteSpace: 'nowrap',
  })

  const selectStyle = {
    padding: '6px 10px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: '7px',
    color: '#9ca3af',
    fontSize: '0.82rem',
    cursor: 'pointer',
    outline: 'none',
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppShell>
      <div style={{
        color: '#e5e7eb',
        padding: '24px 16px',
        boxSizing: 'border-box',
        overflowX: 'hidden',
      }}>
        <div style={{ maxWidth: '800px', margin: '0 auto' }}>

          {/* ── Header ── */}
          <div style={{
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '32px', flexWrap: 'wrap', gap: '12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                width: '40px', height: '40px', background: '#dc2626',
                borderRadius: '10px', display: 'flex', alignItems: 'center',
                justifyContent: 'center', flexShrink: 0,
              }}>
                <svg width="22" height="22" fill="none" stroke="white" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
                </svg>
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#f9fafb' }}>
                  Fire Allowance Tracker
                </h1>
                <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>
                  {session.user.email}
                </p>
              </div>
            </div>

            {/* FY selector + Logout — Tax/Profile/Settings now in bottom nav */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <FYSelector />
              <button
                onClick={async () => { await supabase.auth.signOut(); window.location.assign('/login') }}
                style={{
                  padding: '8px 16px', background: '#dc2626', color: 'white',
                  border: 'none', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '0.82rem', fontWeight: 600,
                }}>
                Logout
              </button>
            </div>
          </div>

          {/* ── Success Banner ── */}
          {successMessage && (
            <div style={{
              marginBottom: '20px',
              background: 'rgba(34,197,94,0.1)',
              border: '1px solid rgba(34,197,94,0.3)',
              color: '#4ade80', borderRadius: '10px',
              padding: '12px 16px', fontSize: '0.875rem', fontWeight: 500,
            }}>
              ✓ {successMessage}
            </div>
          )}

          {/* ── Reconciliation Summary (Phase 4) ── */}
          <ReconciliationSummary />

          {/* ── Recent Activity Section ── */}
          <RecentActivitySection onEdit={setEditingClaim} />

          {/* ── Quick-action claim type buttons ── */}
          <QuickActionRow onSelect={handleQuickAction} />

          {/* ── Claims Section ── */}
          <div style={{
            background: '#1a1a1a', border: '1px solid #2a2a2a',
            borderRadius: '16px', padding: '24px',
          }}>
            {/* Section header */}
            <div style={{
              display: 'flex', alignItems: 'flex-start',
              justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
            }}>
              <div>
                <h2 style={{ margin: '0 0 4px 0', fontSize: '1rem', fontWeight: 700, color: '#f9fafb' }}>
                  My Claims
                </h2>
                <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>
                  {activeFY ? activeFY.label : 'All years'} · Recalls · Retain · Standby · M&D · Spoilt · Delayed meals
                </p>
              </div>

              <button
                onClick={() => {
                  setQuickActionType(null)
                  setShowNewClaimModal(true)
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '8px 16px', background: '#dc2626', border: 'none',
                  borderRadius: '8px', color: 'white', fontSize: '0.85rem',
                  fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                }}
              >
                <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>+</span>
                New Claim
              </button>
            </div>

            {/* ── Tabs + Filters ── */}
            <div style={{
              marginTop: '20px',
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px',
            }}>
              {/* Status tabs */}
              <div style={{
                display: 'flex', gap: '4px',
                background: '#111', borderRadius: '10px', padding: '4px',
                overflowX: 'auto',
              }}>
                {[
                  { key: 'all',        label: 'All' },
                  { key: 'pending',    label: 'Pending' },
                  { key: 'paid',       label: 'Paid' },
                  { key: 'payslip',    label: '📋 Payslip' },
                  { key: 'petty-cash', label: '💵 Petty Cash' },
                ].map(({ key, label }) => (
                  <button key={key} onClick={() => setActiveTab(key)}
                    style={tabStyle(activeTab === key)}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Sort + Type filter + Advanced filters toggle */}
              {activeTab !== 'payslip' && activeTab !== 'petty-cash' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
                    style={selectStyle}>
                    <option value="all">All types</option>
                    {CLAIM_TYPE_ORDER.map((t) => (
                      <option key={t} value={t}>{CLAIM_TYPE_LABELS[t]}</option>
                    ))}
                  </select>

                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                    style={selectStyle}>
                    <option value="date-desc">Newest first</option>
                    <option value="date-asc">Oldest first</option>
                    <option value="type">Sort by type</option>
                  </select>

                  <button
                    onClick={() => setShowAdvancedFilters((v) => !v)}
                    style={{
                      ...selectStyle,
                      background: showAdvancedFilters ? 'rgba(220,38,38,0.1)' : '#111',
                      border: showAdvancedFilters ? '1px solid rgba(220,38,38,0.3)' : '1px solid #2a2a2a',
                      borderRadius: '7px',
                      color: showAdvancedFilters ? '#fca5a5' : '#6b7280',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                      padding: '8px 14px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {showAdvancedFilters ? '▲ Less' : '▼ More filters'}
                  </button>
                </div>

                {/* ── Advanced Filters (Phase 4) ── */}
                {showAdvancedFilters && (
                  <div style={{
                    display: 'flex',
                    gap: '10px',
                    flexWrap: 'wrap',
                    padding: '12px 14px',
                    background: 'rgba(220,38,38,0.04)',
                    border: '1px solid rgba(220,38,38,0.15)',
                    borderRadius: '8px',
                    marginTop: '4px',
                  }}>
                    {/* Payment method filter */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '140px' }}>
                      <label style={LABEL_STYLE}>Payment Method</label>
                      <select
                        value={paymentMethodFilter || 'all'}
                        onChange={(e) => setPaymentMethodFilter(e.target.value === 'all' ? undefined : e.target.value)}
                        style={selectStyle}
                      >
                        <option value="all">All methods</option>
                        <option value="Payslip">Payslip</option>
                        <option value="Petty Cash">Petty Cash</option>
                      </select>
                    </div>

                    {/* Paid from date */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '140px' }}>
                      <label style={LABEL_STYLE}>Paid From</label>
                      <input
                        type="date"
                        value={paymentDateFrom}
                        onChange={(e) => setPaymentDateFrom(e.target.value)}
                        style={selectStyle}
                      />
                    </div>

                    {/* Paid to date */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '140px' }}>
                      <label style={LABEL_STYLE}>Paid To</label>
                      <input
                        type="date"
                        value={paymentDateTo}
                        onChange={(e) => setPaymentDateTo(e.target.value)}
                        style={selectStyle}
                      />
                    </div>

                    {/* Clear filters */}
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                      <button
                        onClick={() => {
                          setPaymentMethodFilter(undefined)
                          setPaymentDateFrom('')
                          setPaymentDateTo('')
                        }}
                        style={{
                          padding: '8px 14px',
                          background: 'transparent',
                          border: '1px solid #333',
                          borderRadius: '7px',
                          color: '#6b7280',
                          cursor: 'pointer',
                          fontSize: '0.82rem',
                          fontWeight: 600,
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}
                </div>
              )}

              {/* ── Claim content: three-way render ── */}
              {activeTab === 'payslip' ? (
                <GroupedClaimList session={session} activeFY={activeFY} />
              ) : activeTab === 'petty-cash' ? (
                <ExpandableClaimList
                  session={session}
                  activeFY={activeFY}
                  paymentMethod="Petty Cash"
                />
              ) : (
                <ExpandableClaimList
                  activeTab={activeTab}
                  filterType={filterType}
                  sortBy={sortBy}
                  paymentMethodFilter={paymentMethodFilter}
                  paymentDateFrom={paymentDateFrom}
                  paymentDateTo={paymentDateTo}
                  onEdit={setEditingClaim}
                  session={session}
                  activeFY={activeFY}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── New Claim Modal ── */}
        {showNewClaimModal && (
          <NewClaimModal
            session={session}
            activeFY={activeFY}
            onClose={handleCloseNewClaim}
            onSuccess={handleClaimSuccess}
            initialClaimType={quickActionType}
          />
        )}

        {/* ── Edit Claim Modal ── */}
        {editingClaim && (
          <EditClaimModal
            claim={editingClaim}
            session={session}
            activeFY={activeFY}
            onClose={() => setEditingClaim(null)}
            onSuccess={handleEditSuccess}
          />
        )}
      </div>
    </AppShell>
  )
}
