'use client'

// ─── Allowance Rate Settings Page ─────────────────────────────────────────────
// Allows users to view and edit their personal allowance rates.
// Falls back to DEFAULT_RATES when no user overrides exist.
// All changes are persisted to fat.user_rates in Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useRates } from '@/lib/calculations/RatesContext'
import { DEFAULT_RATES, RATE_FIELDS } from '@/lib/calculations/defaultRates'
import AppShell from '@/components/nav/AppShell'

// ─── Shared styles ────────────────────────────────────────────────────────────

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

const HELP_STYLE = {
  marginTop: '4px',
  fontSize: '0.74rem',
  color: '#6b7280',
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter()
  const { rates, loading: ratesLoading, error: ratesError, saveRates, resetRates, loadRates } = useRates()

  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [formValues, setFormValues] = useState({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [successMessage, setSuccessMessage] = useState(null)
  const [formError, setFormError] = useState(null)

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return }
      setSession(data.session)
      setAuthLoading(false)
      loadRates(data.session.user.id)
    })
  }, [router, loadRates])

  // Sync form values when rates load
  useEffect(() => {
    const vals = {}
    for (const field of RATE_FIELDS) {
      vals[field.key] = String(rates[field.key] ?? DEFAULT_RATES[field.key] ?? '')
    }
    setFormValues(vals)
    setDirty(false)
  }, [rates])

  // ── Form handlers ─────────────────────────────────────────────────────────

  const handleChange = (key, value) => {
    setFormValues((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
    setSuccessMessage(null)
    setFormError(null)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    setFormError(null)

    for (const field of RATE_FIELDS) {
      const raw = formValues[field.key]
      const num = Number(raw)
      if (raw === '' || isNaN(num)) { setFormError(`"${field.label}" must be a number.`); return }
      if (num < field.min) { setFormError(`"${field.label}" must be at least ${field.min}.`); return }
      if (num > field.max) { setFormError(`"${field.label}" must be at most ${field.max}.`); return }
    }

    setSaving(true)
    try {
      const newRates = {}
      for (const field of RATE_FIELDS) {
        newRates[field.key] = Number(formValues[field.key])
      }
      await saveRates(newRates)
      setDirty(false)
      setSuccessMessage('Rates saved. New claims will use these values.')
      setTimeout(() => setSuccessMessage(null), 4000)
    } catch (err) {
      setFormError(err.message || 'Failed to save rates. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!window.confirm('Reset all rates back to system defaults? Your saved overrides will be deleted.')) return
    setResetting(true)
    setFormError(null)
    try {
      await resetRates()
      setSuccessMessage('Rates reset to system defaults.')
      setTimeout(() => setSuccessMessage(null), 4000)
    } catch (err) {
      setFormError(err.message || 'Failed to reset rates.')
    } finally {
      setResetting(false)
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────

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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppShell>
      <div style={{ color: '#e5e7eb', padding: '32px 20px', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '640px', margin: '0 auto' }}>

          {/* Header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                width: '40px', height: '40px', background: '#dc2626',
                borderRadius: '10px', display: 'flex', alignItems: 'center',
                justifyContent: 'center', flexShrink: 0,
              }}>
                <svg width="22" height="22" fill="none" stroke="white" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#f9fafb' }}>
                  Allowance Rates
                </h1>
                <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>
                  {session?.user?.email}
                </p>
              </div>
            </div>
          </div>

          {/* Info banner */}
          <div style={{
            marginBottom: '24px',
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.2)',
            color: '#93c5fd',
            borderRadius: '10px',
            padding: '12px 16px',
            fontSize: '0.82rem',
            lineHeight: 1.5,
          }}>
            <strong>Your personal rates</strong> — these values are used when auto-calculating new claims.
            Existing claims are never changed when you update these. Review rates annually when your enterprise
            agreement or ATO rates change.
          </div>

          {ratesError && (
            <div style={{
              marginBottom: '20px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171',
              borderRadius: '10px',
              padding: '12px 16px',
              fontSize: '0.875rem',
            }}>
              {ratesError}
            </div>
          )}

          {successMessage && (
            <div style={{
              marginBottom: '20px',
              background: 'rgba(34,197,94,0.1)',
              border: '1px solid rgba(34,197,94,0.3)',
              color: '#4ade80',
              borderRadius: '10px',
              padding: '12px 16px',
              fontSize: '0.875rem', fontWeight: 500,
            }}>
              ✓ {successMessage}
            </div>
          )}

          {/* Rates form */}
          <form onSubmit={handleSave} noValidate>
            <div style={{
              background: '#1a1a1a', border: '1px solid #2a2a2a',
              borderRadius: '16px', padding: '24px',
            }}>
              <h2 style={{ margin: '0 0 20px 0', fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' }}>
                Allowance Rates
              </h2>

              {ratesLoading ? (
                <p style={{ color: '#9ca3af', fontSize: '0.9rem' }}>Loading your rates…</p>
              ) : (
                RATE_FIELDS.map((field) => (
                  <div key={field.key} style={{ marginBottom: '20px' }}>
                    <label style={LABEL_STYLE}>
                      {field.label}
                      <span style={{ marginLeft: '8px', color: '#6b7280', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                        ({field.unit})
                      </span>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <span style={{
                        position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
                        color: '#6b7280', fontSize: '0.9rem', pointerEvents: 'none',
                        display: field.unit === '$' || field.unit === '$/km' ? 'block' : 'none',
                      }}>$</span>
                      <input
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={formValues[field.key] ?? ''}
                        onChange={(e) => handleChange(field.key, e.target.value)}
                        style={{
                          ...INPUT_STYLE,
                          paddingLeft: (field.unit === '$' || field.unit === '$/km') ? '26px' : '12px',
                        }}
                      />
                    </div>
                    <p style={HELP_STYLE}>{field.help}</p>
                    <p style={{ ...HELP_STYLE, marginTop: '2px' }}>
                      System default: ${DEFAULT_RATES[field.key]}
                      {Number(formValues[field.key]) !== DEFAULT_RATES[field.key] && formValues[field.key] !== '' && (
                        <span style={{ marginLeft: '8px', color: '#f59e0b' }}>✎ modified</span>
                      )}
                    </p>
                  </div>
                ))
              )}
            </div>

            {formError && (
              <div style={{
                marginTop: '16px',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: '#f87171',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '0.85rem',
              }}>
                {formError}
              </div>
            )}

            {/* Actions */}
            <div style={{ marginTop: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="submit"
                disabled={saving || ratesLoading || !dirty}
                style={{
                  flex: 1, minWidth: '140px',
                  padding: '11px 16px',
                  background: (saving || !dirty) ? '#7f1d1d' : '#dc2626',
                  border: 'none', borderRadius: '8px',
                  color: 'white', cursor: (saving || !dirty) ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem', fontWeight: 600,
                  transition: 'background 0.15s',
                }}
              >
                {saving ? 'Saving…' : 'Save Rates'}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={resetting || ratesLoading}
                style={{
                  padding: '11px 16px',
                  background: 'transparent',
                  border: '1px solid #333', borderRadius: '8px',
                  color: '#9ca3af', cursor: resetting ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem', fontWeight: 600,
                }}
              >
                {resetting ? 'Resetting…' : 'Reset to Defaults'}
              </button>
            </div>
          </form>

        </div>
      </div>
    </AppShell>
  )
}
