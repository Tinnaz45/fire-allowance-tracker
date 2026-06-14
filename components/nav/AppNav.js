'use client'

// ─── AppNav — Shared Authenticated Bottom Tab Bar ─────────────────────────────
// Single source of truth for all authenticated navigation.
// Rendered inside AppShell. Never import this directly — use AppShell instead.
//
// Tabs:   Dashboard (/)  ·  Tax (/tax)  ·  Payments (/payments)*  ·  Profile (/profile)  ·  Settings (/settings)
//   * The Payments tab is shown only when the Payments feature flag is enabled
//     (lib/featureFlags.js → isPaymentsEnabled). Hidden in PROD until the backend
//     rollout completes; the routes themselves are independently guarded.
//
// Active-route logic:
//   - '/'        → exact match only
//   - '/tax'     → startsWith('/tax')
//   - '/payments'→ startsWith('/payments')
//   - '/profile' → startsWith('/profile')
//   - '/settings'→ startsWith('/settings')
//   Future deep routes (e.g. /claims/[id]) resolve to the nearest parent tab.
// ─────────────────────────────────────────────────────────────────────────────

import { usePathname, useRouter } from 'next/navigation'
import { isPaymentsEnabled } from '@/lib/featureFlags'

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    href: '/',
    match: (p) => p === '/',
    icon: (active) => (
      <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    key: 'tax',
    label: 'Tax',
    href: '/tax',
    match: (p) => p.startsWith('/tax'),
    icon: (active) => (
      <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8}
          d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    key: 'payments',
    label: 'Payments',
    href: '/payments',
    match: (p) => p.startsWith('/payments'),
    icon: (active) => (
      <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8}
          d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
      </svg>
    ),
  },
  {
    key: 'profile',
    label: 'Profile',
    href: '/profile',
    match: (p) => p.startsWith('/profile'),
    icon: (active) => (
      <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
  },
  {
    key: 'settings',
    label: 'Rates',
    href: '/settings',
    match: (p) => p.startsWith('/settings'),
    icon: (active) => (
      <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
]

// ─── AppNav component ─────────────────────────────────────────────────────────

export default function AppNav() {
  const pathname = usePathname()
  const router = useRouter()

  // Hide the Payments tab unless its feature flag is enabled. SSR-safe (env-only),
  // so server and client render the same tab set — no hydration mismatch.
  const tabs = TABS.filter((tab) => tab.key !== 'payments' || isPaymentsEnabled())

  return (
    <>
      {/* Bottom nav bar — fixed, safe-area aware */}
      <nav
        aria-label="Main navigation"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          // Safe-area padding for iPhone notch / Dynamic Island / home indicator
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          background: '#111111',
          borderTop: '1px solid #222222',
          display: 'flex',
          alignItems: 'stretch',
          zIndex: 900,
          // Prevent layout shift by giving the bar a fixed intrinsic height
          minHeight: '56px',
        }}
      >
        {tabs.map((tab) => {
          const active = tab.match(pathname)
          return (
            <button
              key={tab.key}
              onClick={() => {
                if (!active) router.push(tab.href)
              }}
              aria-current={active ? 'page' : undefined}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '3px',
                padding: '8px 4px',
                background: 'none',
                border: 'none',
                cursor: active ? 'default' : 'pointer',
                color: active ? '#dc2626' : '#6b7280',
                transition: 'color 0.15s',
                WebkitTapHighlightColor: 'transparent',
                outline: 'none',
                minWidth: 0,
              }}
            >
              {tab.icon(active)}
              <span style={{
                fontSize: '0.65rem',
                fontWeight: active ? 700 : 500,
                letterSpacing: '0.02em',
                lineHeight: 1,
                // Prevent text wrapping on narrow phones
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '100%',
              }}>
                {tab.label}
              </span>
              {/* Active indicator dot */}
              {active && (
                <span style={{
                  position: 'absolute',
                  top: '6px',
                  width: '4px',
                  height: '4px',
                  borderRadius: '50%',
                  background: '#dc2626',
                }} />
              )}
            </button>
          )
        })}
      </nav>

      {/* Spacer so page content isn't hidden behind the fixed nav bar.
          Height = 56px bar + safe-area inset. */}
      <div style={{
        height: 'calc(56px + env(safe-area-inset-bottom, 0px))',
        flexShrink: 0,
        pointerEvents: 'none',
      }} aria-hidden="true" />
    </>
  )
}
