'use client'

// ─── ClaimForm ─────────────────────────────────────────────────────────────────
// Operational claim creation form with:
//   - Recall: correct route (Home→Roster→Recall→Roster→Home), double meal option
//   - Standby: 1900 boundary rule, M&D no-meal, Show Calculation
//   - Spoilt/Delayed: Day/Night windows, time entry, window indicator
//   - Adjusted amount override with revert
//   - Show Calculation panel for all types
//   - Profile pre-fill for rostered station
//   - financialYearId prop wired into addClaim for FY + numbering
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { useRates } from '@/lib/calculations/RatesContext'
import { CLAIM_TYPE_ORDER, CLAIM_TYPE_LABELS } from '@/lib/claims/claimTypes'
import StationDistanceField from '@/components/distance/StationDistanceField'
import RecallLegDistanceField from '@/components/distance/RecallLegDistanceField'
import StandbyDistanceField from '@/components/distance/StandbyDistanceField'
import ShiftPicker from '@/components/claims/ShiftPicker'
import StationPicker from '@/components/claims/StationPicker'
import TimeInput24 from '@/components/claims/TimeInput24'
import {
  composeStationLabel,
  getExplicitlyResolvedStation,
} from '@/lib/distance/stationParser'
import {
  calcRecallClaim,
  calculateRecallMealEntitlements,
  calcRetainClaim,
  calcRetainMealEligibility,
  calcStandbyClaim,
  calcSpoiltClaim,
  isStandbyNightMealEligible,
  getMealWindow,
  checkTimeInMealWindow,
  buildRecallCalcLines,
  buildRetainCalcLines,
  buildStandbyCalcLines,
  buildSpoiltCalcLines,
  buildCalcSnapshot,
  roundMoney,
} from '@/lib/calculations/engine'
import { fat } from '@/lib/supabaseClient'
import InfoPopover from '@/components/claims/InfoPopover'

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

const FIELD = { marginBottom: '16px' }
const HELP_STYLE = { marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' }

// ─── Show Calculation Panel ───────────────────────────────────────────────────

function ShowCalcPanel({ lines, onClose }) {
  if (!lines || lines.length === 0) return null
  return (
    <div style={{
      background: '#111',
      border: '1px solid #2a2a2a',
      borderRadius: '10px',
      padding: '14px 16px',
      marginBottom: '16px',
      fontSize: '0.82rem',
      lineHeight: 1.7,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '10px',
      }}>
        <span style={{ fontSize: '0.74rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          How this is calculated
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}>x</button>
      </div>
      {lines.map((line, i) => {
        const isHeader = line.startsWith('--')
        const isTotal  = line.includes('Total:')
        return (
          <div key={i} style={{
            color: isTotal ? '#f9fafb' : isHeader ? '#dc2626' : '#d1d5db',
            fontWeight: isTotal || isHeader ? 700 : 400,
            paddingLeft: line.startsWith('  ') ? '12px' : '0',
            marginBottom: isHeader ? '4px' : '0',
          }}>
            {line.trim()}
          </div>
        )
      })}
    </div>
  )
}

// ─── Calculation Preview ──────────────────────────────────────────────────────

function CalcPreview({ breakdown, rates, onShowCalc }) {
  if (!breakdown) return null

  const lines = []
  if (breakdown.travelAmount > 0)  lines.push('Travel: $' + breakdown.travelAmount.toFixed(2) + (breakdown.totalKm != null ? ' (' + breakdown.totalKm + ' km x $' + (rates.kilometreRate?.toFixed(2) || '0.99') + ')' : ''))
  if (breakdown.mealieAmount > 0)  lines.push('Meal allowance: $' + breakdown.mealieAmount.toFixed(2))
  if (breakdown.nightMealie > 0)   lines.push('Night meal: $' + breakdown.nightMealie.toFixed(2))
  if (breakdown.mealAmount > 0)    lines.push((breakdown.mealLabel ? breakdown.mealLabel + ': ' : 'Meal allowance: ') + '$' + breakdown.mealAmount.toFixed(2))
  if (breakdown.generatedHours > 0) {
    const hrs    = breakdown.generatedHours.toFixed(2)
    const rate   = (breakdown.retainHourlyRate ?? 0).toFixed(2)
    const amount = breakdown.retainAmount.toFixed(2)
    if (breakdown.retainHourlyRate > 0) {
      lines.push(`Retain: ${hrs} h × $${rate}/h = $${amount}`)
    } else {
      lines.push(`Retain: ${hrs} h (set retain hourly rate in Settings to derive $)`)
    }
  } else if (breakdown.retainAmount > 0) {
    lines.push('Retain: $' + breakdown.retainAmount.toFixed(2))
  }
  if (breakdown.overnightCash > 0) lines.push('Overnight: $' + breakdown.overnightCash.toFixed(2))

  return (
    <div style={{
      background: 'rgba(220,38,38,0.07)',
      border: '1px solid rgba(220,38,38,0.2)',
      borderRadius: '8px',
      padding: '10px 14px',
      marginBottom: '16px',
      fontSize: '0.85rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: '0.74rem', color: '#9ca3af', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Auto-calculated
        </div>
        <button type="button" onClick={onShowCalc}
          style={{ background: 'none', border: 'none', color: '#dc2626', fontSize: '0.74rem', cursor: 'pointer', fontWeight: 600 }}>
          Show Calculation
        </button>
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ color: '#e5e7eb', marginBottom: '2px' }}>{l}</div>
      ))}
      <div style={{ borderTop: '1px solid rgba(220,38,38,0.2)', marginTop: '8px', paddingTop: '8px', fontWeight: 700, color: '#f9fafb' }}>
        Total: ${breakdown.totalAmount.toFixed(2)}
      </div>
    </div>
  )
}

// ─── Adjusted Amount Control ──────────────────────────────────────────────────

function AdjustedAmountField({ calculatedAmount, adjustedAmount, onChange }) {
  const isAdjusted = adjustedAmount !== null && adjustedAmount !== ''
  return (
    <div style={FIELD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <label style={{ ...LABEL_STYLE, marginBottom: 0 }}>Amount ($)</label>
        {isAdjusted && (
          <span style={{
            fontSize: '0.72rem', fontWeight: 700, color: '#fbbf24',
            background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: '4px', padding: '2px 8px',
          }}>Adjusted</span>
        )}
      </div>
      <input
        type="number" min="0" step="0.01"
        placeholder={calculatedAmount != null ? calculatedAmount.toFixed(2) : '0.00'}
        value={adjustedAmount !== null ? adjustedAmount : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        style={INPUT_STYLE}
      />
      {isAdjusted && (
        <button type="button" onClick={() => onChange(null)}
          style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: '0.74rem', cursor: 'pointer', marginTop: '4px', padding: 0 }}>
          Revert to calculated (${calculatedAmount != null ? calculatedAmount.toFixed(2) : '0.00'})
        </button>
      )}
      {!isAdjusted && (
        <p style={HELP_STYLE}>Leave blank to use calculated amount. Enter a value here to override.</p>
      )}
    </div>
  )
}

// ─── Sub-form: Recall ─────────────────────────────────────────────────────────

function RecallInputs({ values, onChange, profile, profileLoading, userId, stations, onHomeLegMeta, onStnLegMeta, entitlement }) {
  const rosterLabel = profile?.stationLabel || ''

  // Station resolution is gated on EXPLICIT selection only — typing a fuzzy
  // fragment like "43" must not be treated as a confirmed pick. Downstream
  // Google KM / FRV-matrix lookups all read from these gated values.
  const explicitRosterStation = getExplicitlyResolvedStation(values.rosteredStn, stations)
  const recallStation         = getExplicitlyResolvedStation(values.recallStn, stations)

  const profileFallbackStation = profile?.stationId
    ? {
        id:           profile.stationId,
        name:         profile.stationName || null,
        abbreviation: `FS${profile.stationId}`,
        label:        profile.stationLabel || `FS${profile.stationId}`,
      }
    : null

  // Lookup-side station: explicit selection wins; otherwise fall back to the
  // profile so the home-leg estimate still runs.
  const rosterStationForLookup = explicitRosterStation || profileFallbackStation

  const notified = !!values.notified
  const shiftSelected = values.shift === 'Day' || values.shift === 'Night'

  return (
    <>
      <div style={FIELD}>
        <label style={LABEL_STYLE} htmlFor="recall-rostered-station-input">Rostered Station</label>
        <StationPicker
          id="recall-rostered-station-input"
          value={values.rosteredStn || ''}
          onChange={(text) => onChange('rosteredStn', text)}
          stations={stations}
          placeholder={rosterLabel || 'Search by FS number or name (e.g. 45 or Brooklyn)'}
          ariaLabel="Rostered station"
          profileLabel={profile?.stationLabel || ''}
        />
        <p style={HELP_STYLE}>Auto-filled from your profile. Edit if different for this recall.</p>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE} htmlFor="recall-recall-station-input">Recall Station</label>
        <StationPicker
          id="recall-recall-station-input"
          value={values.recallStn || ''}
          onChange={(text) => onChange('recallStn', text)}
          stations={stations}
          placeholder="Search by FS number or name (e.g. 44 or Sunshine)"
          ariaLabel="Recall station"
        />
      </div>

      <StationDistanceField
        userId={userId}
        station={rosterStationForLookup}
        homeAddress={profile?.homeAddress || ''}
        profileLoading={profileLoading}
        value={values.distHomeKm}
        onChange={(v) => onChange('distHomeKm', v)}
        onRoutingMeta={onHomeLegMeta}
      />

      <RecallLegDistanceField
        userId={userId}
        originStation={rosterStationForLookup}
        destStation={recallStation}
        value={values.distStnKm}
        onChange={(km) => onChange('distStnKm', km)}
        onRoutingMeta={onStnLegMeta}
      />

      {/* Shift Type — required, no default. Drives meal entitlement and the
          standard shift-end boundary used to size the recall duration. */}
      <div style={FIELD}>
        <label style={LABEL_STYLE}>Shift Type</label>
        <select
          value={values.shift || ''}
          onChange={(e) => onChange('shift', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}
        >
          <option value="" disabled>Select shift type...</option>
          <option value="Day">Day Shift</option>
          <option value="Night">Night Shift</option>
        </select>
        <p style={HELP_STYLE}>Required. Drives meal entitlement and standard-shift boundary.</p>

        <label style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginTop: 10, fontSize: '0.85rem', color: '#d1d5db', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={notified}
            onChange={(e) => onChange('notified', e.target.checked)}
            style={{ accentColor: '#dc2626', width: 16, height: 16 }}
          />
          Notified Recall
        </label>
      </div>

      {!notified && (
        <div style={FIELD}>
          <label style={LABEL_STYLE}>Arrival Time (24hr)</label>
          <TimeInput24
            value={values.arrivalTime}
            onChange={(v) => onChange('arrivalTime', v)}
            required
          />
          <p style={HELP_STYLE}>24hr time you arrived at the recall station, e.g. 08:30 or 19:30.</p>
        </div>
      )}

      {/* Live, read-only meal entitlement preview. Updates as shift / arrival /
          notified change. Replaces the old manual meal-allowance select. */}
      <div style={FIELD}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 6,
        }}>
          <span style={{ ...LABEL_STYLE, marginBottom: 0 }}>Meal Allowance</span>
          <InfoPopover label="Recall meal entitlement EBA rules">
            <strong style={{ color: '#f9fafb' }}>EBA — Recall Meal Allowance</strong>
            <div style={{ marginTop: 4 }}>
              Recall meal entitlements are auto-generated from shift type,
              arrival time and recall duration (arrival → end of standard
              shift, or your booked-off time if entered):
            </div>
            <ul style={{ paddingLeft: 16, marginTop: 6, marginBottom: 0 }}>
              <li><strong>Day Shift</strong>, arrival ≤ 09:59 — 1× Large + 1× Small</li>
              <li><strong>Day Shift</strong>, arrival ≥ 10:00 — 1× Large only</li>
              <li><strong>Night Shift</strong> — 1× Large only (never doubled)</li>
              <li><strong>Notified Recall</strong> — no meal allowances</li>
            </ul>
            <div style={{ marginTop: 6 }}>
              A minimum recall duration of 4 hours is required before any
              meal entitlement is generated.
            </div>
          </InfoPopover>
        </div>
        {notified ? (
          <div style={{
            padding: '10px 12px', borderRadius: '6px',
            background: 'rgba(107,114,128,0.08)',
            border: '1px solid rgba(107,114,128,0.3)',
            color: '#9ca3af', fontSize: '0.82rem',
          }}>
            No meal allowances are entitled for Notified Recalls
          </div>
        ) : !shiftSelected ? (
          <div style={{
            padding: '10px 12px', borderRadius: '6px',
            background: 'rgba(107,114,128,0.08)',
            border: '1px solid rgba(107,114,128,0.3)',
            color: '#9ca3af', fontSize: '0.82rem',
          }}>
            Select a shift type to generate meal entitlement.
          </div>
        ) : (
          <div style={{
            padding: '10px 12px', borderRadius: '6px',
            background: (entitlement?.largeCount ?? 0) + (entitlement?.smallCount ?? 0) > 0
              ? 'rgba(34,197,94,0.08)' : 'rgba(107,114,128,0.08)',
            border: '1px solid ' + (
              (entitlement?.largeCount ?? 0) + (entitlement?.smallCount ?? 0) > 0
                ? 'rgba(34,197,94,0.3)' : 'rgba(107,114,128,0.3)'
            ),
            color: (entitlement?.largeCount ?? 0) + (entitlement?.smallCount ?? 0) > 0
              ? '#4ade80' : '#9ca3af',
            fontSize: '0.82rem', fontWeight: 600,
          }}>
            {entitlement?.label || 'Enter arrival time to determine entitlement'}
            {entitlement?.durationMin != null && (
              <div style={{ marginTop: 4, fontSize: '0.74rem', fontWeight: 400, color: '#9ca3af' }}>
                Recall duration: {(entitlement.durationMin / 60).toFixed(2)}h
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ─── Sub-form: Retain ─────────────────────────────────────────────────────────

function RetainInputs({ values, onChange, mealEligibility, retainBreakdown, retainHourlyRate }) {
  const eligTier = mealEligibility?.tier || 'none'
  const eligColor = eligTier === 'none' ? '#9ca3af' : '#4ade80'
  const eligBg    = eligTier === 'none' ? 'rgba(107,114,128,0.08)' : 'rgba(34,197,94,0.08)'
  const eligBorder= eligTier === 'none' ? 'rgba(107,114,128,0.3)' : 'rgba(34,197,94,0.3)'

  const hours       = retainBreakdown?.generatedHours ?? 0
  const dollarValue = retainBreakdown?.retainAmount   ?? 0
  const rulePath    = retainBreakdown?.retainRulePath
  const explanation = retainBreakdown?.retainExplanation
  const hasHours    = hours > 0
  const rateMissing = retainHourlyRate <= 0
  const panelColor  = hasHours ? '#f9fafb' : '#9ca3af'
  const panelBg     = hasHours ? 'rgba(220,38,38,0.08)' : 'rgba(107,114,128,0.06)'
  const panelBorder = hasHours ? 'rgba(220,38,38,0.30)' : 'rgba(107,114,128,0.30)'

  return (
    <>
      <div style={FIELD}>
        <label style={LABEL_STYLE}>Shift Type</label>
        <select value={values.shift}
          onChange={(e) => onChange('shift', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          <option value="Day">Day Shift</option>
          <option value="Night">Night Shift</option>
        </select>
        <p style={HELP_STYLE}>
          Drives the FRV retain rule:
          {' '}{values.shift === 'Night' ? 'Night' : 'Day'}-shift rostered finish
          {' '}{values.shift === 'Night' ? '08:00' : '18:00'} · minimum trigger
          {' '}{values.shift === 'Night' ? '09:00' : '19:00'} · flat-end
          {' '}{values.shift === 'Night' ? '12:00' : '22:00'}.
        </p>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Booked Off Time (24hr)</label>
        <TimeInput24
          value={values.bookedOffTime}
          onChange={(v) => onChange('bookedOffTime', v)}
        />
        <p style={HELP_STYLE}>
          The clock time you were booked off. Retain hours are auto-calculated
          from rostered finish in 0.25h increments, with a mandatory 4.00h
          minimum after the trigger time.
        </p>
      </div>

      {/* Hours-first calculated entitlement panel. Hours are the primary
          value; dollars are derived from the retain hourly rate snapshot. */}
      <div style={{
        ...FIELD,
        padding: '12px 14px', borderRadius: '8px',
        background: panelBg, border: '1px solid ' + panelBorder,
      }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
          Retain (auto-calculated)
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: panelColor }}>
            {hours.toFixed(2)} h
          </div>
          <div style={{ fontSize: '0.85rem', color: hasHours ? '#d1d5db' : '#6b7280' }}>
            {rateMissing
              ? '$ derived from hourly rate (set rate in Settings → Rates)'
              : `= $${dollarValue.toFixed(2)} at $${retainHourlyRate.toFixed(2)}/h`}
          </div>
        </div>
        {explanation && (
          <p style={{ marginTop: '8px', fontSize: '0.78rem', color: '#9ca3af', lineHeight: 1.5 }}>
            <strong style={{ color: '#d1d5db' }}>Rule applied:</strong> {explanation}
            {rulePath ? ` (${rulePath})` : ''}
          </p>
        )}
      </div>

      <div style={FIELD}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 6,
        }}>
          <span style={{ ...LABEL_STYLE, marginBottom: 0 }}>Meal Eligibility</span>
          <InfoPopover label="Retain meal entitlement EBA rules">
            <strong style={{ color: '#f9fafb' }}>EBA — Retain Meal Allowance</strong>
            <div style={{ marginTop: 4 }}>
              Retain meals stack with booked-off time. Threshold comparisons
              are inclusive — a displayed threshold time qualifies once the
              clock reaches it:
            </div>
            <ul style={{ paddingLeft: 16, marginTop: 6, marginBottom: 0 }}>
              <li>1× Large Meal once the initial threshold is reached.</li>
              <li>+1× Small Meal at each additional 2-hour threshold thereafter.</li>
            </ul>
            <div style={{ marginTop: 6 }}>
              Worked example (Night shift): booked off until 09:59 → 1× Large;
              10:00 → 1× Large + 1× Small; 12:00 → 1× Large + 2× Small;
              14:00 → 1× Large + 3× Small.
            </div>
          </InfoPopover>
        </div>
        {mealEligibility?.thresholds && (
          <p style={HELP_STYLE}>
            {values.shift} thresholds: Large ≥ {mealEligibility.thresholds.large};
            + Small from {mealEligibility.thresholds.smallAt}, then +1 every 2h.
          </p>
        )}
        <div style={{
          marginTop: '8px', padding: '8px 12px', borderRadius: '6px',
          background: eligBg, border: '1px solid ' + eligBorder,
          color: eligColor, fontSize: '0.82rem', fontWeight: 600,
        }}>
          {mealEligibility?.label || 'Enter shift + booked off time to determine meal eligibility'}
        </div>
      </div>

    </>
  )
}

// ─── Sub-form: Standby ────────────────────────────────────────────────────────

function StandbyInputs({ values, onChange, nightMealEligible, profile, userId, stations, onStandbyMeta }) {
  // Resolve rostered + standby stations from the profile / typed text. Mirrors
  // the Recall flow so the user gets the same chip feedback + auto-distance UX.
  const rosterStation = (() => {
    if (profile?.stationId) {
      return {
        id:           profile.stationId,
        name:         profile.stationName || null,
        abbreviation: `FS${profile.stationId}`,
        label:        profile.stationLabel || `FS${profile.stationId}`,
      }
    }
    return null
  })()
  // Only treat the standby station as resolved once the user has explicitly
  // picked an option from the picker (value === canonical label). The
  // picker never writes raw keystrokes to `value`, so a fuzzy fragment
  // like "23" can never prematurely trigger the downstream auto-distance
  // flow.
  const standbyStation = getExplicitlyResolvedStation(values.standbyStn, stations)

  const isMD = values.standbyType === 'M&D'

  return (
    <>
      <div style={FIELD}>
        <label style={LABEL_STYLE} htmlFor="standby-station-input">{isMD ? 'M&D Station' : 'Standby Station'}</label>
        <StationPicker
          id="standby-station-input"
          value={values.standbyStn || ''}
          onChange={(text) => onChange('standbyStn', text)}
          stations={stations}
          placeholder="Search by FS number or name (e.g. 43 or Deer Park)"
          ariaLabel={isMD ? 'M&D station' : 'Standby station'}
        />
        <p style={HELP_STYLE}>Used for Google KM + FRV matrix hours lookup. Leave blank to enter km manually.</p>
      </div>

      <StandbyDistanceField
        userId={userId}
        rosterStation={rosterStation}
        standbyStation={standbyStation}
        value={values.distKm}
        onChange={(km) => onChange('distKm', km)}
        onRoutingMeta={onStandbyMeta}
      />

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Shift</label>
        <ShiftPicker
          value={values.shift}
          onChange={(v) => onChange('shift', v)}
        />
      </div>

      {/* Arrival time is required for both Day and Night standby (Standby
          type only). Captured as HH:MM in the UI and normalised to canonical
          "HHMM" 4-digit string at write time by normaliseStandbyArrivedTime.
          Day never qualifies for a meal; the time is captured for audit. */}
      {!isMD && (
        <div style={FIELD}>
          <label style={LABEL_STYLE}>Arrival Time (24hr)</label>
          <TimeInput24
            value={values.arrivedTime}
            onChange={(v) => onChange('arrivedTime', v)}
            required
          />
          <p style={HELP_STYLE}>24hr time, e.g. 08:30 or 19:30.</p>
        </div>
      )}

      {/* Meal Allowance entitlement — always visible for Standby type.
          Eligible only when shift=Night AND arrivedTime >= 1900. */}
      {!isMD && (
        <div style={FIELD}>
          <label style={LABEL_STYLE}>Meal Allowance</label>
          <div style={{
            padding: '8px 12px', borderRadius: '6px', fontSize: '0.78rem',
            background: nightMealEligible ? 'rgba(34,197,94,0.08)' : 'rgba(107,114,128,0.1)',
            border: '1px solid ' + (nightMealEligible ? 'rgba(34,197,94,0.3)' : 'rgba(107,114,128,0.3)'),
            color: nightMealEligible ? '#4ade80' : '#9ca3af',
          }}>
            {nightMealEligible
              ? 'Small Meal Allowance — arrived at or after 19:00 on a Night shift'
              : 'None eligible for this shift'}
          </div>
        </div>
      )}

      {isMD && (
        <div style={{
          padding: '8px 12px', borderRadius: '6px', marginBottom: '16px',
          background: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)',
          fontSize: '0.78rem', color: '#9ca3af',
        }}>
          Muster &amp; Dismiss claims have no meal allowance.
        </div>
      )}
    </>
  )
}

// ─── Sub-form: Spoilt Meal / Delayed Meal ────────────────────────────────────
// claimType prop: 'spoilt' or 'delayed_meal'.
// When 'delayed_meal', the Meal Type selector is hidden — meal_type is forced to
// 'Delayed' by the virtual claimType resolution in ClaimsContext/addClaim.

function SpoiltInputs({ values, onChange, claimType }) {
  const mealWin = getMealWindow(values.shift)
  const incidentStatus = values.incidentTime
    ? checkTimeInMealWindow(values.incidentTime, values.shift)
    : null
  const statusColor = { inside: '#4ade80', before: '#fbbf24', after: '#fbbf24' }
  const statusText  = {
    inside: 'Within window (' + mealWin.label + ')',
    before: 'Before window (' + mealWin.label + ')',
    after:  'After window (' + mealWin.label + ')',
  }

  return (
    <>
      {/* Only show Meal Type selector for 'spoilt' — for 'delayed_meal' it is forced */}
      {claimType !== 'delayed_meal' && (
      <div style={FIELD}>
        <label style={LABEL_STYLE}>Meal Type</label>
        <select value={values.mealType}
          onChange={(e) => onChange('mealType', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          <option value="Spoilt">Spoilt Meal - fire call interrupts meal</option>
          <option value="Delayed">Delayed Meal - held past meal break</option>
        </select>
      </div>
      )}

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Shift</label>
        <select value={values.shift}
          onChange={(e) => onChange('shift', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          <option value="Day">Day shift</option>
          <option value="Night">Night shift</option>
        </select>
        <div style={{
          marginTop: '6px', padding: '6px 12px',
          background: '#111', border: '1px solid #2a2a2a',
          borderRadius: '6px', fontSize: '0.78rem', color: '#9ca3af',
        }}>
          {values.shift} shift meal window: <strong style={{ color: '#e5e7eb' }}>{mealWin.label}</strong>
        </div>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Incident Time (optional)</label>
        <TimeInput24
          value={values.incidentTime}
          onChange={(v) => onChange('incidentTime', v)}
        />
        {incidentStatus && incidentStatus !== 'unknown' && (
          <div style={{
            marginTop: '6px', padding: '6px 12px', borderRadius: '6px',
            fontSize: '0.78rem', color: statusColor[incidentStatus] || '#9ca3af',
          }}>
            {statusText[incidentStatus]}
          </div>
        )}
      </div>
    </>
  )
}

// ─── Default values per type ──────────────────────────────────────────────────

const DEFAULTS = {
  recalls:      { rosteredStn: '', recallStn: '', distHomeKm: '', distStnKm: '', arrivalTime: '', shift: '', notified: false },
  retain:       { shift: 'Day', bookedOffTime: '' },
  standby:      { standbyType: 'Standby', standbyStn: '', distKm: '', shift: 'Day', arrivedTime: '' },
  md:           { standbyType: 'M&D',     standbyStn: '', distKm: '', shift: 'Day', arrivedTime: '' },
  spoilt:       { mealType: 'Spoilt',   shift: 'Day', incidentTime: '' },
  delayed_meal: { mealType: 'Delayed',  shift: 'Day', incidentTime: '' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns today's date in YYYY-MM-DD using the user's local timezone.
// Using toLocaleDateString with 'sv-SE' locale reliably gives YYYY-MM-DD on all
// browsers including Mobile Safari, with no UTC-offset shift.
function getTodayLocal() {
  return new Date().toLocaleDateString('sv-SE')
}

// ─── Main ClaimForm ───────────────────────────────────────────────────────────
// financialYearId: passed from NewClaimModal -> wired into addClaim for FY + numbering

export default function ClaimForm({ userId, financialYearId, onSuccess, onCancel, initialClaimType }) {
  const { addClaim } = useClaims()
  const { rates }    = useRates()

  // Quick-action prefill: open the form directly on the requested type.
  const startingType = CLAIM_TYPE_ORDER.includes(initialClaimType) ? initialClaimType : 'retain'

  const [claimType, setClaimType]           = useState(startingType)
  const [date, setDate]                     = useState(getTodayLocal)
  const [fields, setFields]                 = useState(() => ({ ...DEFAULTS[startingType] }))
  const [breakdown, setBreakdown]           = useState(null)
  const [adjustedAmount, setAdjustedAmount] = useState(null)
  const [showCalcLines, setShowCalcLines]   = useState(null)
  const [submitting, setSubmitting]         = useState(false)
  const [error, setError]                   = useState(null)
  const [profile, setProfile]               = useState(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [stations, setStations]             = useState([])

  // Routing provenance — captured per-leg from the distance fields so the
  // submitted claim row carries Google KM, matrix hours, and source labels
  // for later reproduction. These are populated by onRoutingMeta callbacks
  // and reset whenever the claim type changes.
  const [recallHomeMeta,    setRecallHomeMeta]    = useState(null)
  const [recallStnMeta,     setRecallStnMeta]     = useState(null)
  const [standbyTravelMeta, setStandbyTravelMeta] = useState(null)

  // Load FAT-specific profile extension for pre-fill
  // Reads from fat.profile_ext (FAT-owned) - not the shared profiles table
  useEffect(() => {
    if (!userId) {
      setProfileLoading(false)
      return
    }
    let cancelled = false
    setProfileLoading(true)
    ;(async () => {
      const { data: ext } = await fat
        .from('profile_ext')
        .select('station_id, home_dist_km, home_address, platoon')
        .eq('user_id', userId)
        .maybeSingle()
      if (cancelled) return

      let stationName = ''
      if (ext?.station_id) {
        const { data: stn } = await fat
          .from('stations')
          .select('name')
          .eq('id', ext.station_id)
          .maybeSingle()
        if (cancelled) return
        stationName = stn?.name || ''
      }

      if (ext) {
        // Single canonical shape: (station_id, bare name from fat.stations).
        // rostered_station_label is a write-only cache and is never read
        // here — so a poisoned label can never round-trip through state.
        setProfile({
          stationId:    ext.station_id,
          stationName,
          stationLabel: composeStationLabel(ext.station_id, stationName),
          homeDistKm:   ext.home_dist_km || 0,
          homeAddress:  ext.home_address || '',
          platoon:      ext.platoon || '',
        })
      } else {
        setProfile({ stationId: null, stationName: '', stationLabel: '', homeDistKm: 0, homeAddress: '', platoon: '' })
      }
      setProfileLoading(false)
    })()
    return () => { cancelled = true }
  }, [userId])

  // Load FRV stations list once for free-text recall-station parsing.
  // Used by RecallLegDistanceField to resolve typed input like "FS44 - Sunshine"
  // or "Sunshine" into a station ID for the auto-distance flow.
  useEffect(() => {
    let cancelled = false
    fat
      .from('stations')
      .select('id, name, abbreviation')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .then(({ data, error: stnErr }) => {
        if (cancelled) return
        if (stnErr) {
          console.warn('[ClaimForm] Stations fetch error:', stnErr)
          return
        }
        if (data) setStations(data)
      })
    return () => { cancelled = true }
  }, [])

  // Reset fields when type or profile changes.
  // Note: date is intentionally NOT reset here - it stays as today's date
  // regardless of claim type switch, and the user can still change it manually.
  useEffect(() => {
    const defaults = { ...DEFAULTS[claimType] }
    if (claimType === 'recalls' && profile?.stationLabel) {
      defaults.rosteredStn = profile.stationLabel
      defaults.distHomeKm  = profile.homeDistKm ? String(profile.homeDistKm) : ''
    }
    setFields(defaults)
    setBreakdown(null)
    setAdjustedAmount(null)
    setShowCalcLines(null)
    setError(null)
    setRecallHomeMeta(null)
    setRecallStnMeta(null)
    setStandbyTravelMeta(null)
  }, [claimType, profile])

  // Auto-calculate on field/rate change
  useEffect(() => {
    const num = (v) => Number(v) || 0
    let result = null
    try {
      if (claimType === 'recalls') {
        result = calcRecallClaim({
          distHomeKm:    num(fields.distHomeKm),
          distStnKm:     num(fields.distStnKm),
          shift:         fields.shift || null,
          notified:      !!fields.notified,
          arrivalTime:   fields.arrivalTime,
          bookedOffTime: fields.bookedOffTime || null,
        }, rates)
      } else if (claimType === 'retain') {
        result = calcRetainClaim({
          shift:         fields.shift,
          bookedOffTime: fields.bookedOffTime,
        }, rates)
      } else if (claimType === 'standby' || claimType === 'md') {
        const hasNightMeal = isStandbyNightMealEligible({
          standbyType: fields.standbyType,
          shift:       fields.shift,
          arrivedTime: fields.arrivedTime,
        })
        result = calcStandbyClaim({ distKm: num(fields.distKm), hasNightMeal }, rates)
      } else if (claimType === 'spoilt') {
        result = calcSpoiltClaim({ mealType: fields.mealType }, rates)
      } else if (claimType === 'delayed_meal') {
        result = calcSpoiltClaim({ mealType: 'Delayed' }, rates)
      }
    } catch (err) { result = null }
    setBreakdown(result)
    setShowCalcLines(null)
  }, [claimType, fields, rates])

  const handleFieldChange = (key, value) => setFields((prev) => ({ ...prev, [key]: value }))

  const handleShowCalc = () => {
    const num = (v) => Number(v) || 0
    let lines = []
    if (claimType === 'recalls') {
      lines = buildRecallCalcLines({
        distHomeKm: num(fields.distHomeKm), distStnKm: num(fields.distStnKm),
        shift: fields.shift || null, notified: !!fields.notified,
        arrivalTime: fields.arrivalTime, bookedOffTime: fields.bookedOffTime || null,
      }, rates, { rosterStation: fields.rosteredStn || 'Rostered Stn', recallStation: fields.recallStn || 'Recall Stn' })
    } else if (claimType === 'standby' || claimType === 'md') {
      lines = buildStandbyCalcLines({
        distKm: num(fields.distKm), standbyType: fields.standbyType,
        arrivedTime: fields.arrivedTime, shift: fields.shift,
      }, rates)
    } else if (claimType === 'spoilt') {
      lines = buildSpoiltCalcLines({
        mealType: fields.mealType, shift: fields.shift,
        incidentTime: fields.incidentTime,
      }, rates)
    } else if (claimType === 'delayed_meal') {
      lines = buildSpoiltCalcLines({
        mealType: 'Delayed', shift: fields.shift,
        incidentTime: fields.incidentTime,
      }, rates)
    } else if (claimType === 'retain') {
      lines = buildRetainCalcLines({
        shift:         fields.shift,
        bookedOffTime: fields.bookedOffTime,
      }, rates)
    }
    setShowCalcLines(lines)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (!date) { setError('Please select a date.'); return }
    if (claimType === 'recalls') {
      if (fields.shift !== 'Day' && fields.shift !== 'Night') {
        setError('Shift Type is required for Recall claims (Day or Night).'); return
      }
      if (!fields.notified) {
        const at = (fields.arrivalTime || '').replace(/\D/g, '')
        if (!at) {
          setError('Arrival Time is required for Recall claims.'); return
        }
        const padded = at.padStart(4, '0')
        const h = parseInt(padded.slice(0, 2), 10)
        const m = parseInt(padded.slice(2, 4), 10)
        if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) {
          setError('Arrival Time must be a valid 24hr time (e.g. 08:30, 19:30).'); return
        }
      }
    }
    if (claimType === 'standby' && fields.standbyType === 'Standby') {
      // Accept HH:MM (current UI) and HHMM (legacy / direct entry).
      const at = (fields.arrivedTime || '').replace(/\D/g, '')
      if (!at) {
        setError('Arrival Time is required for Standby claims (both Day and Night shifts).'); return
      }
      const padded = at.padStart(4, '0')
      const h = parseInt(padded.slice(0, 2), 10)
      const m = parseInt(padded.slice(2, 4), 10)
      if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) {
        setError('Arrival Time must be a valid 24hr time (e.g. 08:30, 19:30).'); return
      }
    }
    // Retain is hours-first: a claim with generated_hours > 0 is valid even if
    // the dollar amount is $0 because the retainHourlyRate hasn't been set yet.
    // For all other claim types the historical $0 guard still applies.
    if (claimType === 'retain') {
      if (!breakdown || !(breakdown.generatedHours > 0)) {
        setError('Enter shift + booked off time so retain hours can be calculated.'); return
      }
    } else if (!breakdown || breakdown.totalAmount <= 0) {
      setError('Calculated amount must be greater than $0.00.'); return
    }

    const num = (v) => Number(v) || 0
    let calcLines = []
    if (claimType === 'recalls') {
      calcLines = buildRecallCalcLines(
        {
          distHomeKm: num(fields.distHomeKm), distStnKm: num(fields.distStnKm),
          shift: fields.shift || null, notified: !!fields.notified,
          arrivalTime: fields.arrivalTime, bookedOffTime: fields.bookedOffTime || null,
        },
        rates,
        { rosterStation: fields.rosteredStn, recallStation: fields.recallStn }
      )
    } else if (claimType === 'standby' || claimType === 'md') {
      calcLines = buildStandbyCalcLines(
        { distKm: num(fields.distKm), standbyType: fields.standbyType, arrivedTime: fields.arrivedTime, shift: fields.shift },
        rates
      )
    } else if (claimType === 'spoilt') {
      calcLines = buildSpoiltCalcLines(
        { mealType: fields.mealType, shift: fields.shift, incidentTime: fields.incidentTime },
        rates
      )
    } else if (claimType === 'delayed_meal') {
      calcLines = buildSpoiltCalcLines(
        { mealType: 'Delayed', shift: fields.shift, incidentTime: fields.incidentTime },
        rates
      )
    } else if (claimType === 'retain') {
      calcLines = buildRetainCalcLines(
        { shift: fields.shift, bookedOffTime: fields.bookedOffTime },
        rates
      )
    }

    const enrichedBreakdown = {
      ...breakdown,
      adjustedAmount: adjustedAmount !== null && adjustedAmount !== ''
        ? roundMoney(Number(adjustedAmount))
        : null,
      calcSnapshot: buildCalcSnapshot(claimType, calcLines, rates),
    }

    // Routing provenance, only relevant for claim types that auto-calculate
    // a distance. Persisted by ClaimsContext into the new additive columns
    // (google_km_*, matrix_hours, routing_source, travel_calc_at).
    const routingMeta = claimType === 'recalls'
      ? { home: recallHomeMeta, stn: recallStnMeta }
      : (claimType === 'standby' || claimType === 'md')
        ? { standby: standbyTravelMeta }
        : null

    setSubmitting(true)
    try {
      await addClaim({
        userId,
        claimType,
        date,
        breakdown: enrichedBreakdown,
        fields,
        rates,
        routingMeta,
        financialYearId: financialYearId || null,
      })
      onSuccess?.()
    } catch (err) {
      console.error('[ClaimForm] Submit error:', err)
      setError(err.message || 'Failed to create claim. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const nightMealEligible = claimType === 'standby'
    ? isStandbyNightMealEligible({ standbyType: fields.standbyType, shift: fields.shift, arrivedTime: fields.arrivedTime })
    : false

  const recallEntitlement = claimType === 'recalls'
    ? calculateRecallMealEntitlements({
        shift:         fields.shift || null,
        notified:      !!fields.notified,
        arrivalTime:   fields.arrivalTime,
        bookedOffTime: fields.bookedOffTime || null,
      })
    : null

  const effectiveAmount = adjustedAmount !== null && adjustedAmount !== ''
    ? roundMoney(Number(adjustedAmount))
    : breakdown?.totalAmount ?? 0

  const canSubmit = !submitting && breakdown && breakdown.totalAmount > 0

  return (
    <form onSubmit={handleSubmit} noValidate>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Type</label>
        <select value={claimType} onChange={(e) => setClaimType(e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          {CLAIM_TYPE_ORDER.map((t) => (
            <option key={t} value={t}>{CLAIM_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
      </div>

      {claimType === 'recalls'      && <RecallInputs values={fields} onChange={handleFieldChange} profile={profile} profileLoading={profileLoading} userId={userId} stations={stations} onHomeLegMeta={setRecallHomeMeta} onStnLegMeta={setRecallStnMeta} entitlement={recallEntitlement} />}
      {claimType === 'retain'       && (
        <RetainInputs
          values={fields}
          onChange={handleFieldChange}
          mealEligibility={calcRetainMealEligibility({ shift: fields.shift, bookedOffTime: fields.bookedOffTime })}
          retainBreakdown={breakdown}
          retainHourlyRate={Number(rates?.retainHourlyRate) || 0}
        />
      )}
      {(claimType === 'standby' || claimType === 'md') && <StandbyInputs values={fields} onChange={handleFieldChange} nightMealEligible={nightMealEligible} profile={profile} userId={userId} stations={stations} onStandbyMeta={setStandbyTravelMeta} />}
      {(claimType === 'spoilt' || claimType === 'delayed_meal') && (
        <SpoiltInputs values={fields} onChange={handleFieldChange} claimType={claimType} />
      )}

      {showCalcLines && (
        <ShowCalcPanel lines={showCalcLines} onClose={() => setShowCalcLines(null)} />
      )}

      <CalcPreview breakdown={breakdown} rates={rates} onShowCalc={handleShowCalc} />

      {breakdown && (
        <AdjustedAmountField
          calculatedAmount={breakdown.totalAmount}
          adjustedAmount={adjustedAmount}
          onChange={setAdjustedAmount}
        />
      )}

      {!financialYearId && (
        <div style={{
          marginBottom: '12px', padding: '8px 12px',
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
          borderRadius: '6px', fontSize: '0.76rem', color: '#fbbf24',
        }}>
          No active financial year - claim will be saved without FY assignment.
        </div>
      )}

      {error && (
        <div style={{
          marginBottom: '16px',
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171', borderRadius: '8px', padding: '10px 14px', fontSize: '0.85rem',
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px' }}>
        {onCancel && (
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
        )}
        <button type="submit" disabled={!canSubmit}
          style={{
            flex: 1, padding: '10px',
            background: !canSubmit ? '#7f1d1d' : '#dc2626',
            border: 'none', borderRadius: '8px',
            color: 'white',
            cursor: !canSubmit ? 'not-allowed' : 'pointer',
            fontSize: '0.9rem', fontWeight: 600,
            transition: 'background 0.15s',
          }}>
          {submitting
            ? 'Saving...'
            : 'Submit - $' + effectiveAmount.toFixed(2) + (adjustedAmount !== null ? ' (Adj)' : '')}
        </button>
      </div>
    </form>
  )
}
