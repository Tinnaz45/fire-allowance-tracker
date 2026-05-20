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

import { useState, useEffect, useRef } from 'react'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { useRates } from '@/lib/calculations/RatesContext'
import { CLAIM_TYPE_ORDER, CLAIM_TYPE_LABELS } from '@/lib/claims/claimTypes'
import StationDistanceField from '@/components/distance/StationDistanceField'
import RecallLegDistanceField from '@/components/distance/RecallLegDistanceField'
import StandbyDistanceField from '@/components/distance/StandbyDistanceField'
import { parseAndResolve, composeStationLabel } from '@/lib/distance/stationParser'
import {
  calcRecallClaim,
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
  if (breakdown.retainAmount > 0)  lines.push('Retain: $' + breakdown.retainAmount.toFixed(2))
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

// ─── Resolved-station chip (mirrors profile selector badge) ──────────────────
// Shown beneath each recall-form station input when parseAndResolve maps the
// typed text onto a canonical fat.stations row. Gives the same visual
// confirmation the Profile page's stationBadge gives, so the user knows the
// downstream auto-distance flow will succeed.

function ResolvedStationChip({ station }) {
  if (!station) return null
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      marginTop: '6px', padding: '4px 10px',
      background: 'rgba(34,197,94,0.08)',
      border: '1px solid rgba(34,197,94,0.3)',
      borderRadius: '6px',
      fontSize: '0.78rem', fontWeight: 600, color: '#4ade80',
      letterSpacing: '0.02em',
    }}>
      <span aria-hidden="true">✓</span>
      <span>{station.label || `FS${station.id}${station.name ? ' - ' + station.name : ''}`}</span>
    </div>
  )
}

function UnresolvedStationHint() {
  return (
    <div style={{
      marginTop: '6px', padding: '4px 10px',
      background: 'rgba(251,191,36,0.06)',
      border: '1px solid rgba(251,191,36,0.25)',
      borderRadius: '6px',
      fontSize: '0.74rem', color: '#fbbf24',
    }}>
      Type a station number or name (e.g. &ldquo;FS44&rdquo; or &ldquo;Sunshine&rdquo;) to auto-resolve.
    </div>
  )
}

// ─── Sub-form: Recall ─────────────────────────────────────────────────────────

function RecallInputs({ values, onChange, profile, profileLoading, userId, stations, onHomeLegMeta, onStnLegMeta }) {
  const rosterLabel = profile?.stationLabel || ''

  // Resolve both free-text station inputs against fat.stations once per render.
  // The rostered station defaults to the profile station but can be edited; the
  // recall station is always typed. Both feed:
  //   - the resolved-station chips (visual confirmation that the typed text
  //     mapped to a canonical FRV station, mirroring the Profile selector)
  //   - the route-summary line (so it reflects what the user typed)
  //   - StationDistanceField (home → rostered leg, keyed off rosterStation.id)
  //   - RecallLegDistanceField (rostered → recall leg)
  //
  // Fallback for rosterStation: if `parseAndResolve` returns null because the
  // stations list hasn't loaded yet OR the typed text is unparseable, fall back
  // to the profile's persisted station so the home-leg estimate isn't blocked.
  const rosterStation = (() => {
    const parsed = parseAndResolve(values.rosteredStn, stations)
    if (parsed) return parsed
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

  const recallStation = parseAndResolve(values.recallStn, stations)

  const rosterRouteLabel = rosterStation?.label || rosterLabel || 'Rostered Stn'
  const recallRouteLabel = recallStation?.label || 'Recall Stn'

  return (
    <>
      <div style={{
        background: '#111', border: '1px solid #2a2a2a',
        borderRadius: '8px', padding: '10px 14px', marginBottom: '16px',
        fontSize: '0.8rem', color: '#9ca3af', lineHeight: 1.8,
      }}>
        <div style={{ fontWeight: 700, color: '#e5e7eb', marginBottom: '4px' }}>Recall Route</div>
        <div>Home - {rosterRouteLabel} - {recallRouteLabel} - {rosterRouteLabel} - Home</div>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Rostered Station</label>
        <input type="text" value={values.rosteredStn}
          onChange={(e) => onChange('rosteredStn', e.target.value)}
          placeholder={rosterLabel || 'e.g. FS45 - Brooklyn'}
          style={INPUT_STYLE} />
        {rosterStation && (
          <ResolvedStationChip station={rosterStation} />
        )}
        <p style={HELP_STYLE}>Auto-filled from your profile. Edit if different for this recall.</p>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Recall Station</label>
        <input type="text" value={values.recallStn}
          onChange={(e) => onChange('recallStn', e.target.value)}
          placeholder="e.g. FS44 - Sunshine" style={INPUT_STYLE} />
        {recallStation
          ? <ResolvedStationChip station={recallStation} />
          : (values.recallStn || '').trim()
            ? <UnresolvedStationHint />
            : null
        }
      </div>

      <StationDistanceField
        userId={userId}
        station={rosterStation}
        homeAddress={profile?.homeAddress || ''}
        profileLoading={profileLoading}
        value={values.distHomeKm}
        onChange={(v) => onChange('distHomeKm', v)}
        onRoutingMeta={onHomeLegMeta}
      />

      <RecallLegDistanceField
        userId={userId}
        originStation={rosterStation}
        destStation={recallStation}
        value={values.distStnKm}
        onChange={(km) => onChange('distStnKm', km)}
        onRoutingMeta={onStnLegMeta}
      />

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Incident Number</label>
        <input type="text" value={values.incidentNumber}
          onChange={(e) => onChange('incidentNumber', e.target.value)}
          placeholder="e.g. INC-2026-00123" style={INPUT_STYLE} />
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Meal Entitlement</label>
        <select value={values.mealEntitlement}
          onChange={(e) => onChange('mealEntitlement', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          <option value="none">No meal allowance</option>
          <option value="large">Large meal ($20.55)</option>
          <option value="double">Double meal ($31.45 - 1 small + 1 large for tax)</option>
        </select>
        <p style={HELP_STYLE}>Double meal counts as 1 small + 1 large for ATO tax purposes.</p>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Pay Number (Callback-Ops / Excess Travel)</label>
        <input type="text" value={values.payslipPayNbr}
          onChange={(e) => onChange('payslipPayNbr', e.target.value)}
          placeholder="e.g. 20.2026" style={INPUT_STYLE} />
      </div>
    </>
  )
}

// ─── Sub-form: Retain ─────────────────────────────────────────────────────────

function RetainInputs({ values, onChange, mealEligibility }) {
  const eligTier = mealEligibility?.tier || 'none'
  const eligColor = eligTier === 'none' ? '#9ca3af' : '#4ade80'
  const eligBg    = eligTier === 'none' ? 'rgba(107,114,128,0.08)' : 'rgba(34,197,94,0.08)'
  const eligBorder= eligTier === 'none' ? 'rgba(107,114,128,0.3)' : 'rgba(34,197,94,0.3)'

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
        <p style={HELP_STYLE}>Which shift was the retain attached to?</p>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Booked Off Time (24hr)</label>
        <input type="time" value={(values.bookedOffTime || '').slice(0, 5)}
          onChange={(e) => onChange('bookedOffTime', (e.target.value || '').slice(0, 5))}
          step="60"
          style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
        {mealEligibility?.thresholds && (
          <p style={HELP_STYLE}>
            {values.shift} thresholds: Large meal after {mealEligibility.thresholds.large},
            + Small meal after {mealEligibility.thresholds.smallAdditional}.
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

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Retain Allowance ($) - Maint stn N/N</label>
        <input type="number" min="0" step="0.01" placeholder="0.00"
          value={values.retainAmount}
          onChange={(e) => onChange('retainAmount', e.target.value)}
          style={INPUT_STYLE} />
        <p style={HELP_STYLE}>Payslip line: Maint stn N/N. Check your pay advice for the correct value.</p>
      </div>
      <div style={FIELD}>
        <label style={LABEL_STYLE}>Overnight Cash ($)</label>
        <input type="number" min="0" step="0.01" placeholder="0.00"
          value={values.overnightCash}
          onChange={(e) => onChange('overnightCash', e.target.value)}
          style={INPUT_STYLE} />
      </div>
      <div style={FIELD}>
        <label style={LABEL_STYLE}>Pay Number</label>
        <input type="text" value={values.payslipPayNbr}
          onChange={(e) => onChange('payslipPayNbr', e.target.value)}
          placeholder="e.g. 20.2026" style={INPUT_STYLE} />
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
  const standbyStation = parseAndResolve(values.standbyStn, stations)

  return (
    <>
      <div style={FIELD}>
        <label style={LABEL_STYLE}>Standby Type</label>
        <select value={values.standbyType}
          onChange={(e) => onChange('standbyType', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          <option value="Standby">Standby - Standby and Dismi on payslip</option>
          <option value="M&D">M&D - no meal allowance</option>
        </select>
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Standby / M&D Station</label>
        <input type="text" value={values.standbyStn || ''}
          onChange={(e) => onChange('standbyStn', e.target.value)}
          placeholder="e.g. FS44 - Sunshine" style={INPUT_STYLE} />
        {standbyStation
          ? <ResolvedStationChip station={standbyStation} />
          : (values.standbyStn || '').trim()
            ? <UnresolvedStationHint />
            : null
        }
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
        <select value={values.shift}
          onChange={(e) => onChange('shift', e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
          <option value="Day">Day - no meal allowance</option>
          <option value="Night">Night - meal if arrived after 19:00</option>
        </select>
      </div>

      {values.shift === 'Night' && values.standbyType !== 'M&D' && (
        <div style={FIELD}>
          <label style={LABEL_STYLE}>Arrival Time (24hr)</label>
          <input type="time" value={values.arrivedTime}
            onChange={(e) => onChange('arrivedTime', e.target.value)}
            style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
          <div style={{
            marginTop: '6px', padding: '8px 12px', borderRadius: '6px', fontSize: '0.78rem',
            background: nightMealEligible ? 'rgba(34,197,94,0.08)' : 'rgba(251,191,36,0.08)',
            border: '1px solid ' + (nightMealEligible ? 'rgba(34,197,94,0.3)' : 'rgba(251,191,36,0.3)'),
            color: nightMealEligible ? '#4ade80' : '#fbbf24',
          }}>
            {nightMealEligible
              ? 'Arrived after 19:00 - night meal applies'
              : 'Arrival at or before 19:00 does not qualify for night meal'}
          </div>
        </div>
      )}

      {values.standbyType === 'M&D' && (
        <div style={{
          padding: '8px 12px', borderRadius: '6px', marginBottom: '16px',
          background: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)',
          fontSize: '0.78rem', color: '#9ca3af',
        }}>
          M&D claims have no meal allowance.
        </div>
      )}

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Pay Number (Standby and Dismi)</label>
        <input type="text" value={values.payslipPayNbr}
          onChange={(e) => onChange('payslipPayNbr', e.target.value)}
          placeholder="e.g. 20.2026" style={INPUT_STYLE} />
      </div>
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
        <input type="time" value={values.incidentTime}
          onChange={(e) => onChange('incidentTime', e.target.value)}
          style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
        {incidentStatus && incidentStatus !== 'unknown' && (
          <div style={{
            marginTop: '6px', padding: '6px 12px', borderRadius: '6px',
            fontSize: '0.78rem', color: statusColor[incidentStatus] || '#9ca3af',
          }}>
            {statusText[incidentStatus]}
          </div>
        )}
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Meal Interrupted At (optional)</label>
        <input type="time" value={values.mealInterrupted}
          onChange={(e) => onChange('mealInterrupted', e.target.value)}
          style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
      </div>

      <div style={FIELD}>
        <label style={LABEL_STYLE}>Return to Station (optional)</label>
        <input type="time" value={values.returnToStn}
          onChange={(e) => onChange('returnToStn', e.target.value)}
          style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
        <p style={HELP_STYLE}>These times are for your records only. They do not affect the claim amount.</p>
      </div>
    </>
  )
}

// ─── Default values per type ──────────────────────────────────────────────────

const DEFAULTS = {
  recalls:      { rosteredStn: '', recallStn: '', distHomeKm: '', distStnKm: '', mealEntitlement: 'none', incidentNumber: '', payslipPayNbr: '' },
  retain:       { retainAmount: '', overnightCash: '', payslipPayNbr: '', shift: 'Day', bookedOffTime: '' },
  standby:      { standbyType: 'Standby', standbyStn: '', distKm: '', shift: 'Day', arrivedTime: '', payslipPayNbr: '' },
  spoilt:       { mealType: 'Spoilt',   shift: 'Day', incidentTime: '', mealInterrupted: '', returnToStn: '' },
  delayed_meal: { mealType: 'Delayed',  shift: 'Day', incidentTime: '', mealInterrupted: '', returnToStn: '' },
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

export default function ClaimForm({ userId, financialYearId, onSuccess, onCancel, initialClaimType, initialStandbyType }) {
  const { addClaim } = useClaims()
  const { rates }    = useRates()

  // Quick-action prefill: open the form directly on the requested type.
  // initialStandbyType lets the M&D quick-action land on Standby with the
  // Muster & Dismiss sub-type pre-selected (no separate top-level type).
  const startingType = CLAIM_TYPE_ORDER.includes(initialClaimType) ? initialClaimType : 'recalls'

  const [claimType, setClaimType]           = useState(startingType)
  const [date, setDate]                     = useState(getTodayLocal)
  const [fields, setFields]                 = useState(() => {
    const base = { ...DEFAULTS[startingType] }
    if (startingType === 'standby' && initialStandbyType) {
      base.standbyType = initialStandbyType
    }
    return base
  })
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
  // On first mount with a quick-action prefill, preserve initialStandbyType so
  // the M&D button lands on Standby with the M&D sub-type already selected.
  const didMountRef = useRef(false)
  useEffect(() => {
    const defaults = { ...DEFAULTS[claimType] }
    if (claimType === 'recalls' && profile?.stationLabel) {
      defaults.rosteredStn = profile.stationLabel
      defaults.distHomeKm  = profile.homeDistKm ? String(profile.homeDistKm) : ''
    }
    if (!didMountRef.current && claimType === 'standby' && initialStandbyType) {
      defaults.standbyType = initialStandbyType
    }
    didMountRef.current = true
    setFields(defaults)
    setBreakdown(null)
    setAdjustedAmount(null)
    setShowCalcLines(null)
    setError(null)
    setRecallHomeMeta(null)
    setRecallStnMeta(null)
    setStandbyTravelMeta(null)
  }, [claimType, profile, initialStandbyType])

  // Auto-calculate on field/rate change
  useEffect(() => {
    const num = (v) => Number(v) || 0
    let result = null
    try {
      if (claimType === 'recalls') {
        result = calcRecallClaim({
          distHomeKm:      num(fields.distHomeKm),
          distStnKm:       num(fields.distStnKm),
          mealEntitlement: fields.mealEntitlement,
        }, rates)
      } else if (claimType === 'retain') {
        result = calcRetainClaim({
          retainAmount:  num(fields.retainAmount),
          overnightCash: num(fields.overnightCash),
          shift:         fields.shift,
          bookedOffTime: fields.bookedOffTime,
        }, rates)
      } else if (claimType === 'standby') {
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
        mealEntitlement: fields.mealEntitlement,
      }, rates, { rosterStation: fields.rosteredStn || 'Rostered Stn', recallStation: fields.recallStn || 'Recall Stn' })
    } else if (claimType === 'standby') {
      lines = buildStandbyCalcLines({
        distKm: num(fields.distKm), standbyType: fields.standbyType,
        arrivedTime: fields.arrivedTime, shift: fields.shift,
      }, rates)
    } else if (claimType === 'spoilt') {
      lines = buildSpoiltCalcLines({
        mealType: fields.mealType, shift: fields.shift,
        incidentTime: fields.incidentTime, mealInterrupted: fields.mealInterrupted,
        returnToStn: fields.returnToStn,
      }, rates)
    } else if (claimType === 'delayed_meal') {
      lines = buildSpoiltCalcLines({
        mealType: 'Delayed', shift: fields.shift,
        incidentTime: fields.incidentTime, mealInterrupted: fields.mealInterrupted,
        returnToStn: fields.returnToStn,
      }, rates)
    } else if (claimType === 'retain') {
      lines = buildRetainCalcLines({
        retainAmount:  num(fields.retainAmount),
        overnightCash: num(fields.overnightCash),
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
    if (!breakdown || breakdown.totalAmount <= 0) {
      setError('Calculated amount must be greater than $0.00.'); return
    }

    const num = (v) => Number(v) || 0
    let calcLines = []
    if (claimType === 'recalls') {
      calcLines = buildRecallCalcLines(
        { distHomeKm: num(fields.distHomeKm), distStnKm: num(fields.distStnKm), mealEntitlement: fields.mealEntitlement },
        rates,
        { rosterStation: fields.rosteredStn, recallStation: fields.recallStn }
      )
    } else if (claimType === 'standby') {
      calcLines = buildStandbyCalcLines(
        { distKm: num(fields.distKm), standbyType: fields.standbyType, arrivedTime: fields.arrivedTime, shift: fields.shift },
        rates
      )
    } else if (claimType === 'spoilt') {
      calcLines = buildSpoiltCalcLines(
        { mealType: fields.mealType, shift: fields.shift, incidentTime: fields.incidentTime, mealInterrupted: fields.mealInterrupted, returnToStn: fields.returnToStn },
        rates
      )
    } else if (claimType === 'delayed_meal') {
      calcLines = buildSpoiltCalcLines(
        { mealType: 'Delayed', shift: fields.shift, incidentTime: fields.incidentTime, mealInterrupted: fields.mealInterrupted, returnToStn: fields.returnToStn },
        rates
      )
    } else if (claimType === 'retain') {
      calcLines = buildRetainCalcLines(
        { retainAmount: num(fields.retainAmount), overnightCash: num(fields.overnightCash), shift: fields.shift, bookedOffTime: fields.bookedOffTime },
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
      : claimType === 'standby'
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

      {claimType === 'recalls'      && <RecallInputs values={fields} onChange={handleFieldChange} profile={profile} profileLoading={profileLoading} userId={userId} stations={stations} onHomeLegMeta={setRecallHomeMeta} onStnLegMeta={setRecallStnMeta} />}
      {claimType === 'retain'       && (
        <RetainInputs
          values={fields}
          onChange={handleFieldChange}
          mealEligibility={calcRetainMealEligibility({ shift: fields.shift, bookedOffTime: fields.bookedOffTime })}
        />
      )}
      {claimType === 'standby'      && <StandbyInputs values={fields} onChange={handleFieldChange} nightMealEligible={nightMealEligible} profile={profile} userId={userId} stations={stations} onStandbyMeta={setStandbyTravelMeta} />}
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
