'use client'

// ─── OCR Imports page (/payments/imports) ─────────────────────────────────────
// The review surface for the payslip-import staging pipeline. The backend
// (payslip_imports / payslip_import_lines, ManualEntryAdapter, lifecycle engine,
// confirm bridge) was already built + validated; this page is the operator's only
// window into it. It is a PRODUCER surface that feeds /payments — confirming a
// line creates a canonical payment record (and optionally links it to an
// entitlement) which then reconciles on the Payments page.
//
// MVP scope (constraints): two ingestion sources — manual entry AND screenshot
// upload (file capture + storage only). NO OCR, NO AI extraction, NO PDF parsing,
// no auto-matching. An uploaded screenshot rests at status 'uploaded' with zero
// lines, held for future extraction. Everything flows through the existing staging
// services. DEV-scoped. owner_id / actor_id = the authenticated user; RLS enforces
// owner-only on every canonical read/write (incl. the private screenshot bucket).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import AppShell from '@/components/nav/AppShell'
import { Banner } from '@/components/reconciliation/ui'
import CreateImportForm from '@/components/payslip/CreateImportForm'
import ScreenshotUploadForm from '@/components/payslip/ScreenshotUploadForm'
import ImportsList from '@/components/payslip/ImportsList'
import ImportDetail from '@/components/payslip/ImportDetail'
import { isPaymentsEnabled } from '@/lib/featureFlags'
import PaymentsDisabled from '@/components/payments/PaymentsDisabled'

export default function PayslipImportsPage() {
  const router = useRouter()
  const enabled = isPaymentsEnabled()
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [reloadToken, setReloadToken] = useState(0)
  const bump = useCallback(() => setReloadToken((n) => n + 1), [])

  const [selectedId, setSelectedId] = useState(null)

  useEffect(() => {
    // Skip auth/session work entirely when the feature is disabled — the page
    // short-circuits to the controlled unavailable view below.
    if (!enabled) return
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return }
      setSession(data.session)
      setAuthLoading(false)
    })
  }, [router, enabled])

  // Feature-flag guard: render a controlled unavailable page (no AppShell, no
  // backend calls) when Payments is disabled in this environment.
  if (!enabled) return <PaymentsDisabled />

  if (authLoading) {
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

  const ownerId = session.user.id

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
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#f9fafb' }}>
                OCR Imports
              </h1>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>{session.user.email}</p>
            </div>
            <button
              type="button"
              onClick={() => router.push('/payments')}
              style={{
                padding: '8px 14px', background: 'transparent', border: '1px solid #333',
                borderRadius: '8px', color: '#9ca3af', fontSize: '0.82rem', fontWeight: 600,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              ← Payments
            </button>
          </div>

          <Banner tone="info">
            <strong>Payslip imports (MVP)</strong> — type a payslip’s lines <em>or</em> upload a screenshot,
            review, then confirm, reject, or supersede each line. Likely entitlement matches are
            <strong> suggested automatically</strong> with a confidence score, but you confirm every line —
            nothing is auto-confirmed. Confirming a line creates a payment record (and optionally links it to an
            entitlement) that reconciles on the Payments page. Uploaded screenshots are <strong>stored and tracked</strong>;
            automatic OCR extraction runs only where an OCR provider is configured — otherwise use Manual entry.
          </Banner>

          {/* Objective 1 — manual entry create */}
          <CreateImportForm
            ownerId={ownerId}
            onCreated={(imp) => { setSelectedId(imp.id); bump() }}
          />

          {/* First real ingestion source — screenshot upload */}
          <ScreenshotUploadForm
            ownerId={ownerId}
            onCreated={(imp) => { setSelectedId(imp.id); bump() }}
          />

          {/* Objectives 2 + 3 — list + lifecycle */}
          <ImportsList
            ownerId={ownerId}
            reloadToken={reloadToken}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />

          {/* Objectives 4–9 — selected import detail */}
          {selectedId && (
            <ImportDetail
              importId={selectedId}
              ownerId={ownerId}
              reloadToken={reloadToken}
              onChanged={bump}
              onSelectImport={(id) => { setSelectedId(id); bump() }}
            />
          )}

        </div>
      </div>
    </AppShell>
  )
}
