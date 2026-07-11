'use client'

// ─── Payment Records page (/payments) ─────────────────────────────────────────
// Phase 3 reconciliation operator surface (MVP). Lets a user manually create
// payment records, link them to engine-generated entitlements, and observe
// reconciliation status end-to-end — entirely through the canonical service
// layer (lib/fat/services/*). DEV-scoped MVP: manual source only, no OCR, no
// auto-matcher (PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md § 8).
//
// owner_id / actor_id = the authenticated user (session.user.id); RLS enforces
// owner-only access on every canonical read/write.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/nav/AppShell'
import CreatePaymentRecordForm from '@/components/reconciliation/CreatePaymentRecordForm'
import ReconciliationQueues from '@/components/reconciliation/ReconciliationQueues'
import PaymentRecordsList from '@/components/reconciliation/PaymentRecordsList'
import EntitlementReconciliationModal from '@/components/reconciliation/EntitlementReconciliationModal'
import { Banner } from '@/components/reconciliation/ui'
import { isPaymentsEnabled } from '@/lib/featureFlags'
import { featureEnabled } from '@/lib/features'
import { useProfile } from '@/lib/profile/ProfileContext'
import PaymentsDisabled from '@/components/payments/PaymentsDisabled'

export default function PaymentRecordsPage() {
  const router = useRouter()
  const globalOn = isPaymentsEnabled()
  // Session + per-user feature flags come from the shared post-login load.
  const { user, featureFlags, loading } = useProfile()
  const allowed = featureEnabled(featureFlags, 'payments')

  // Bumped after any mutation so every data panel re-fetches from the service.
  const [reloadToken, setReloadToken] = useState(0)
  const bump = useCallback(() => setReloadToken((n) => n + 1), [])

  // The entitlement whose reconciliation drawer is open.
  const [activeEntitlementId, setActiveEntitlementId] = useState(null)

  useEffect(() => {
    // Redirect unauthenticated users to login — but only when the feature is
    // globally on. When it's off we short-circuit to the unavailable view below
    // with no auth/work, exactly as before.
    if (globalOn && !loading && !user) router.replace('/login')
  }, [globalOn, loading, user, router])

  // Global env kill-switch: controlled unavailable page (no AppShell, no backend
  // calls), instantly, regardless of auth.
  if (!globalOn) return <PaymentsDisabled />

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

  if (!user) return null

  // Per-user gate: a signed-in user without the flag sees exactly the same
  // unavailable view as when Payments is globally disabled — no hint it exists.
  if (!allowed) return <PaymentsDisabled />

  const ownerId = user.id

  return (
    <AppShell>
      <div style={{ color: '#e5e7eb', padding: '24px 16px', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '40px', height: '40px', background: '#dc2626', borderRadius: '10px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="22" height="22" fill="none" stroke="white" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#f9fafb' }}>
                Payment Records
              </h1>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>{user.email}</p>
            </div>
            <button
              type="button"
              onClick={() => router.push('/payments/imports')}
              style={{
                padding: '8px 14px', background: 'transparent', border: '1px solid #333',
                borderRadius: '8px', color: '#9ca3af', fontSize: '0.82rem', fontWeight: 600,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              OCR Imports →
            </button>
          </div>

          <Banner tone="info">
            <strong>Reconciliation (MVP)</strong> — record the payslip lines and petty-cash submissions
            you actually receive, then link them to your generated entitlements. Linking a payslip line
            settles a payslip entitlement; petty cash settles once its full amount is allocated.
          </Banner>

          {/* Objective 3 — create */}
          <CreatePaymentRecordForm ownerId={ownerId} onCreated={bump} />

          {/* Objectives 2 + 5 — queues */}
          <ReconciliationQueues
            ownerId={ownerId}
            reloadToken={reloadToken}
            onSelectEntitlement={(ent) => setActiveEntitlementId(ent.id)}
          />

          {/* Objective 5 (record side) */}
          <PaymentRecordsList ownerId={ownerId} reloadToken={reloadToken} />

        </div>
      </div>

      {/* Objectives 4, 6, 7, 8 — per-entitlement reconciliation drawer */}
      {activeEntitlementId && (
        <EntitlementReconciliationModal
          entitlementId={activeEntitlementId}
          ownerId={ownerId}
          onClose={() => setActiveEntitlementId(null)}
          onChanged={bump}
        />
      )}
    </AppShell>
  )
}
