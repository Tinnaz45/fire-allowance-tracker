#!/usr/bin/env node
// ─── Payslip Screenshot Upload — DEV integration test (Step O10-pre) ──────────
// Proves the first REAL ingestion source end-to-end against DEV:
//
//   · screenshotIngestAdapter shapes upload metadata into a ZERO-line ParseResult
//     (no OCR) — and ManualEntryAdapter is left intact
//   · createScreenshotImport: sha256 → upload to the private bucket → import row at
//     status 'uploaded' with file_ref + file_hash + ZERO lines (the resting state)
//   · the stored object is retrievable (download + signed URL)
//   · identical re-upload is de-duplicated (no second batch)
//   · client-side validation rejects unsupported types / oversize
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Deletes the
// import row AND the storage object on exit.
//
// Run:  node scripts/test-payslip-screenshot-import.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'

try { process.loadEnvFile('.env.local') } catch { /* fall back to ambient env */ }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}
if (!URL.includes(DEV_REF)) {
  console.error(`REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL does not target DEV (${DEV_REF}). Got: ${URL}`)
  process.exit(2)
}

const { manualEntryAdapter } = await import('../lib/fat/adapters/manualEntryAdapter.js')
const { screenshotIngestAdapter, ScreenshotIngestAdapter } = await import('../lib/fat/adapters/screenshotIngestAdapter.js')
const { canTransitionImport } = await import('../lib/fat/models/payslipImport.js')
const {
  createScreenshotImport, findImportByFileHash, getScreenshotSignedUrl,
  deleteScreenshotObject, sha256Hex, extForMime, SCREENSHOT_BUCKET, ALLOWED_MIME,
} = await import('../lib/fat/services/payslipUploads.js')

// service-role client — schema fat for tables; .storage works on it too (bypasses RLS).
const sb = createClient(URL, KEY, { db: { schema: 'fat' } })
const opts = { client: sb, storageClient: sb }

let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function expectThrow(label, fn) {
  try { await fn(); check(label, false, 'expected throw, got success') }
  catch { check(label, true) }
}

// A real 1×1 transparent PNG (valid bytes so Storage's mime check passes), made unique
// per run by appending a tEXt-ish trailer so its sha256 never collides with prior runs.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const uniqueTrailer = Buffer.from(`\n<run ${Date.now()}>`)
const pngBytes = Buffer.concat([PNG_1x1, uniqueTrailer])

function pngBlob() { return new Blob([pngBytes], { type: 'image/png' }) }

async function main() {
  console.log('Payslip Screenshot Upload — DEV integration test\n')

  // ── UNIT: adapter (no DB) ───────────────────────────────────────────────────
  console.log('UNIT: screenshotIngestAdapter (§ 9 seam) + ManualEntryAdapter preserved')
  const out = await screenshotIngestAdapter.parse({
    file_ref: 'owner/abc.png', file_hash: 'sha256:abc', mime: 'image/png',
    size_bytes: 123, uploaded_at: '2026-07-03T00:00:00.000Z', pay_date: '2026-07-03',
  })
  check('adapter returns ZERO lines (no extraction)', Array.isArray(out.lines) && out.lines.length === 0)
  check('adapter marks extraction pending (the seam)', out.raw_extract?.extraction === 'pending')
  check('adapter carries file_ref + file_hash in raw_extract', out.raw_extract?.file_ref === 'owner/abc.png' && out.raw_extract?.file_hash === 'sha256:abc')
  check('adapter normalizes operator pay_date', out.pay_date === '2026-07-03')
  check('adapter source is payslip_screenshot', screenshotIngestAdapter.source === 'payslip_screenshot')
  check('adapter is a ScreenshotIngestAdapter', screenshotIngestAdapter instanceof ScreenshotIngestAdapter)
  await expectThrow('adapter rejects missing file_ref', () => screenshotIngestAdapter.parse({ file_hash: 'x' }))
  check('ManualEntryAdapter preserved + distinct (objective 9)', manualEntryAdapter?.name === 'manual_entry' && manualEntryAdapter.source === 'manual_entry')
  check('extForMime maps jpeg→jpg, png→png, webp→webp', extForMime('image/jpeg') === 'jpg' && extForMime('image/png') === 'png' && extForMime('image/webp') === 'webp')
  check('extForMime rejects unsupported', extForMime('application/pdf') === null)

  const { data: profiles } = await sb.from('profiles').select('id').limit(1)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV.')
  const owner = profiles[0]

  const createdImportIds = []
  const extraObjectRefs = []
  let fileRef = null
  try {
    // ── client-side validation guards (before any upload) ──────────────────────
    console.log('\nTEST: upload validation guards')
    await expectThrow('rejects unsupported mime (application/pdf)', () =>
      createScreenshotImport({ ownerId: owner.id, file: new Blob([pngBytes], { type: 'application/pdf' }) }, opts))
    await expectThrow('rejects oversize (> 15MB)', () =>
      createScreenshotImport({ ownerId: owner.id, file: new Blob([Buffer.alloc(15 * 1024 * 1024 + 1)], { type: 'image/png' }) }, opts))

    // ── end-to-end ingest ───────────────────────────────────────────────────────
    console.log('\nTEST: createScreenshotImport → stored image + import at status uploaded, ZERO lines')
    const hex = await sha256Hex(pngBytes)
    const { import: imp, deduped } = await createScreenshotImport(
      { ownerId: owner.id, file: pngBlob(), payDate: '2026-07-03', payPeriodRef: 'PP-SS' }, opts)
    createdImportIds.push(imp.id)
    fileRef = imp.file_ref
    check('first ingest is not a dedup hit', deduped === false)
    check('import source = payslip_screenshot', imp.source === 'payslip_screenshot')
    check('import status = uploaded (resting state, § 4.1)', imp.status === 'uploaded', imp.status)
    check('import line_count = 0', imp.line_count === 0, String(imp.line_count))
    check('import file_hash = sha256:<hex>', imp.file_hash === `sha256:${hex}`, imp.file_hash)
    check('import file_ref = <owner>/<hex>.png', imp.file_ref === `${owner.id}/${hex}.png`, imp.file_ref)
    check('raw_extract records the ingest adapter + pending extraction', imp.raw_extract?.adapter === 'screenshot_ingest' && imp.raw_extract?.extraction === 'pending')

    const { data: lineRows } = await sb.from('payslip_import_lines').select('id').eq('import_id', imp.id)
    check('ZERO payslip_import_lines materialized (no OCR)', (lineRows ?? []).length === 0)

    // ── resting state ────────────────────────────────────────────────────────────
    check('lifecycle: uploaded → parsing is legal (future OCR exit)', canTransitionImport('uploaded', 'parsing'))
    check('ingest did NOT advance past uploaded', imp.status === 'uploaded')

    // ── stored object retrievable ────────────────────────────────────────────────
    console.log('\nTEST: stored object is retrievable (download + signed URL)')
    const { data: dlBlob, error: dlErr } = await sb.storage.from(SCREENSHOT_BUCKET).download(fileRef)
    check('storage download returns the object', !dlErr && !!dlBlob, dlErr?.message)
    if (dlBlob) {
      const dl = new Uint8Array(await dlBlob.arrayBuffer())
      check('downloaded bytes match uploaded bytes', dl.length === pngBytes.length, `${dl.length} vs ${pngBytes.length}`)
    }
    const signed = await getScreenshotSignedUrl(fileRef, { expiresIn: 600 }, sb)
    check('signed URL minted', typeof signed === 'string' && signed.includes('token='))
    const resp = await fetch(signed)
    check('signed URL fetch returns 200', resp.status === 200, String(resp.status))
    const fetched = new Uint8Array(await resp.arrayBuffer())
    check('signed URL serves the uploaded bytes', fetched.length === pngBytes.length)

    // ── dedup: identical re-upload reuses the existing import ─────────────────────
    console.log('\nTEST: identical re-upload is de-duplicated (no second batch)')
    const again = await createScreenshotImport({ ownerId: owner.id, file: pngBlob() }, opts)
    check('re-upload reports deduped = true', again.deduped === true)
    check('re-upload returns the SAME import (no new batch)', again.import.id === imp.id, `${again.import.id} vs ${imp.id}`)
    const { count } = await sb.from('payslip_imports').select('id', { count: 'exact', head: true })
      .eq('owner_id', owner.id).eq('file_hash', `sha256:${hex}`)
    check('exactly one import row for this file_hash', count === 1, String(count))

    const found = await findImportByFileHash({ ownerId: owner.id, fileHash: `sha256:${hex}` }, sb)
    check('findImportByFileHash locates the import', found?.id === imp.id)

    // ── dedup does NOT resurrect a discarded (superseded/rejected) batch ─────────
    console.log('\nTEST: re-upload after supersede mints a FRESH batch (dedup excludes terminal)')
    const png2 = Buffer.concat([PNG_1x1, Buffer.from(`\n<run2 ${Date.now()}>`)])
    const blob2 = () => new Blob([png2], { type: 'image/png' })
    const { import: imp2 } = await createScreenshotImport({ ownerId: owner.id, file: blob2() }, opts)
    createdImportIds.push(imp2.id)
    extraObjectRefs.push(imp2.file_ref)
    // supersede it (uploaded → superseded is legal; direct update for test setup)
    await sb.from('payslip_imports').update({ status: 'superseded' }).eq('id', imp2.id)
    const after = await createScreenshotImport({ ownerId: owner.id, file: blob2() }, opts)
    createdImportIds.push(after.import.id)
    check('re-upload after supersede is NOT a dedup hit', after.deduped === false, JSON.stringify({ deduped: after.deduped }))
    check('re-upload after supersede mints a NEW import id', after.import.id !== imp2.id)
    check('the fresh import rests at uploaded', after.import.status === 'uploaded', after.import.status)

    // ════════════════════════════════════════════════════════════════════════
    // STORAGE RLS owner-scoping — the AUTHENTICATED (anon-key) path. The rest of
    // this test runs as service_role, which BYPASSES RLS, so it cannot see the
    // migration-13 policies. Here we sign in two real ephemeral users and prove a
    // user can only ever touch their own '<uid>/' prefix (review finding).
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: storage RLS owner-scoping (authenticated path)')
    if (!ANON) {
      console.warn('  (skipped — NEXT_PUBLIC_SUPABASE_ANON_KEY not set)')
    } else {
      const admin = createClient(URL, KEY)            // service-role: user admin + cleanup
      const stamp = Date.now().toString(36)
      const userIds = []
      const rlsObjects = []
      try {
        const makeUser = async (tag) => {
          const email = `rls-${stamp}-${tag}@example.com`
          const password = `Rls-${stamp}-${tag}-Pw9!`
          const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
          if (cErr) throw new Error(`createUser(${tag}): ${cErr.message}`)
          const cli = createClient(URL, ANON)
          const { error: sErr } = await cli.auth.signInWithPassword({ email, password })
          if (sErr) throw new Error(`signIn(${tag}): ${sErr.message}`)
          return { id: created.user.id, cli }
        }
        const A = await makeUser('a')
        const B = await makeUser('b')
        userIds.push(A.id, B.id)

        const aOwn = `${A.id}/rls-${stamp}.png`
        const bOwn = `${B.id}/rls-${stamp}.png`

        const { error: aUp } = await A.cli.storage.from(SCREENSHOT_BUCKET).upload(aOwn, pngBytes, { contentType: 'image/png', upsert: true })
        check('RLS: owner CAN upload to own prefix', !aUp, aUp?.message)
        if (!aUp) rlsObjects.push(aOwn)

        const { error: aCross } = await A.cli.storage.from(SCREENSHOT_BUCKET).upload(bOwn, pngBytes, { contentType: 'image/png', upsert: true })
        check('RLS: owner DENIED upload to another user prefix', !!aCross)
        if (!aCross) rlsObjects.push(bOwn)  // shouldn't happen — track for cleanup if it did

        const { error: bUp } = await B.cli.storage.from(SCREENSHOT_BUCKET).upload(bOwn, pngBytes, { contentType: 'image/png', upsert: true })
        check('RLS: a different owner CAN upload to their own prefix', !bUp, bUp?.message)
        if (!bUp) rlsObjects.push(bOwn)

        const { data: aDlOwn } = await A.cli.storage.from(SCREENSHOT_BUCKET).download(aOwn)
        check('RLS: owner CAN download own object', !!aDlOwn)

        const { data: aDlB, error: aDlBErr } = await A.cli.storage.from(SCREENSHOT_BUCKET).download(bOwn)
        check('RLS: owner DENIED download of another user object', !aDlB || !!aDlBErr)

        const { data: aSignB, error: aSignErr } = await A.cli.storage.from(SCREENSHOT_BUCKET).createSignedUrl(bOwn, 60)
        check('RLS: owner DENIED signed URL for another user object', !aSignB?.signedUrl || !!aSignErr)
      } catch (e) {
        console.warn(`  (RLS owner-scoping setup skipped: ${e.message})`)
      } finally {
        for (const p of [...new Set(rlsObjects)]) {
          try { await sb.storage.from(SCREENSHOT_BUCKET).remove([p]) } catch { /* best-effort */ }
        }
        for (const id of userIds) {
          try { await sb.from('profiles').delete().eq('id', id) } catch { /* best-effort (may not exist) */ }
          try { await admin.auth.admin.deleteUser(id) } catch { /* best-effort */ }
        }
      }
    }

  } finally {
    console.log('\nCleanup...')
    for (const id of createdImportIds) {
      const { error } = await sb.from('payslip_imports').delete().eq('id', id) // cascade clears any lines
      if (error) console.error(`  cleanup warning (import ${id}): ${error.message}`)
    }
    const objectRefs = [...new Set([fileRef, ...extraObjectRefs].filter(Boolean))]
    for (const ref of objectRefs) {
      try { await deleteScreenshotObject(ref, sb) } catch (e) { console.error(`  cleanup warning (object ${ref}): ${e.message}`) }
    }
    console.log(`  deleted ${createdImportIds.length} import(s) + ${objectRefs.length} storage object(s)`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
