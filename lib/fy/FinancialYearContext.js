'use client'

// ─── Financial Year Context ────────────────────────────────────────────────────
// Manages the active financial year workspace.
//
// On first load, if no FY records exist for the user, the current FY is
// auto-created. The active FY is stored in Supabase (is_active flag) so it
// persists across sessions on the same device.
//
// All claim loading and tax summaries should filter by the active FY's
// start_date / end_date.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback } from 'react'
import { fat } from '@/lib/supabaseClient'
import { getFYLabel, getFYDateRange, currentFYLabel } from '@/lib/calculations/engine'

// ─── Context ──────────────────────────────────────────────────────────────────

const FinancialYearContext = createContext(null)

// ─── Provider ─────────────────────────────────────────────────────────────────

export function FinancialYearProvider({ children }) {
  const [allFYs, setAllFYs]         = useState([])   // all FY rows for user
  const [activeFY, setActiveFY]     = useState(null) // the currently selected FY row
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)
  const [userId, setUserId]         = useState(null)

  // ── Load (and auto-create if needed) all FYs for a user ──────────────────

  const loadFYs = useCallback(async (uid) => {
    if (!uid) return
    setUserId(uid)
    setLoading(true)
    setError(null)

    try {
      // Fetch all FY rows for this user
      const { data: fyRows, error: fetchError } = await fat
        .from('financial_years')
        .select('*')
        .eq('user_id', uid)
        .order('start_date', { ascending: false })

      if (fetchError) throw fetchError

      let rows = fyRows || []

      // Auto-create current FY if the user has no FYs at all
      if (rows.length === 0) {
        const label = currentFYLabel()
        const { start, end } = getFYDateRange(label)
        const { data: newRow, error: insertError } = await fat
          .from('financial_years')
          .insert({
            user_id:    uid,
            label,
            start_date: start,
            end_date:   end,
            is_active:  true,
          })
          .select()
          .single()

        if (insertError) throw insertError
        rows = [newRow]
      }

      // Ensure exactly one row has is_active = true
      let active = rows.find((r) => r.is_active) || rows[0]

      // If none are flagged active (shouldn't happen, but guard), flag the first
      if (!rows.some((r) => r.is_active)) {
        await fat
          .from('financial_years')
          .update({ is_active: true })
          .eq('id', active.id)
        active = { ...active, is_active: true }
      }

      setAllFYs(rows)
      setActiveFY(active)
    } catch (err) {
      console.error('[FY] Load failed:', err)
      setError('Could not load financial year data.')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Switch the active FY ──────────────────────────────────────────────────

  const switchFY = useCallback(async (fyId) => {
    if (!userId) return
    try {
      // Clear all is_active, then set the chosen one
      await fat
        .from('financial_years')
        .update({ is_active: false })
        .eq('user_id', userId)

      await fat
        .from('financial_years')
        .update({ is_active: true })
        .eq('id', fyId)

      const chosen = allFYs.find((r) => r.id === fyId)
      if (chosen) {
        setActiveFY({ ...chosen, is_active: true })
        setAllFYs((prev) => prev.map((r) => ({ ...r, is_active: r.id === fyId })))
      }
    } catch (err) {
      console.error('[FY] Switch failed:', err)
    }
  }, [userId, allFYs])

  // ── Create a new FY ───────────────────────────────────────────────────────

  const createFY = useCallback(async (label) => {
    if (!userId) return null
    // Prevent duplicates
    if (allFYs.some((r) => r.label === label)) {
      return allFYs.find((r) => r.label === label)
    }

    const { start, end } = getFYDateRange(label)
    const { data: newRow, error: insertError } = await fat
      .from('financial_years')
      .insert({
        user_id:    userId,
        label,
        start_date: start,
        end_date:   end,
        is_active:  false,
      })
      .select()
      .single()

    if (insertError) throw insertError

    setAllFYs((prev) => [newRow, ...prev])
    return newRow
  }, [userId, allFYs])

  // ── Compute available FY labels (to show in the "add new" dropdown) ───────

  const availableFYLabels = (() => {
    const existing = new Set(allFYs.map((r) => r.label))
    // Offer current FY ± 2 years
    const now = new Date()
    const base = parseInt(currentFYLabel().replace('FY', ''), 10)
    const labels = []
    for (let y = base - 1; y <= base + 2; y++) {
      const lbl = `${y}FY`
      if (!existing.has(lbl)) labels.push(lbl)
    }
    return labels
  })()

  return (
    <FinancialYearContext.Provider value={{
      allFYs,
      activeFY,
      loading,
      error,
      loadFYs,
      switchFY,
      createFY,
      availableFYLabels,
    }}>
      {children}
    </FinancialYearContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFY() {
  const ctx = useContext(FinancialYearContext)
  if (!ctx) throw new Error('useFY must be used inside <FinancialYearProvider>')
  return ctx
}
