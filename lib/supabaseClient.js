import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('[supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars.')
}

// Default `supabase` client is used ONLY for auth (`supabase.auth.*` →
// `auth.users`, the single acceptable shared Supabase resource).
// All FAT-owned tables/RPCs (including the FAT-authoritative `profiles` table)
// live in the `fat` schema and are accessed via the `fat` helper below —
// see docs/FAT_SCHEMA_ARCHITECTURE.md.
//
// Requires `fat` to be in Supabase project's "Exposed schemas"
// (Dashboard → Project Settings → API → Exposed schemas).
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'public' },
})

// Schema-scoped client for FAT-owned tables. Use this for every FAT query:
//   fat.from('claim_groups').select(...)
//   fat.rpc('increment_claim_sequence', { ... })
export const fat = supabase.schema('fat')
