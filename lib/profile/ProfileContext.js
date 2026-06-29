'use client'

// ─── Profile Context — authenticated profile + per-user feature flags ─────────
// The single shared post-login load. Wraps the authenticated app (mounted in
// app/layout.js) and resolves, ONCE per signed-in user:
//   - the auth session / user
//   - the user's per-user feature flags (lib/features → getUserFeatures)
//
// This is the SINGLE SOURCE OF TRUTH for the loaded profile and feature_flags.
// UI components read `featureFlags` from here and evaluate it with the existing
// synchronous helper featureEnabled(featureFlags, 'payments') — they do NOT
// re-query. The async hasFeature() helper remains for server-side / non-UI
// callers that must resolve features independently.
//
// No polling, no new API endpoint, no probe endpoint: feature flags load with the
// session and refresh only on an auth state change (sign in / sign out).
//
// Per-user flags only matter when the global Payments kill-switch is on, so the
// flag query is skipped entirely when isPaymentsEnabled() is false (e.g. PROD) —
// that avoids a pointless owner-scoped query (and any error where the DEV-only
// table is absent) while still resolving to "no access", consistent with the
// global gate.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { getUserFeatures } from '@/lib/features'
import { isPaymentsEnabled } from '@/lib/featureFlags'

const ProfileContext = createContext({
  session: null,
  user: null,
  featureFlags: {},
  loading: true,
})

export function ProfileProvider({ children }) {
  const [session, setSession] = useState(null)
  const [featureFlags, setFeatureFlags] = useState({})
  const [authReady, setAuthReady] = useState(false)   // session resolved?
  const [flagsLoading, setFlagsLoading] = useState(true)

  // 1. Track the auth session. onAuthStateChange emits the initial session and
  //    every subsequent sign-in/sign-out, so this is the only auth listener the
  //    app needs. We do NOT call other Supabase methods inside the callback
  //    (that can deadlock the auth lock) — flag loading happens in effect (2).
  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session ?? null)
      setAuthReady(true)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (!active) return
      setSession(sess ?? null)
      setAuthReady(true)
    })

    return () => { active = false; sub.subscription.unsubscribe() }
  }, [])

  // 2. Load the per-user feature flags whenever the authenticated user changes.
  //    Keyed on the user id so it runs once per signed-in user, not per render.
  const userId = session?.user?.id ?? null
  useEffect(() => {
    if (!authReady) return

    // Logged out, or global Payments kill-switch off → no per-user query.
    if (!userId || !isPaymentsEnabled()) {
      setFeatureFlags({})
      setFlagsLoading(false)
      return
    }

    let active = true
    setFlagsLoading(true)
    getUserFeatures({ userId }).then((flags) => {
      if (!active) return
      setFeatureFlags(flags)
      setFlagsLoading(false)
    })
    return () => { active = false }
  }, [authReady, userId])

  const value = useMemo(() => ({
    session,
    user: session?.user ?? null,
    featureFlags,
    loading: !authReady || flagsLoading,
  }), [session, featureFlags, authReady, flagsLoading])

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

/**
 * Read the shared profile context: { session, user, featureFlags, loading }.
 * `featureFlags` is the loaded per-user feature object — evaluate it with
 * featureEnabled(featureFlags, name); never re-query feature data in the UI.
 */
export function useProfile() {
  return useContext(ProfileContext)
}
