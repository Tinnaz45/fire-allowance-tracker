'use client'

// Profile Page
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, fat } from '@/lib/supabaseClient'
import AppShell from '@/components/nav/AppShell'
import {
  markAllDistancesStale,
  normaliseAddress,
  getHomeAddress,
  saveHomeAddress,
} from '@/lib/distance/addressCache'
import { displayLabelForStation, stationById } from '@/lib/distance/stationParser'
import AddressAutocomplete from '@/components/profile/AddressAutocomplete'
import PlatoonPicker from '@/components/profile/PlatoonPicker'
import TravelBaselineCard from '@/components/profile/TravelBaselineCard'
import { roundUpKm } from '@/lib/distance/travelFormat'

const S = {
  inner: { maxWidth: '560px', margin: '0 auto', padding: '32px 16px', boxSizing: 'border-box' },
  card: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '16px', padding: '24px', marginBottom: '20px' },
  cardTitle: { margin: '0 0 20px 0', fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb', borderBottom: '1px solid #2a2a2a', paddingBottom: '12px' },
  label: { display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' },
  input: { width: '100%', padding: '10px 12px', background: '#111', border: '1px solid #333', borderRadius: '8px', color: '#e5e7eb', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', background: '#111', border: '1px solid #333', borderRadius: '8px', color: '#e5e7eb', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box', cursor: 'pointer' },
  field: { marginBottom: '16px' },
  help: { marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' },
  stationBadge: { display: 'inline-block', padding: '4px 12px', background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: '6px', color: '#fca5a5', fontSize: '0.82rem', fontWeight: 700, letterSpacing: '0.04em', marginTop: '6px' },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  saveBtn: { width: '100%', padding: '12px', background: '#dc2626', border: 'none', borderRadius: '8px', color: 'white', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' },
  success: { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#4ade80', borderRadius: '10px', padding: '12px 16px', fontSize: '0.875rem', marginBottom: '16px' },
  error: { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', borderRadius: '8px', padding: '10px 14px', fontSize: '0.85rem', marginBottom: '16px' },
  note: { background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '8px', padding: '10px 14px', fontSize: '0.8rem', color: '#fbbf24', marginTop: '8px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', fontSize: '0.8rem', fontWeight: 500 },
  badge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', borderRadius: '50%', fontSize: '0.72rem', fontWeight: 700, flexShrink: 0 },
  badgeVerified: { background: 'rgba(34,197,94,0.18)', color: '#4ade80' },
  badgeWarn:     { background: 'rgba(251,191,36,0.18)', color: '#fbbf24' },
}

export default function ProfilePage() {
  const router = useRouter()
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [homeAddress, setHomeAddress] = useState('')
  const [originalHomeAddress, setOriginalHomeAddress] = useState('')
  // Verified-address state — populated either from fat.home_address on load,
  // or from the AddressAutocomplete onSelect callback. The hash is kept so the
  // UI can detect that the user has since edited the text away from the
  // verified canonical value (in which case `verified` falls to false).
  const [verifiedAddress, setVerifiedAddress] = useState(null)
  //   shape: { hash, lat, lng, geocodedAt }
  const [platoon, setPlatoon] = useState('')
  const [payNumber, setPayNumber] = useState('')
  const [stationId, setStationId] = useState('')
  const [stationName, setStationName] = useState('')
  const [homeDistKm, setHomeDistKm] = useState(null)
  const [stationSearch, setStationSearch] = useState('')
  const [stations, setStations] = useState([])
  const [showStationPicker, setShowStationPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [successMsg, setSuccessMsg] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return }
      setSession(data.session)
      setAuthLoading(false)
    })
  }, [router])

  useEffect(() => {
    if (!session) return
    const load = async () => {
      try {
        // Fetch identity, profile extension, stations, and home-address record
        // in parallel. Stations are the canonical source for bare station
        // names — `rostered_station_label` is a write-side denormalized cache
        // and is intentionally NOT read into state. This removes the
        // bare/composed dual-shape that caused the "FS42 - FS42 - Newport"
        // hydration bug; the in-memory shape is now strictly (station_id, bare name).
        const [profileResult, extResult, stationsResult, homeRec] = await Promise.all([
          fat.from('profiles')
             .select('first_name, last_name')
             .eq('id', session.user.id)
             .maybeSingle(),
          fat.from('profile_ext')
             .select('home_address, platoon, pay_number, station_id, home_dist_km')
             .eq('user_id', session.user.id)
             .maybeSingle(),
          fat.from('stations')
             .select('id, name, abbreviation')
             .eq('is_active', true)
             .order('id', { ascending: true }),
          getHomeAddress(session.user.id),
        ])

        const profile = profileResult.data
        const ext     = extResult.data
        const stns    = stationsResult.data || []

        setStations(stns)

        if (profile) {
          setFirstName(profile.first_name || '')
          setLastName(profile.last_name || '')
        }

        if (ext) {
          setHomeAddress(ext.home_address || '')
          setOriginalHomeAddress(ext.home_address || '')
          setPlatoon(ext.platoon || '')
          setPayNumber(ext.pay_number || '')
          const sid = ext.station_id ? String(ext.station_id) : ''
          setStationId(sid)
          // Derive bare station name from canonical fat.stations row keyed by
          // station_id. We deliberately never read rostered_station_label here
          // — even legacy poisoned rows (e.g. "FS42 - FS42 - Newport") become
          // invisible because the display path never consults that column.
          const matched = sid ? stns.find((s) => String(s.id) === sid) : null
          setStationName(matched?.name || '')
          setHomeDistKm(ext.home_dist_km != null ? Number(ext.home_dist_km) : null)
        }

        // Seed verified state from the existing geocoded home record if its
        // hash still matches the current profile address (i.e. the user has
        // not since edited the text manually).
        if (
          homeRec &&
          homeRec.geocode_status === 'ok' &&
          homeRec.lat != null &&
          homeRec.lng != null &&
          ext &&
          normaliseAddress(homeRec.address_text) === normaliseAddress(ext.home_address || '')
        ) {
          setVerifiedAddress({
            hash: homeRec.address_hash,
            lat:  Number(homeRec.lat),
            lng:  Number(homeRec.lng),
            geocodedAt: homeRec.geocoded_at || null,
          })
        }
      } catch (err) {
        setErrorMsg('Could not load profile. Please refresh.')
      }
    }
    load()
  }, [session])

  const filteredStations = stations.filter((s) => {
    if (!stationSearch) return true
    const q = stationSearch.toLowerCase()
    return String(s.id).includes(q) || (s.name || '').toLowerCase().includes(q) || (s.abbreviation || '').toLowerCase().includes(q)
  })

  const handleSave = async (e) => {
    e.preventDefault()
    setErrorMsg(null)
    setSuccessMsg(null)
    if (!homeAddress.trim()) { setErrorMsg('Home address is required for travel calculations.'); return }
    setSaving(true)
    try {
      // rostered_station_label is a write-only cache — hydration ignores it and
      // re-derives the label from fat.stations. We write the same human display
      // label the UI shows (fire → "FS45 - Brooklyn", non-fire → name only).
      const stationLabel =
        displayLabelForStation(stationById(stationId, stations) || { id: stationId, name: stationName })

      // fat.profiles is FAT-owned authoritative identity (mirrors mica.profiles).
      // email is NOT NULL and sourced from auth.users; include it on every
      // upsert so the INSERT side of ON CONFLICT stays auth-consistent.
      const { error: profileError } = await fat.from('profiles').upsert({
        id: session.user.id,
        email: session.user.email,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        // Canonical rostered station. The entitlement engine
        // (lib/fat/engine/context.js § buildEngineContext) reads
        // fat.profiles.rostered_station_id to resolve the excess-travel "from"
        // station; without it, excess-travel generation is suppressed. Kept in
        // lockstep with the prototype profile_ext.station_id written below so
        // both paths agree. Affects future claims only — historical claims keep
        // their own station_id_snapshot.
        rostered_station_id: stationId ? parseInt(stationId) : null,
      }, { onConflict: 'id' })
      if (profileError) throw profileError

      const { error: extError } = await fat.from('profile_ext').upsert({
        user_id:                session.user.id,
        home_address:           homeAddress.trim(),
        platoon:                platoon || null,
        station_id:             stationId ? parseInt(stationId) : null,
        rostered_station_label: stationLabel,
        pay_number:             payNumber.trim() || null,
      }, { onConflict: 'user_id' })
      if (extError) throw extError

      // If the user picked a verified suggestion AND that selection still
      // matches the text in the input, pre-populate fat.home_address with the
      // already-known coordinates. This means the recall-leg distance
      // estimator will cache-hit on its next call and skip the lazy Nominatim
      // geocode entirely (existing distance cache architecture is preserved —
      // see lib/distance/distanceEstimator.js ensureHomeRecord()).
      const trimmedHome = homeAddress.trim()
      const verifiedNow =
        verifiedAddress &&
        verifiedAddress.hash === normaliseAddress(trimmedHome) &&
        isFinite(verifiedAddress.lat) &&
        isFinite(verifiedAddress.lng)
      if (verifiedNow) {
        try {
          await saveHomeAddress(
            session.user.id,
            trimmedHome,
            verifiedAddress.lat,
            verifiedAddress.lng,
            'ok',
          )
        } catch (geoErr) {
          // Non-fatal: profile_ext save already succeeded, the lazy geocode
          // on next Recall claim will still work. Log for visibility.
          console.error('[profile] saveHomeAddress (verified) failed:', geoErr)
        }
      }

      const addressChanged =
        normaliseAddress(homeAddress) !== normaliseAddress(originalHomeAddress)
      if (addressChanged && originalHomeAddress) {
        await markAllDistancesStale(session.user.id, 'home_address_changed')
        setSuccessMsg('Profile saved. Station distances have been marked for re-confirmation on your next Recall claim.')
      } else {
        setSuccessMsg('Profile saved successfully.')
      }
      setOriginalHomeAddress(homeAddress)
      setTimeout(() => setSuccessMsg(null), 4000)
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save profile.')
    } finally {
      setSaving(false)
    }
  }

  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f0f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        Loading…
      </div>
    )
  }
  if (!session) return null

  const activeStationLabel = stationId
    ? (displayLabelForStation(stationById(stationId, stations) || { id: stationId, name: stationName }) || null)
    : null
  const validDistance = activeStationLabel && typeof homeDistKm === 'number' && Number.isFinite(homeDistKm) && homeDistKm > 0 ? homeDistKm : null

  return (
    <AppShell>
      <div style={S.inner}>
        <div style={{ marginBottom: '28px' }}>
          <h1 style={{ margin: '0 0 4px', fontSize: '1.35rem', fontWeight: 700, color: '#f9fafb' }}>Profile</h1>
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#6b7280' }}>{session.user.email}</p>
        </div>

        {successMsg && <div style={S.success}>&#10003; {successMsg}</div>}
        {errorMsg && <div style={S.error}>{errorMsg}</div>}

        <form onSubmit={handleSave} noValidate>
          <div style={S.card}>
            <h2 style={S.cardTitle}>Personal Details</h2>
            <div style={S.row}>
              <div style={S.field}>
                <label style={S.label}>First Name</label>
                <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Danny" style={S.input} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Last Name</label>
                <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Smith" style={S.input} />
              </div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Pay Number</label>
              <input type="text" value={payNumber} onChange={(e) => setPayNumber(e.target.value)} placeholder="e.g. 12345" style={S.input} />
              <p style={S.help}>Your employee number for payslip reconciliation.</p>
            </div>
          </div>

          <div style={S.card}>
            <h2 style={S.cardTitle}>Operational Details</h2>
            <div style={S.field}>
              <label style={S.label}>Rostered Station</label>
              {activeStationLabel && (
                <div style={S.stationBadge}>
                  {activeStationLabel}
                  {validDistance && (
                    <span style={{ marginLeft: '6px', fontWeight: 500, color: 'rgba(252,165,165,0.65)' }}>
                      ({roundUpKm(validDistance)} km / {roundUpKm(validDistance * 2)} km)
                    </span>
                  )}
                </div>
              )}
              <div style={{ marginTop: activeStationLabel ? '10px' : '0' }}>
                <input
                  type="text"
                  value={stationSearch}
                  onChange={(e) => { setStationSearch(e.target.value); setShowStationPicker(true) }}
                  onFocus={() => setShowStationPicker(true)}
                  placeholder="Search by number or name (e.g. 45 or Brooklyn)"
                  style={S.input}
                />
                {showStationPicker && stationSearch && (
                  <div style={{ background: '#111', border: '1px solid #333', borderRadius: '8px', marginTop: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                    {filteredStations.length === 0 ? (
                      <div style={{ padding: '12px', color: '#6b7280', fontSize: '0.85rem' }}>No stations found.</div>
                    ) : (
                      filteredStations.slice(0, 20).map((s) => (
                        <button key={s.id} type="button"
                          onClick={() => { setStationId(String(s.id)); setStationName(s.name); setStationSearch(''); setShowStationPicker(false) }}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid #1f1f1f', color: '#e5e7eb', fontSize: '0.875rem', cursor: 'pointer' }}>
                          {s.abbreviation
                            ? <><span style={{ fontWeight: 700, color: '#fca5a5' }}>{s.abbreviation}</span> &mdash; {s.name}</>
                            : s.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              {stationId && (
                <button type="button" onClick={() => { setStationId(''); setStationName(''); setStationSearch('') }}
                  style={{ marginTop: '6px', background: 'none', border: 'none', color: '#6b7280', fontSize: '0.78rem', cursor: 'pointer', padding: 0 }}>
                  Clear station
                </button>
              )}
              <p style={S.help}>You have one active rostered station. Recall claims will auto-suggest this.</p>
            </div>
            <div style={S.field}>
              <label style={S.label}>Platoon</label>
              <PlatoonPicker value={platoon} onChange={setPlatoon} />
            </div>
          </div>

          <div style={S.card}>
            <h2 style={S.cardTitle}>Home Address</h2>
            <div style={S.field}>
              <label style={S.label} htmlFor="home-address">Home Address</label>
              <AddressAutocomplete
                id="home-address"
                value={homeAddress}
                onChange={setHomeAddress}
                onSelect={(s) => {
                  setVerifiedAddress({
                    hash: normaliseAddress(s.label),
                    lat:  s.lat,
                    lng:  s.lng,
                    geocodedAt: new Date().toISOString(),
                  })
                }}
                onClearVerified={() => setVerifiedAddress(null)}
                verified={
                  !!verifiedAddress &&
                  verifiedAddress.hash === normaliseAddress(homeAddress || '')
                }
                placeholder="Start typing — 12 Smith St, Brunswick…"
              />
              {(() => {
                const trimmed = (homeAddress || '').trim()
                const isVerified =
                  !!verifiedAddress &&
                  verifiedAddress.hash === normaliseAddress(trimmed)
                if (isVerified) {
                  return (
                    <div style={{ ...S.statusRow, color: '#4ade80' }}>
                      <span style={{ ...S.badge, ...S.badgeVerified }}>&#10003;</span>
                      <span>
                        Address verified &middot; ready for distance calculations.
                      </span>
                    </div>
                  )
                }
                if (trimmed.length >= 3) {
                  return (
                    <div style={{ ...S.statusRow, color: '#fbbf24' }}>
                      <span style={{ ...S.badge, ...S.badgeWarn }}>!</span>
                      <span>
                        Please choose a suggested address for verified
                        distance calculations.
                      </span>
                    </div>
                  )
                }
                return null
              })()}
              <p style={S.help}>Used to calculate your home-to-station distance on Recall claims.</p>
              <div style={S.note}>Changing your address only affects future claims. Existing claims retain the address used at creation.</div>
            </div>
            <div style={{ marginTop: '4px', padding: '10px 14px', background: '#111', border: '1px solid #2a2a2a', borderRadius: '8px', fontSize: '0.8rem', color: '#6b7280' }}>
              Recall claims auto-estimate the home-to-station distance using OpenStreetMap. Picking a verified address here speeds up that calculation and avoids re-geocoding. You can still accept, override, or recalculate on each claim.
            </div>
          </div>

          <TravelBaselineCard
            userId={session.user.id}
            station={stationId ? { id: parseInt(stationId), name: stationName } : null}
            homeAddress={homeAddress}
            profileLoading={false}
          />

          <button type="submit" disabled={saving} style={{ ...S.saveBtn, background: saving ? '#7f1d1d' : '#dc2626', cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Saving…' : 'Save Profile'}
          </button>
        </form>
      </div>
    </AppShell>
  )
}
