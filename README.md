# Statement Ops

**Music business statement operations system — master and publishing.**

Internal admin tool for preparing, reconciling, approving, and tracking royalty statement runs. Built with Next.js 14, TypeScript, Tailwind CSS, and Supabase.

Deployable on **Netlify** with zero platform lock-in. No Vercel-specific services used.

---

## Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Database | Supabase (Postgres + RLS) |
| Auth | Supabase Auth |
| Storage | Supabase Storage (for output files, optional) |
| Deployment | Netlify + `@netlify/plugin-nextjs` |
| Excel/CSV | `xlsx` + `papaparse` (client-side) |
| Charts | `recharts` |

---

## Local Setup

### 1. Clone and install

```bash
git clone <repo>
cd statement-ops
npm install
```

### 2. Create Supabase project

Go to [supabase.com](https://supabase.com) and create a new project.

### 3. Run migrations

In your Supabase project → **SQL Editor**, paste and run:

1. `supabase/migrations/001_schema.sql` — full schema, RLS policies
2. `supabase/migrations/002_seed.sql` — demo data

### 4. Configure environment variables

Copy `.env.local.example` to `.env.local` and fill in:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Find these in Supabase → **Settings → API**.

### 5. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Netlify Deployment

### 1. Push to Git

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Connect to Netlify

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import from Git**
2. Select your repository
3. Build settings are in `netlify.toml` — no manual config needed:
   - Build command: `npm run build`
   - Publish directory: `.next`
4. The `@netlify/plugin-nextjs` plugin is declared in `netlify.toml` and handles SSR automatically

### 3. Set environment variables in Netlify

In Netlify → **Site settings → Environment variables**, add:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### 4. Deploy

Netlify will auto-deploy on every push to `main`.

---

## Core Business Rules

### Domains

Master and publishing are **always separate**. They never combine into one statement output. All pages, runs, filters, and outputs are domain-scoped.

### Statement periods

H1 (Jan–Jun) and H2 (Jul–Dec) only. One statement record per payee per domain per period (enforced by unique constraint).

### Balance chain

Every statement record must follow this chain exactly:

```
opening_balance
+ current_earnings
- deductions
= closing_balance_pre_carryover

+ prior_period_carryover_applied
= final_balance_after_carryover

→ apply carryover/threshold rule
→ payable_amount  OR  carry_forward_amount
```

The chain is validated programmatically in `src/lib/utils/balanceEngine.ts`. Any inconsistency is flagged in the Reconciliation page.

### Carryover rule

Default threshold: **£100** (or per-contract override via `minimum_payment_threshold_override`).

- If `|final_balance_after_carryover| < threshold` → `payable_amount = 0`, balance carries to next period
- If balance is negative (recouping) → `payable_amount = 0`
- If `hold_payment_flag = true` (contract or statement) → `payable_amount = 0`
- Otherwise → `payable_amount = final_balance_after_carryover`

Carryover must be **manually confirmed** (`carryover_confirmed_flag`) before a statement can be approved.

### Manual overrides

If `manual_override_flag = true` on a statement record:
- The record is **never silently overwritten** by re-generation
- A warning is displayed in the UI
- Any action requires explicit confirmation
- `override_notes` and `override_by` are required

### Approval workflow

Three stages: `prepared → checked → approved`

All must complete before a statement can be issued. Each stage is logged to `approval_log` with timestamp and name.

### Ready-to-issue checklist

A statement is only ready to issue when ALL are true:

- [ ] Payee exists and is active
- [ ] Statement period assigned
- [ ] Domain is valid
- [ ] No unresolved critical exceptions
- [ ] `balance_confirmed_flag = true`
- [ ] `carryover_confirmed_flag = true`
- [ ] `output_generated_flag = true`
- [ ] `approval_status = approved`
- [ ] If payable: `primary_email` exists on payee

---

## Pages

| Page | Path | Purpose |
|---|---|---|
| Dashboard | `/` | Period overview, stats, open exceptions |
| Payees | `/payees` | List, create, edit payees |
| Payee Detail | `/payees/[id]` | Contracts, statement history, repertoire |
| Repertoire | `/repertoire` | Tracks/releases/works catalogue |
| Imports | `/imports` | Upload CSVs, map columns, preview, save |
| Master Run | `/statement-run?domain=master` | Full master statement run page |
| Publishing Run | `/statement-run?domain=publishing` | Full publishing statement run page |
| Statements | `/statements` | All statement records with filters |
| Statement Detail | `/statements/[id]` | Balance, approval, output, email |
| Reconciliation | `/reconciliation` | Balance chain validation, period comparison |
| Exceptions | `/exceptions` | Grouped exceptions with resolve/dismiss |
| Email Prep | `/email-prep` | Prepare emails, mark sent |

---

## Import Types

| Type | Description |
|---|---|
| `eddy` | Eddy platform export (auto-mapped columns) |
| `publishing_csv` | In-house publishing spreadsheet |
| `sony_balance` | Sony-derived balance data (CSV) |
| `manual_balance` | Manually pasted balance rows |
| `catalogue` | Repertoire / catalogue import |

### Eddy import

Eddy column headers are auto-detected and mapped. The full Eddy field set is supported including royalty rate, payee split, reserved amounts, threshold steps, etc.

### Import flow

1. Upload CSV
2. Select domain, type, period
3. Map columns (auto-mapped for Eddy)
4. Preview — see matched/unmatched rows
5. Save — rows inserted to `import_rows`, matching runs against payees/contracts/repertoire
6. Unmatched rows → Exceptions automatically

---

## Output Generation

All output generation is **client-side** — no server-side file generation.

| Format | Method |
|---|---|
| Excel (.xlsx) | `xlsx` library, dynamic import |
| CSV | Native browser Blob + download |
| Printable HTML | Opens in new tab → browser Print → Save as PDF |
| Run Register | Excel via `xlsx` |

---

## Key Files

```
src/
  lib/
    supabase/client.ts          — Supabase client (browser + server)
    types/index.ts              — All TypeScript types
    utils/
      balanceEngine.ts          — Balance chain, carryover rule, ready-to-issue check
      matchingEngine.ts         — Import row matching against payees/contracts/repertoire
      exceptionEngine.ts        — Exception auto-generation
      outputGenerator.ts        — Excel, CSV, HTML output generation
  components/
    layout/Sidebar.tsx          — Navigation sidebar
    ui/index.tsx                — Shared UI components (badges, cards, etc.)
  app/
    page.tsx                    — Dashboard
    payees/page.tsx             — Payees list
    payees/[id]/page.tsx        — Payee detail
    repertoire/page.tsx         — Repertoire
    imports/page.tsx            — Import wizard + history
    statement-run/page.tsx      — Statement run (key operational page)
    statements/page.tsx         — Statements list
    statements/[id]/page.tsx    — Statement detail
    reconciliation/page.tsx     — Reconciliation
    exceptions/page.tsx         — Exceptions
    email-prep/page.tsx         — Email prep + send tracking
supabase/
  migrations/
    001_schema.sql              — Full schema
    002_seed.sql                — Demo seed data
```

---

## Statement Run Workflow

The recommended workflow for each statement period:

1. **Upload imports** — `/imports` — upload Eddy export, publishing CSV, Sony data
2. **Review unmatched rows** — `/exceptions` — resolve or exclude
3. **Go to Statement Run** — `/statement-run?domain=master` (or publishing)
4. **Generate statement records** — from matched import rows
5. **Apply carryover rule** — threshold check runs on all records
6. **Run validations** — auto-creates exceptions for missing emails, missing outputs, etc.
7. **Review each statement** — `/statements/[id]` — confirm balance, confirm carryover
8. **Approve** — checked → approved (requires named approver)
9. **Generate output** — Excel/CSV/HTML per statement
10. **Email prep** — `/email-prep` — prepare email copy, mark as sent
11. **Export run register** — full period summary as Excel

---

## Carryover Ledger

The `carryover_ledger` table tracks all carryover movements period-over-period. When a balance is below threshold in period X, a ledger entry is created linking period X → period X+1. This feeds `prior_period_carryover_applied` in the next period's calculation.

---

## Notes

- All financial amounts stored to 2dp (numeric(15,2))
- Currency is stored per-payee and per-contract — multi-currency is supported in data but not auto-converted
- The app is designed as a single-team internal tool — RLS policies grant full access to authenticated users
- For production use, add role-based RLS policies (preparer / approver / read-only)
- No actual email sending in Phase 1 — Email Prep page handles draft + sent tracking only
