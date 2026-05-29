'use client'

// ─── InfoPopover ──────────────────────────────────────────────────────────────
// Small "i" icon that opens a click-to-toggle popover panel. Used beside
// claim-form headings to surface EBA wording without bloating the layout.
// Pure presentational — content is passed in as children.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'

export default function InfoPopover({ label = 'More info', children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 18, height: 18, lineHeight: '16px',
          borderRadius: '50%',
          background: open ? '#0ea5e9' : 'rgba(14,165,233,0.18)',
          color: open ? '#fff' : '#38bdf8',
          border: '1px solid rgba(14,165,233,0.45)',
          fontSize: '0.7rem', fontWeight: 700,
          cursor: 'pointer', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          marginLeft: 6,
        }}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 20,
            width: 280,
            background: '#0b0b0b',
            border: '1px solid rgba(14,165,233,0.35)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: '0.78rem',
            color: '#d1d5db',
            lineHeight: 1.5,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
            textTransform: 'none',
            letterSpacing: 'normal',
            fontWeight: 400,
          }}
        >
          {children}
        </div>
      )}
    </span>
  )
}
