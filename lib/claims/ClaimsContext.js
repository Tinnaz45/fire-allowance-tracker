'use client'

// ─── Claims Context ────────────────────────────────────────────────────────────
// Manages claim data: fetching, creating, updating, and grouping claims.
//
// KEY ARCHITECTURE (v2):
//   - Every claim save includes financial_year_id from the active FY.
//   - claim_number is generated atomically via fat.increment_claim_sequence() RPC.
//   - Grouped claims: parent fat.claim_groups row + child rows with claim_group_id.
//   - Auto-child generation: Recalls/Retain/Standby/M&D create child payout items.
//   - loadClaims filters by active FY via financial_year_id (not date range).
//   - fat.claim_groups are loaded separately and merged into grouped display.
//
// All FAT tables/RPCs live in the `fat` schema and are accessed via the
// `fat` schema-scoped client exported from lib/supabaseClient.js — see
// docs/FAT_SCHEMA_ARCHITECTURE.md.
//
// Historical claim totals are NEVER recalculated from rates — they always
// read total_amount (or meal_amount) as stored in Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { fat } from '@/lib/supabaseClient'
import { CLAIM_TABLES, resolveClaimTable, resolveClaimMealType, resolveClaimStandbyType } from '@/lib/claims/claimTypes'
import { createRateSnapshot, buildClaimLabel, formatDateDDMMYYYY, normaliseStandbyArrivedTime } from '@/lib/calculations/engine'

// ─── Context ──────────────────────────────────────────────────────────────────

const ClaimsContext = createContext(null)

// ─── Claim sequence incrementor ───────────────────────────────────────────────
// Calls the DB function fat.increment_claim_sequence() atomically.
// Returns the new sequential integer for this claim type in this FY.

async function getNextClaimNumber(userId, financialYearId, claimType) {
  const { data, error } = await fat.rpc('increment_claim_sequence', {
    p_user_id:           userId,
    p_financial_year_id: financialYearId,
    p_claim_type:        claimType,
  })
  if (error) throw new Error(`Sequence error: ${error.message}`)
  return data // integer
}

// ─── Claim group creator ──────────────────────────────────────────────────────
// Creates the parent fat.claim_groups row and returns it.
// label: e.g. 'Recall #16 (12/02/2026)'

async function createClaimGroup(userId, financialYearId, claimType, claimNumber, date, incidentNumber) {
  const label = buildClaimLabel(claimType, claimNumber, date)
  const now   = new Date()
  const overdue_at = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await fat
    .from('claim_groups')
    .insert({
      user_id:          userId,
      financial_year_id: financialYearId,
      label,
      claim_type:       claimType,
      claim_number:     claimNumber,
      incident_date:    date || null,
      incident_number:  incidentNumber || null,
      parent_status:    'Pending',
      overdue_at,
    })
    .select()
    .single()

  if (error) throw new Error(`Group create error: ${error.message}`)
  return data
}

// ─── Auto-child payout item definitions ──────────────────────────────────────
// Returns array of child rows to auto-create for a given parent claim type.
// Each child is inserted into the appropriate claim table with claim_group_id.

function getAutoChildDefinitions(claimType, parentId, userId, date, financialYearId, fields, breakdown, ratesSnapshot) {
  const children = []

  if (claimType === 'recalls') {
    // Callback-Ops: travel payout via payslip
    if (breakdown.travelAmount > 0) {
      children.push({
        table: 'recalls',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          dist_home_km:     Number(fields.distHomeKm) || 0,
          dist_stn_km:      Number(fields.distStnKm)  || 0,
          travel_amount:    breakdown.travelAmount,
          mealie_amount:    0,
          total_amount:     breakdown.travelAmount,
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          incident_number:  fields.incidentNumber || null,
          recall_stn_label: fields.recallStn      || null,
          rostered_stn_label: fields.rosteredStn  || null,
          payslip_pay_nbr:  fields.payslipPayNbr  || null,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'callback_ops', distHomeKm: Number(fields.distHomeKm) || 0, distStnKm: Number(fields.distStnKm) || 0 },
          _child_label:     'Callback-Ops',
        },
      })
    }
    // Excess Travel: if stn-to-stn leg exists
    if ((Number(fields.distStnKm) || 0) > 0) {
      children.push({
        table: 'recalls',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          dist_home_km:     0,
          dist_stn_km:      Number(fields.distStnKm) || 0,
          travel_amount:    breakdown.excessTravelAmount || 0,
          mealie_amount:    0,
          total_amount:     breakdown.excessTravelAmount || 0,
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          incident_number:  fields.incidentNumber || null,
          recall_stn_label: fields.recallStn      || null,
          rostered_stn_label: fields.rosteredStn  || null,
          payslip_pay_nbr:  fields.payslipPayNbr  || null,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'excess_travel', distStnKm: Number(fields.distStnKm) || 0 },
          _child_label:     'Excess Travel',
        },
      })
    }
    // Petty cash meal if entitled
    if (fields.mealEntitlement && fields.mealEntitlement !== 'none' && breakdown.mealieAmount > 0) {
      children.push({
        table: 'spoilt_meals',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          meal_type:        fields.mealEntitlement === 'double' ? 'Double' : 'Large',
          shift:            'Day',
          meal_amount:      breakdown.mealieAmount,
          total_amount:     breakdown.mealieAmount,
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'petty_cash_meal', mealEntitlement: fields.mealEntitlement },
          _child_label:     'Petty cash meal',
        },
      })
    }
  }

  if (claimType === 'retain') {
    // Maint stn N/N payout
    if (breakdown.retainAmount > 0) {
      children.push({
        table: 'retain',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          retain_amount:    breakdown.retainAmount,
          overnight_cash:   0,
          total_amount:     breakdown.retainAmount,
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          payslip_pay_nbr:  fields.payslipPayNbr || null,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'maint_stn_nn' },
          _child_label:     'Maint stn N/N',
        },
      })
    }
    // Overnight cash if applicable
    if (breakdown.overnightCash > 0) {
      children.push({
        table: 'retain',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          retain_amount:    0,
          overnight_cash:   breakdown.overnightCash,
          total_amount:     breakdown.overnightCash,
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          payslip_pay_nbr:  fields.payslipPayNbr || null,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'overnight_cash' },
          _child_label:     'Petty cash overnight',
        },
      })
    }
    // Retain meal allowance (auto-derived from shift + booked-off time).
    // Stored on fat.spoilt_meals using meal_type='Large' or 'Double' so it
    // flows through the existing meal-handling code paths (incl. tax summary).
    if ((breakdown.mealAmount ?? 0) > 0) {
      const isLargePlusSmall = (breakdown.smallCount ?? 0) > 0 && (breakdown.largeCount ?? 0) > 0
      children.push({
        table: 'spoilt_meals',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          meal_type:        isLargePlusSmall ? 'Double' : 'Large',
          shift:            fields.shift || 'Day',
          meal_amount:      breakdown.mealAmount,
          total_amount:     breakdown.mealAmount,
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: {
            autoChild:      'retain_meal',
            shift:          fields.shift         || null,
            bookedOffTime:  fields.bookedOffTime || null,
            smallMealCount: breakdown.smallCount ?? 0,
            largeMealCount: breakdown.largeCount ?? 0,
            mealTier:       breakdown.mealTier   || 'none',
          },
          _child_label:     isLargePlusSmall ? 'Petty cash meal (Large + Small)' : 'Petty cash meal (Large)',
        },
      })
    }
  }

  if (claimType === 'standby' || claimType === 'md') {
    // Small Meal Allowance (Petty Cash) — only when night standby and arrived ≥ 19:00
    // (never generated for M&D, whose nightMealie breakdown is always 0)
    if (breakdown.nightMealie > 0) {
      children.push({
        table: 'spoilt_meals',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          meal_type:        'Spoilt',
          shift:            'Night',
          meal_amount:      breakdown.nightMealie,
          total_amount:     breakdown.nightMealie,
          payment_method:   'Petty Cash',
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'standby_small_meal' },
          _child_label:     'Small Meal Allowance',
        },
      })
    }
    // Excess Travel (Payslip) — km × rate, rostered ↔ standby station.
    // Pay Number is collected at mark-as-paid time, not at create time.
    if (breakdown.travelAmount > 0) {
      children.push({
        table: 'standby',
        row: {
          user_id:          userId,
          date,
          status:           'Pending',
          standby_type:     fields.standbyType || 'Standby',
          shift:            fields.shift || 'Day',
          dist_km:          Number(fields.distKm) || 0,
          travel_amount:    breakdown.travelAmount,
          night_mealie:     0,
          total_amount:     breakdown.travelAmount,
          payment_method:   'Payslip',
          financial_year_id: financialYearId,
          claim_group_id:   parentId,
          rates_snapshot:   ratesSnapshot,
          calculation_inputs: { autoChild: 'standby_excess_travel', distKm: Number(fields.distKm) || 0 },
          _child_label:     'Excess Travel',
        },
      })
    }
  }

  return children
}

// ─── Data Fetching ────────────────────────────────────────────────────────────
// Fetches all claims for a user filtered by financial_year_id.
// Falls back to date-range filter for claims that predate the FY column addition.

async function fetchClaimsForFY(userId, financialYearId, fyStartDate, fyEndDate) {
  const results = await Promise.all(
    CLAIM_TABLES.map((table) => {
      let query = fat
        .from(table)
        .select('*')
        .eq('user_id', userId)
        .order('date', { ascending: false })

      if (financialYearId) {
        // Primary filter: FK match (fast, isolates correctly)
        query = query.eq('financial_year_id', financialYearId)
      } else if (fyStartDate && fyEndDate) {
        // Fallback: date-range filter for legacy rows without FY id
        query = query.gte('date', fyStartDate).lte('date', fyEndDate)
      }

      return query
    })
  )

  const combined = []
  for (let i = 0; i < CLAIM_TABLES.length; i++) {
    const { data, error } = results[i]
    if (error) {
      console.error(`[Claims] Supabase error on table "${CLAIM_TABLES[i]}":`, error)
      throw new Error(`Failed to load ${CLAIM_TABLES[i]} claims.`)
    }
    if (data) {
      const table = CLAIM_TABLES[i]
      data.forEach((row) => {
        // fat.spoilt_meals rows are split into two virtual claimTypes based on meal_type:
        //   meal_type 'Delayed' → claimType 'delayed_meal'
        //   meal_type 'Spoilt' (or legacy 'Spoilt / Meal') → claimType 'spoilt'
        // fat.standby rows are split into two virtual claimTypes based on standby_type:
        //   standby_type 'M&D' → claimType 'md'
        //   standby_type 'Standby' (or null) → claimType 'standby'
        let claimType = table
        if (table === 'spoilt_meals') {
          const mt = row.meal_type || 'Spoilt'
          claimType = (mt === 'Delayed') ? 'delayed_meal' : 'spoilt'
        } else if (table === 'standby') {
          claimType = (row.standby_type === 'M&D') ? 'md' : 'standby'
        }
        combined.push({ ...row, claimType })
      })
    }
  }

  combined.sort((a, b) => new Date(b.date) - new Date(a.date))
  return combined
}

// ─── Fetch claim groups for a FY ─────────────────────────────────────────────

async function fetchClaimGroupsForFY(userId, financialYearId) {
  if (!financialYearId) return []
  const { data, error } = await fat
    .from('claim_groups')
    .select('*')
    .eq('user_id', userId)
    .eq('financial_year_id', financialYearId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[Claims] Group fetch error:', error)
    return []
  }
  return data || []
}

// ─── Row builders — map form payload to Supabase column shapes ────────────────
// All builders now include financial_year_id and claim_number.

function buildRecallRow(userId, date, breakdown, fields, ratesSnapshot, financialYearId, claimNumber, claimGroupId, routingMeta) {
  const distHome = Number(fields.distHomeKm) || 0
  const distStn  = Number(fields.distStnKm)  || 0

  // Routing provenance from the travel subsystem. Sources can be 'google',
  // 'osrm-fallback' (server-side fallback), 'osrm' (client-side direct
  // fallback), 'manual', 'cached', or 'self'. We collapse the two legs to a
  // single routing_source for fast queryability — 'mixed' when they differ.
  const homeSrc = routingMeta?.home?.source || null
  const stnSrc  = routingMeta?.stn?.source  || null
  const collapsedSrc = !homeSrc && !stnSrc ? null
                    : !stnSrc              ? homeSrc
                    : !homeSrc             ? stnSrc
                    : homeSrc === stnSrc   ? homeSrc
                    : 'mixed'
  const calcAt = routingMeta?.home?.calculatedAt || routingMeta?.stn?.calculatedAt || null

  return {
    user_id:            userId,
    date,
    status:             'Pending',
    dist_home_km:       distHome,
    dist_stn_km:        distStn,
    // total_km is a generated column in Supabase — do NOT write it
    travel_amount:      breakdown.travelAmount,
    mealie_amount:      breakdown.mealieAmount,
    total_amount:       breakdown.totalAmount,
    adjusted_amount:    breakdown.adjustedAmount ?? null,
    calc_snapshot:      breakdown.calcSnapshot ?? null,
    rates_snapshot:     ratesSnapshot,
    financial_year_id:  financialYearId || null,
    claim_number:       claimNumber     || null,
    claim_group_id:     claimGroupId    || null,
    incident_number:    fields.incidentNumber   || null,
    recall_stn_label:   fields.recallStn        || null,
    rostered_stn_label: fields.rosteredStn      || null,
    payslip_pay_nbr:    fields.payslipPayNbr    || null,
    google_km_home:     routingMeta?.home?.km ?? null,
    google_km_stn:      routingMeta?.stn?.km  ?? null,
    routing_source:     collapsedSrc,
    travel_calc_at:     calcAt,
    calculation_inputs: {
      distHomeKm:      distHome,
      distStnKm:       distStn,
      totalKm:         breakdown.totalKm,
      mealEntitlement: fields.mealEntitlement,
      routing:         routingMeta || null,
    },
  }
}

function buildRetainRow(userId, date, breakdown, fields, ratesSnapshot, financialYearId, claimNumber, claimGroupId) {
  return {
    user_id:          userId,
    date,
    status:           'Pending',
    shift:            fields.shift          || null,
    booked_off_time:  fields.bookedOffTime  || null,
    retain_amount:    breakdown.retainAmount,
    overnight_cash:   breakdown.overnightCash,
    total_amount:     breakdown.totalAmount,
    adjusted_amount:  breakdown.adjustedAmount ?? null,
    calc_snapshot:    breakdown.calcSnapshot ?? null,
    rates_snapshot:   ratesSnapshot,
    financial_year_id: financialYearId || null,
    claim_number:     claimNumber      || null,
    claim_group_id:   claimGroupId     || null,
    payslip_pay_nbr:  fields.payslipPayNbr || null,
    calculation_inputs: {
      retainAmount:   Number(fields.retainAmount)  || 0,
      overnightCash:  Number(fields.overnightCash) || 0,
      shift:          fields.shift         || null,
      bookedOffTime:  fields.bookedOffTime || null,
      mealAmount:     breakdown.mealAmount ?? 0,
      smallMealCount: breakdown.smallCount ?? 0,
      largeMealCount: breakdown.largeCount ?? 0,
      mealTier:       breakdown.mealTier   || 'none',
      mealLabel:      breakdown.mealLabel  || null,
    },
  }
}

function buildStandbyRow(userId, date, breakdown, fields, ratesSnapshot, financialYearId, claimNumber, claimGroupId, routingMeta) {
  const standby = routingMeta?.standby || null
  // Canonical internal storage for arrival time is the "HHMM" 4-digit numeric
  // string. Manual numeric form input is normalised here so engine consumers
  // and downstream readers only see one shape. Legacy rows with HH:MM remain
  // readable via parseStandbyArrivedTime().
  const arrivedTime = normaliseStandbyArrivedTime(fields.arrivedTime)

  // The parent fat.standby row is the operational record AND the Standby&Dismi
  // payroll-entitlement marker (no dollar amount, no contribution to totals).
  // All financial amounts live on the child auto-rows (Excess Travel — Payslip;
  // Small Meal Allowance — Petty Cash). Pay Number is collected at the
  // mark-as-paid step, not here.
  // dist_km on the parent row is set to 0 to avoid double-counting in the tax
  // summary (which iterates all rows of type 'standby'). The original km is
  // preserved in calculation_inputs.distKm and on the Excess Travel child row.
  return {
    user_id:          userId,
    date,
    status:           'Pending',
    standby_type:     fields.standbyType || 'Standby',
    shift:            fields.shift || 'Day',
    dist_km:          0,
    travel_amount:    0,
    night_mealie:     0,
    total_amount:     0,
    adjusted_amount:  null,
    // Standby&Dismi is paid via payslip — payment_method tags the row as a
    // Payslip entitlement (so the mark-as-paid flow prompts for Pay Number)
    // while total_amount = 0 keeps it out of payslip dollar totals.
    payment_method:   fields.standbyType === 'M&D' ? null : 'Payslip',
    calc_snapshot:    breakdown.calcSnapshot ?? null,
    arrived_time:     arrivedTime,
    rates_snapshot:   ratesSnapshot,
    financial_year_id: financialYearId || null,
    claim_number:     claimNumber      || null,
    claim_group_id:   claimGroupId     || null,
    google_km_oneway:  standby?.googleKmOneway ?? null,
    matrix_hours:      standby?.matrixHours    ?? null,
    matrix_version_id: standby?.matrixVersionId ?? null,
    routing_source:    standby?.source         ?? null,
    travel_calc_at:    standby?.calculatedAt   ?? null,
    calculation_inputs: {
      // Standby&Dismi is a Standby-only entitlement marker. M&D events get a
      // distinct autoChild value so labels and pay-number prompting can
      // discriminate the two without inspecting standby_type.
      autoChild:   fields.standbyType === 'M&D' ? 'md_event' : 'standby_and_dismi',
      distKm:      Number(fields.distKm) || 0,
      shift:       fields.shift || 'Day',
      standbyType: fields.standbyType || 'Standby',
      arrivedTime,
      standbyStn:  fields.standbyStn || null,
      routing:     standby || null,
      // Snapshot the entitlement amounts that were generated alongside this
      // event, so the calc breakdown remains reproducible from the parent row.
      generatedEntitlements: {
        excessTravel:      breakdown.travelAmount ?? 0,
        smallMealAllowance: breakdown.nightMealie ?? 0,
      },
    },
  }
}

function buildSpoiltRow(userId, date, breakdown, fields, ratesSnapshot, financialYearId, claimNumber, claimGroupId) {
  return {
    user_id:          userId,
    date,
    status:           'Pending',
    meal_type:        fields.mealType || 'Spoilt',
    shift:            fields.shift || 'Day',
    meal_amount:      breakdown.mealAmount,
    total_amount:     breakdown.totalAmount,
    adjusted_amount:  breakdown.adjustedAmount ?? null,
    calc_snapshot:    breakdown.calcSnapshot ?? null,
    incident_time:    fields.incidentTime    || null,
    meal_interrupted: fields.mealInterrupted || null,
    return_to_stn:    fields.returnToStn     || null,
    rates_snapshot:   ratesSnapshot,
    financial_year_id: financialYearId || null,
    claim_number:     claimNumber      || null,
    claim_group_id:   claimGroupId     || null,
    calculation_inputs: {
      mealType: fields.mealType || 'Spoilt',
      shift:    fields.shift    || 'Day',
    },
  }
}

const ROW_BUILDERS = {
  recalls:      buildRecallRow,
  retain:       buildRetainRow,
  standby:      buildStandbyRow,
  md:           buildStandbyRow,
  spoilt:       buildSpoiltRow,
  delayed_meal: buildSpoiltRow,
}

// ─── Parent status calculator ─────────────────────────────────────────────────
// CANONICAL TRUTH SOURCE: subclaim.payment_status
//
// Derives parent status from child payment_status fields ONLY.
// Falls back to child.status only if payment_status is null (legacy rows).
// Rules:
//   - Parent = 'Paid'    only when ALL children are Paid
//   - Parent = 'Pending' if any child is Pending (or NULL → treated as Pending)
//   - Parent = 'Disputed' if any child status is Disputed (legacy path only)
//
// DO NOT use parent_status as an authoritative source anywhere.
// parent_status in fat.claim_groups is a CACHED PROJECTION, not truth.

function calcParentStatus(childClaims) {
  if (!childClaims || childClaims.length === 0) return 'Pending'

  // Prefer payment_status as canonical. Fall back to status for legacy rows.
  const resolvedStatuses = childClaims.map((c) => {
    if (c.payment_status != null) return (c.payment_status || 'Pending').toLowerCase()
    return (c.status || 'Pending').toLowerCase()
  })

  if (resolvedStatuses.some((s) => s === 'disputed')) return 'Disputed'
  if (resolvedStatuses.every((s) => s === 'paid')) return 'Paid'
  if (resolvedStatuses.some((s) => s === 'paid')) return 'Partially Paid'
  return 'Pending'
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ClaimsProvider({ children }) {
  const [claims, setClaims]         = useState([])
  const [claimGroups, setClaimGroups] = useState([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)

  // Guard against concurrent duplicate mutations
  const mutating = useRef(false)

  // ── Load claims + groups for a user + FY ──────────────────────────────────
  // financialYearId: the active FY's UUID. Pass null to load without FY filter.
  // fyStartDate/fyEndDate: ISO strings for fallback date-range filter.

  const loadClaims = useCallback(async (userId, financialYearId, fyStartDate, fyEndDate) => {
    setLoading(true)
    setError(null)
    try {
      const [data, groups] = await Promise.all([
        fetchClaimsForFY(userId, financialYearId, fyStartDate, fyEndDate),
        fetchClaimGroupsForFY(userId, financialYearId),
      ])
      setClaims(data)
      setClaimGroups(groups)
    } catch (err) {
      console.error('[Claims] Fetch failed:', err)
      const isAuthError = err?.message?.includes('JWT') || err?.code === 'PGRST301'
      if (isAuthError) {
        setError('Your session has expired. Please sign in again.')
      } else {
        setError('Unable to load your claims. Please try refreshing the page.')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Add a new claim ───────────────────────────────────────────────────────
  // Accepts the structured payload from ClaimForm.
  // { userId, claimType, date, breakdown, fields, rates, financialYearId }
  //
  // Flow:
  //   1. Atomically increment claim sequence → claimNumber
  //   2. Create fat.claim_groups parent row (label includes number + date)
  //   3. Insert parent claim row with claim_number + claim_group_id + financial_year_id
  //   4. Auto-insert child payout rows (Callback-Ops, Excess Travel, etc.)
  //   5. Reload claims for the active FY

  const addClaim = useCallback(async ({ userId, claimType, date, breakdown, fields, rates, financialYearId, routingMeta = null }) => {
    if (mutating.current) throw new Error('A save is already in progress. Please wait.')
    mutating.current = true

    try {
      const builder = ROW_BUILDERS[claimType]
      if (!builder) throw new Error(`Unknown claim type: ${claimType}`)

      const ratesSnapshot = createRateSnapshot(rates)

      // Step 1: Get the next sequential claim number (atomic DB function)
      let claimNumber = null
      if (financialYearId) {
        claimNumber = await getNextClaimNumber(userId, financialYearId, claimType)
      }

      // Step 2: Create the parent claim group row
      let claimGroupId = null
      if (financialYearId && claimNumber) {
        const group = await createClaimGroup(
          userId,
          financialYearId,
          claimType,
          claimNumber,
          date,
          fields.incidentNumber || null
        )
        claimGroupId = group.id
      }

      // Step 3: Insert the parent claim row
      // For virtual claimTypes (e.g. delayed_meal, md), resolve the actual DB table
      // and force the correct discriminator column value (meal_type / standby_type)
      // before passing to the row builder.
      const dbTable = resolveClaimTable(claimType)
      const forcedMealType = resolveClaimMealType(claimType)
      const forcedStandbyType = resolveClaimStandbyType(claimType)
      const resolvedFields = {
        ...fields,
        ...(forcedMealType ? { mealType: forcedMealType } : {}),
        ...(forcedStandbyType ? { standbyType: forcedStandbyType } : {}),
      }
      const row = builder(userId, date, breakdown, resolvedFields, ratesSnapshot, financialYearId, claimNumber, claimGroupId, routingMeta)
      const { error: insertError } = await fat.from(dbTable).insert(row)
      if (insertError) throw insertError

      // Step 4: Auto-insert child payout items
      if (claimGroupId) {
        const childDefs = getAutoChildDefinitions(
          claimType, claimGroupId, userId, date, financialYearId, resolvedFields, breakdown, ratesSnapshot
        )
        for (const { table, row: childRow } of childDefs) {
          // Strip internal _child_label helper before inserting
          const { _child_label, ...insertRow } = childRow
          const { error: childError } = await fat.from(table).insert(insertRow)
          if (childError) {
            console.warn(`[Claims] Child insert warning (${table}/${_child_label}):`, childError)
            // Non-fatal: log but continue
          }
        }
      }

      // Step 5: Reload
      await loadClaims(userId, financialYearId)
    } finally {
      mutating.current = false
    }
  }, [loadClaims])

  // ── Update an existing claim ──────────────────────────────────────────────
  // Only updates date, total_amount, and status.
  // Does NOT recalculate from rates — preserves the original calculation.
  // After updating a child, also recomputes the parent group status.

  const updateClaim = useCallback(async ({ userId, claim, date, amount, status, financialYearId }) => {
    if (mutating.current) throw new Error('A save is already in progress. Please wait.')
    mutating.current = true

    try {
      // Determine which amount column to update based on claim type
      // Both 'spoilt' and 'delayed_meal' use the spoilt table's meal_amount column
      const amountColumn = (claim.claimType === 'spoilt' || claim.claimType === 'delayed_meal')
        ? 'meal_amount'
        : 'total_amount'

      const { error: updateError } = await fat
        .from(resolveClaimTable(claim.claimType))
        .update({ date, [amountColumn]: Number(amount), status })
        .eq('id', claim.id)

      if (updateError) throw updateError

      // If this claim belongs to a group, recompute the parent status
      if (claim.claim_group_id) {
        await recomputeGroupStatus(claim.claim_group_id, userId, financialYearId)
      }

      await loadClaims(userId, financialYearId)
    } finally {
      mutating.current = false
    }
  }, [loadClaims])

  // ── Update a child claim status directly ──────────────────────────────────
  // Lightweight status-only update for grouped child claims.

  const updateChildStatus = useCallback(async ({ userId, claim, status, financialYearId }) => {
    if (mutating.current) throw new Error('A save is already in progress. Please wait.')
    mutating.current = true

    try {
      const { error: updateError } = await fat
        .from(resolveClaimTable(claim.claimType))
        .update({ status })
        .eq('id', claim.id)

      if (updateError) throw updateError

      // Recompute parent group status
      if (claim.claim_group_id) {
        await recomputeGroupStatus(claim.claim_group_id, userId, financialYearId)
      }

      await loadClaims(userId, financialYearId)
    } finally {
      mutating.current = false
    }
  }, [loadClaims])


  // ── Update component-level payment status (Phase 2) ───────────────────────
  // Toggles payment_status (Pending ↔ Paid) on a child claim row.
  // Operates on the NEW payment_status column — does NOT touch existing status col.
  // Mirrors change to fat.payment_components ledger if a row exists.
  // Legacy claims (payment_status = NULL) are safely handled — toggle never shown.

  const updatePaymentStatus = useCallback(async ({ userId, claim, paymentStatus, payNumber, financialYearId }) => {
    if (mutating.current) throw new Error('A save is already in progress. Please wait.')
    mutating.current = true

    try {
      const table = resolveClaimTable(claim.claimType)
      const isPaid = paymentStatus === 'Paid'
      const paymentDate = isPaid ? new Date().toISOString() : null

      // 1. Update the claim row's payment_status + payment_date columns
      // (and payslip_pay_nbr when a Pay Number was captured during mark-as-paid).
      const updatePayload = { payment_status: paymentStatus, payment_date: paymentDate }
      if (isPaid && payNumber) {
        updatePayload.payslip_pay_nbr = String(payNumber).trim()
      }
      const { error: updateError } = await fat
        .from(table)
        .update(updatePayload)
        .eq('id', claim.id)

      if (updateError) throw updateError

      // 2. Mirror to fat.payment_components ledger if a row exists for this claim.
      // The ledger table is created by the v3 payment migration; if absent, this
      // sync is silently skipped.
      try {
        const { data: componentRows } = await fat
          .from('payment_components')
          .select('id')
          .eq('claim_table', table)
          .eq('claim_id', claim.id)

        if (componentRows && componentRows.length > 0) {
          await fat
            .from('payment_components')
            .update({ payment_status: paymentStatus, payment_date: paymentDate })
            .eq('claim_table', table)
            .eq('claim_id', claim.id)
        }
      } catch (ledgerErr) {
        // Non-fatal: ledger sync failure should not block the UI update
        console.warn('[Claims] Payment component ledger sync warning:', ledgerErr)
      }

      // 3. Reload — derived payment status is computed client-side in groupedView
      await loadClaims(userId, financialYearId)
    } finally {
      mutating.current = false
    }
  }, [loadClaims])

  // ── Recompute parent group status from all children ───────────────────────
  // Fetches payment_status (canonical) and status (legacy fallback) from all
  // child rows, then writes the derived parent_status to fat.claim_groups.
  // parent_status in the DB is a CACHED PROJECTION of child payment states —
  // it is NEVER independently authoritative.

  async function recomputeGroupStatus(groupId, userId, financialYearId) {
    // Fetch both payment_status (canonical) and status (legacy fallback)
    const results = await Promise.all(
      CLAIM_TABLES.map((table) =>
        fat
          .from(table)
          .select('status, payment_status')
          .eq('claim_group_id', groupId)
      )
    )

    const allChildren = []
    for (const { data } of results) {
      if (data) allChildren.push(...data)
    }

    // calcParentStatus uses payment_status as canonical truth
    const newStatus = calcParentStatus(allChildren)

    await fat
      .from('claim_groups')
      .update({ parent_status: newStatus })
      .eq('id', groupId)
  }

  // ── Build grouped view ────────────────────────────────────────────────────
  // Returns an array of group objects, each with:
  //   { group, children: Claim[], derivedPaymentStatus, paidCount, totalCount }
  // Plus ungrouped claims (no claim_group_id) as flat items.
  //
  // CANONICAL TRUTH: derivedPaymentStatus is computed ONLY from subclaim.payment_status.
  // NULL payment_status children are treated as 'Pending' (not 'Legacy').
  // parent_status on the group object is a CACHED PROJECTION — use derivedPaymentStatus
  // for all display and filtering logic.
  //
  // derivedPaymentStatus:
  //   'Paid'    = ALL children have payment_status = 'Paid'
  //   'Pending' = any child has payment_status != 'Paid' (or NULL → Pending)
  //
  // paidCount / totalCount: for progress indicators (e.g. "2/3 paid")

  const groupedView = (() => {
    const grouped = []
    const ungrouped = []

    // Map group id → children
    const childrenByGroup = {}
    for (const claim of claims) {
      if (claim.claim_group_id) {
        if (!childrenByGroup[claim.claim_group_id]) childrenByGroup[claim.claim_group_id] = []
        childrenByGroup[claim.claim_group_id].push(claim)
      }
    }

    // Attach children to groups + derive normalized payment status
    for (const group of claimGroups) {
      const children = childrenByGroup[group.id] || []

      // NORMALIZED: derive payment status from payment_status only.
      // NULL payment_status → treated as Pending (no 'Legacy' escape hatch).
      // This is the ONLY canonical payment truth for grouped claims.
      const totalCount = children.length
      const paidCount  = children.filter(
        (c) => (c.payment_status || 'Pending').toLowerCase() === 'paid'
      ).length
      const derivedPaymentStatus =
        totalCount > 0 && paidCount === totalCount ? 'Paid'
        : paidCount > 0 ? 'Partially Paid'
        : 'Pending'

      grouped.push({ group, children, derivedPaymentStatus, paidCount, totalCount })
    }

    // Claims with no group (legacy or ungrouped)
    for (const claim of claims) {
      if (!claim.claim_group_id) {
        ungrouped.push(claim)
      }
    }

    return { grouped, ungrouped }
  })()

  return (
    <ClaimsContext.Provider value={{
      claims,
      claimGroups,
      groupedView,
      loading,
      error,
      loadClaims,
      addClaim,
      updateClaim,
      updateChildStatus,
      updatePaymentStatus,
    }}>
      {children}
    </ClaimsContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useClaims() {
  const ctx = useContext(ClaimsContext)
  if (!ctx) throw new Error('useClaims must be used inside <ClaimsProvider>')
  return ctx
}
