# Fire Allowance Tracker

A mobile-first web app for tracking fire allowance claims across Recalls, Retain, Standby/M&D, and Spoilt/Delayed meals. Built with Next.js 15 and Supabase.

---

## Quick setup (estimated time: 20 minutes)

### Step 1 — Set up Supabase (free)

1. Go to https://supabase.com and create a free account.
2. Click **New project**, give it a name (e.g. `fire-allowance-tracker`), set a database password, choose a region (Australia - Sydney if available).
3. Wait ~2 minutes for your project to spin up.
4. Go to the **SQL Editor** (left sidebar).
5. Paste the entire contents of `supabase/fat-schema.sql` and click **Run**.
   - This creates the `fat` schema, all FAT-owned tables, the
     `fat.increment_claim_sequence` RPC, and per-user RLS policies.
6. Go to **Settings → API → Exposed schemas** and add `fat` alongside `public`.
   See [docs/FAT_SCHEMA_ARCHITECTURE.md](docs/FAT_SCHEMA_ARCHITECTURE.md).
7. Copy your **Project URL** and **anon public** key — you'll need these next.

---

### Step 2 — Configure the app

1. In this project folder, duplicate `.env.example` and rename it `.env.local`.
2. Fill in your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

---

### Step 3 — Run locally

Make sure you have Node.js installed (v18+). Then:

```bash
npm install
npm run dev
```

The app opens at http://localhost:3001. Create an account, fill in your profile, and start adding claims.

---

### Step 4 — Deploy (so you can use it on your phone)

The easiest free option is **Vercel**:

1. Push this folder to a GitHub repository.
2. Go to https://vercel.com, sign in with GitHub, click **New Project**, and import your repo.
3. In the project settings, add your environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Click **Deploy**. Vercel gives you a URL like `https://fire-allowance-tracker.vercel.app`.

---

### Step 5 — Add to iPhone home screen

1. Open Safari on your iPhone.
2. Go to your Vercel URL.
3. Tap the **Share** button (box with arrow up).
4. Scroll down and tap **Add to Home Screen**.
5. Name it "Allowance" and tap **Add**.

---

## Each team member's setup

Each person:
1. Opens the app URL in Safari on their iPhone.
2. Adds it to their home screen.
3. Signs up with their work email.
4. Fills in their profile (name, home station, platoon, home distance).

Everyone's data is completely separate — each person only ever sees their own claims.

---

## Allowance rates

Rates are managed in the database / Supabase. Update them in the relevant config when rates change.

| Allowance | Rate |
|---|---|
| Km rate | $0.43/km |
| Day mealie | $17.85 |
| Night mealie | $22.40 |
| Retain (day) | $28.50 |
| Retain (night) | $42.70 |
| Spoilt/delayed meal | $22.80 |

---

## Project structure

```
fire-allowance-tracker/
├── next-app/                   # Legacy staging folder (no longer used)
├── app/                        # Next.js App Router pages
├── lib/                        # Supabase client, utilities
├── public/                     # Static assets (if present)
├── supabase/fat-schema.sql     # Authoritative DDL for the `fat` schema
├── vercel.json                 # Vercel deployment config
├── package.json                # Next.js 15 dependencies
├── .env.example                # Copy to .env.local and add your keys
└── next.config.js              # Next.js configuration
```

---

## Development workflow

- All work happens on the `dev` branch — never commit directly to `main`
- After changes: run `npm run build` and fix any errors
- Only merge `dev → main` when the build is clean
- Full workflow details: see [docs/WORKFLOW.md](docs/WORKFLOW.md)

---

## Deployment Workflow

| Branch | Purpose |
|---|---|
| `dev` | Development and testing — all features land here first |
| `main` | Production — only receives changes via pull request from `dev` |

**Process:**

1. All features and fixes are committed to `dev`
2. Push `dev` to trigger a Vercel preview deployment
3. Test the Vercel preview URL thoroughly
4. Only after verification: open a pull request from `dev` → `main`
5. Merge to `main` triggers the production Vercel deployment

**Never push directly to `main`.** Direct pushes are blocked by branch protection.

---

## Future features to add

- Push notifications when a claim is approaching a deadline
- Export to PDF / CSV for payslip reconciliation
- Pay period summary view (group claims by pay number)
- Photo attachment for receipts
- Offline support (service worker caching)
