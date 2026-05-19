-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — fat.profiles (authoritative FAT identity)
--
-- This script reverses the `fat_profiles_authoritative` migration. Apply it
-- only if the runtime change to fat.profiles cannot be unshipped via a code
-- revert.
--
-- SAFE TO REPLAY: every statement is idempotent.
--
-- NOTE: this does NOT touch public.profiles, public.handle_new_user(), or
-- any MICA object. It only removes FAT-owned additions.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Stop new auth.users rows from seeding fat.profiles.
drop trigger if exists on_auth_user_created_fat on auth.users;

-- 2. Drop the SECURITY DEFINER seeding function.
drop function if exists fat.handle_new_user();

-- 3. Drop the table (cascade removes the trigger + policy automatically).
drop table if exists fat.profiles cascade;

-- 4. Verify state.
select 'fat.profiles dropped'         as check,
       not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='fat' and c.relname='profiles') as result
union all
select 'fat trigger removed',
       not exists(select 1 from pg_trigger where tgname='on_auth_user_created_fat')
union all
select 'MICA trigger still intact',
       exists(select 1 from pg_trigger where tgname='on_auth_user_created_mica')
union all
select 'public.profiles still intact',
       exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relname='profiles');
