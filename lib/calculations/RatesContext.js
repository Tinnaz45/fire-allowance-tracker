'use client'

// ─── Rates Context ─────────────────────────────────────────────────────────────
// Loads user allowance rates from Supabase, merges them over DEFAULT_RATES,
// and exposes the active rates to all components via useRates().
//
// Architecture:
//   - RatesProvider wraps the app in layout.js (alongside ClaimsProvider).
//   - useRates() returns { rates, loading, error, saveRates }.
//   - All calculation functions in engine.js receive rates as a parameter.
//   - If no user row exists in fat.user_rates, DEFAULT_RATES are used.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { fat } from '@/lib/supabaseClient'
import { DEFAULT_RATES } from '@/lib/calculations/defaultRates'

// ─── Context ──────────────────────────────────────────────────────────────────

const RatesContext = createContext(null)

// ─── Column map: JS camelCase ↔ Supabase snake_case ──────────────────────────

const DB_TO_RATES = {
  kilometre_rate:               'kilometreRate',
  small_meal_allowance:         'smallMealAllowance',
  large_meal_allowance:         'largeMealAllowance',
  double_meal_allowance:        'doubleMealAllowance',
  spoilt_meal_allowance:        'spoiltMealAllowance',
  delayed_meal_allowance:       'delayedMealAllowance',
  overnight_allowance:          'overnightAllowance',
  standby_night_meal_allowance: 'standbyNightMealAllowance',
}

const RATES_TO_DB = Object.fromEntries(
  Object.entries(DB_TO_RATES).map(([db, js]) => [js, db])
)

// Convert a DB row to a rates object (merged over defaults for safety)
function dbRowToRates(row) {
  const rates = { ...DEFAULT_RATES }
  if (!row) return rates
  for (const [dbKey, jsKey] of Object.entries(DB_TO_RATES)) {
    if (row[dbKey] != null) {
      rates[jsKey] = Number(row[dbKey])
    }
  }
  return rates
}

// Convert a rates object to a DB-insertable row
function ratesToDbRow(userId, rates) {
  const row = { user_id: userId }
  for (const [jsKey, dbKey] of Object.entries(RATES_TO_DB)) {
    if (rates[jsKey] != null) {
      row[dbKey] = Number(rates[jsKey])
    }
  }
  return row
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function RatesProvider({ children }) {
  const [rates, setRates]   = useState(DEFAULT_RATES)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState(null)
  const [userId, setUserId] = useState(null)

  // ── Load rates for a given user ───────────────────────────────────────────

  const loadRates = useCallback(async (uid) => {
    if (!uid) return
    setUserId(uid)
    setLoading(true)
    setError(null)

    try {
      const { data, error: fetchError } = await fat
        .from('user_rates')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle()   // returns null (not error) if row doesn't exist

      if (fetchError) throw fetchError

      // Merge saved rates over defaults — handles missing/new columns gracefully
      setRates(dbRowToRates(data))
    } catch (err) {
      console.error('[Rates] Load failed:', err)
      setError('Could not load your rate settings. Using default rates.')
      setRates(DEFAULT_RATES) // safe fallback — app remains functional
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Save / upsert rates ───────────────────────────────────────────────────

  const saveRates = useCallback(async (newRates) => {
    if (!userId) throw new Error('No user session — cannot save rates.')

    const row = ratesToDbRow(userId, newRates)

    const { error: upsertError } = await fat
      .from('user_rates')
      .upsert(row, { onConflict: 'user_id' })

    if (upsertError) throw upsertError

    // Update local state immediately so UI reflects changes without re-fetching
    setRates({ ...DEFAULT_RATES, ...newRates })
  }, [userId])

  // ── Reset rates to defaults ───────────────────────────────────────────────

  const resetRates = useCallback(async () => {
    if (!userId) throw new Error('No user session — cannot reset rates.')

    const { error: deleteError } = await fat
      .from('user_rates')
      .delete()
      .eq('user_id', userId)

    if (deleteError) throw deleteError
    setRates(DEFAULT_RATES)
  }, [userId])

  return (
    <RatesContext.Provider value={{ rates, loading, error, loadRates, saveRates, resetRates }}>
      {children}
    </RatesContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRates() {
  const ctx = useContext(RatesContext)
  if (!ctx) throw new Error('useRates must be used inside <RatesProvider>')
  return ctx
}
