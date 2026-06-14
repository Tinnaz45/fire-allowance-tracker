'use client'

// ─── PaymentsDisabled — controlled "feature unavailable" view ─────────────────
// Rendered in place of the real Payments pages (/payments, /payments/imports)
// when the Payments / Reconciliation feature flag is OFF (see
// lib/featureFlags.js → isPaymentsEnabled). A direct URL to either route therefore
// never reaches the feature UI and never fires a backend call while disabled.
//
// Deliberately standalone (no AppShell, no session required, no data fetching) so
// it renders instantly and safely regardless of auth or backend availability.
// ─────────────────────────────────────────────────────────────────────────────

import { useRouter } from 'next/navigation'

export default function PaymentsDisabled() {
  const router = useRouter()

  return (
    <div style={{
      minHeight: '100vh', background: '#0f0f0f',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', boxSizing: 'border-box',
    }}>
      <div style={{ maxWidth: '420px', width: '100%', textAlign: 'center', color: '#e5e7eb' }}>
        <div style={{
          width: '48px', height: '48px', margin: '0 auto 16px',
          background: 'rgba(107,114,128,0.15)', border: '1px solid #2a2a2a',
          borderRadius: '12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="24" height="24" fill="none" stroke="#9ca3af" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: '1.2rem', fontWeight: 700, color: '#f9fafb' }}>
          Payments isn’t available yet
        </h1>
        <p style={{ margin: '0 0 20px', fontSize: '0.88rem', color: '#9ca3af', lineHeight: 1.5 }}>
          The Payments &amp; reconciliation tools are still being rolled out and are
          not enabled in this environment.
        </p>
        <button
          type="button"
          onClick={() => router.replace('/')}
          style={{
            padding: '10px 18px', background: '#dc2626', border: 'none',
            borderRadius: '8px', color: '#fff', fontSize: '0.88rem', fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Back to Dashboard
        </button>
      </div>
    </div>
  )
}
