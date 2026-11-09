# Staging environment runbook

The live Mini App has real users, so `main` + production services are release-only. Day-to-day work happens against a fully separate staging stack:

- **`dev` branch** → `vercel deploy` (preview) → **staging Supabase** (`timor-shop-staging`) → **staging R2 buckets** → **test Telegram bot**
- **`main` branch** → `vercel deploy --prod` → prod Supabase (`mzdprnvazllhfaxteeyk`) → prod R2 → prod bot

Nothing in staging shares state with production: separate database, storage buckets, edge functions, bot, and Vercel env vars.

## What exists

| Piece | Production | Staging |
|-------|-----------|---------|
| Git branch | `main` | `dev` |
| Supabase project | `SchoolShop` (`mzdprnvazllhfaxteeyk`) | `timor-shop-staging` (`bszipcuuxqxrhsexdevi`) |
| Vercel env vars | `EXPO_PUBLIC_*` scoped **Production** | same keys scoped **Preview** (staging values) |
| App URL | `https://shop.timor.et` | `https://timor-shop-staging.vercel.app` (alias → latest preview deploy) |
| Edge functions | all six deployed | all six deployed to staging |
| R2 buckets | `timor-shop-images` / `timor-shop-proofs` | `timor-shop-images-staging` / `timor-shop-proofs-staging` |
| Telegram bot | prod bot | `@timorshop_test_bot` |

Staging credentials (DB password, service role key, generated function secrets) live in **`.env.staging`** at the repo root — gitignored, never committed.

## Daily workflow

1. Work on `dev` (or a feature branch off it). `main` is only updated by merge when a change has passed on staging.
2. **Preview deploy:** `npm run deploy:staging` (wraps `vercel deploy`, never `--prod`, then re-points the staging alias). Vercel builds server-side with the **Preview** env vars, so the bundle points at staging Supabase. If the CLI suddenly fails with `Error: Not authorized` while the API token still works, re-run with the CLI's stored token injected: `VERCEL_TOKEN=$(node -e "const a=require(process.env.APPDATA+'/com.vercel.cli/Data/auth.json'); process.stdout.write(a.token||'')") npm run deploy:staging`; if the token itself is expired, `vercel login` again. When `github.com:443` is connection-reset from the dev machine (intermittent), push over SSH instead: `git push git@github.com:llhdev/SchoolShop.git dev` (SSH key already authenticates).
3. Test on the preview URL or in the test bot's Mini App.
4. **Release:** apply any new migrations to prod first (`supabase db push` while linked to prod — always confirm `supabase/.temp/project-ref` says `mzdprnvazllhfaxteeyk` before pushing), then merge `dev` → `main` and `vercel deploy --prod`.

## Migration discipline

- New migrations are written against staging, applied there (`supabase db push --db-url "<staging pooler URL>"` or temporarily `supabase link --project-ref bszipcuuxqxrhsexdevi`), tested, then replayed on prod at release time — never the reverse.
- If staging and prod schemas drift, reset staging: it's disposable. **Never** copy real user data (phones, payment proofs) into staging.
- **Data backfills ship inside migrations.** Example: `045_staff_roles_branches.sql` rewrites the order lifecycle (`paid` → `received` backfill on `orders.status` and `item_statuses`, owner capability backfill on `profiles`). Replaying it on prod migrates live orders automatically — apply it to prod *before* deploying the client that expects the new statuses.

## Staging-only divergence (keep in mind)

- Migration `040` hardcodes the prod functions URL as a fallback in `trigger_verify_order_payment()` / `request_payment_verification()`. On the staging DB both functions were replaced (`CREATE OR REPLACE FUNCTION`) with the staging URL `https://bszipcuuxqxrhsexdevi.supabase.co/functions/v1` as the fallback. The migration file itself is unchanged; re-running migration 040 on staging would re-point the triggers at prod — don't.
- The vault secret `verify_function_secret`, `VERIFY_FUNCTION_SECRET`, and `VERIFY_ET_WEBHOOK_SECRET` are freshly generated staging values, different from prod.
- `TELEGRAM_BOT_TOKEN` on staging is the test bot's token — never the prod token.
- **`PUBLISHABLE_KEY` deliberately holds the legacy anon JWT on staging.** New Supabase projects auto-set the edge-function env `SUPABASE_ANON_KEY` to the `sb_publishable_…` key (verified via `supabase secrets list` digests), while older projects like prod auto-set it to the legacy anon JWT. The client sends `Bearer <legacy anon JWT>` (`EXPO_PUBLIC_SUPABASE_ANON_KEY`), so `telegram-order-notify`'s auth gate 401'd every notification on staging until `PUBLISHABLE_KEY` was set to the legacy JWT — now the gate accepts both keys, mirroring prod. Symptom was: order placed fine, no Telegram message, `[telegramOrderNotify] notify failed: HTTP 401` in devtools.

## One-time setup steps performed (for reproducibility)

1. `supabase projects create timor-shop-staging --org-id <org> --region ap-southeast-2`
2. Applied migrations 001–044: `supabase db push --db-url "postgresql://postgres.bszipcuuxqxrhsexdevi:<password>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"` (direct `db.<ref>.supabase.co` is IPv6-only; the pooler works everywhere).
3. Created the super admin via SQL (Auth API was unreachable from the dev machine): insert into `auth.users` + `auth.identities` with `email_confirmed_at = now()`, then `UPDATE profiles SET role='super_admin', username='santa2024'`. Equivalent to `node scripts/setup-admin.js`.
4. Deployed functions: `supabase functions deploy telegram-auth telegram-order-notify verify-order-payment verify-payment-reference verify-et-webhook r2-upload-sign --project-ref bszipcuuxqxrhsexdevi --use-api`.
5. Set staging secrets: `supabase secrets set --project-ref bszipcuuxqxrhsexdevi VERIFY_FUNCTION_SECRET=… VERIFY_ET_WEBHOOK_SECRET=… PUBLISHABLE_KEY=…` plus the vault secret `SELECT vault.create_secret('<same>', 'verify_function_secret')`.
6. Added Vercel **Preview** env vars via the Vercel API (`POST /v10/projects/<id>/env` with `target:["preview"]`) — the CLI's `vercel env add` branch prompt is unusable non-interactively.
7. Disabled **Vercel Authentication** on the project (`PATCH /v9/projects/<id>` with `{"ssoProtection": null}`). It was set to `all_except_custom_domains`, which is why `shop.timor.et` worked but every `*.vercel.app` URL — including the staging Mini App — showed a "Log in to Vercel" wall inside the Telegram WebView. Previews are now publicly accessible (fine for a public shop app; the staging DB is isolated). Note: the Vercel CLI rotates its OAuth token in `auth.json` — always re-read it immediately before an API call.

## Remaining manual steps (require your accounts)

1. **Email auto-confirm** (needed for tenant creation on staging): Supabase Dashboard → staging project → Authentication → Providers → Email → disable "Confirm email". One click; the CLI can't set hosted auth config.
2. **R2 staging buckets** (Cloudflare dashboard — the object-scoped API token can read/write objects but returns 403 on bucket creation and CORS changes; verified):
   - `timor-shop-images-staging` (public `r2.dev`): created. CORS policy (bucket → Settings → CORS): the origins from `scripts/r2-cors.json` **plus** `https://timor-shop-staging.vercel.app`.
   - `timor-shop-proofs-staging` (private): pending creation, then the same CORS policy. The `R2_PROOFS_BUCKET=timor-shop-proofs-staging` secret is already set on staging — proof uploads start working as soon as the bucket exists.
   - Secrets already set on staging: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (reused prod token — confirmed working on the staging bucket), `R2_BUCKET=timor-shop-images-staging`, `R2_PROOFS_BUCKET`, `R2_PUBLIC_BASE_URL=https://pub-9130be0fa1054862ad19a89bd029b6e9.r2.dev`.
3. **Test Telegram bot**: @BotFather `/newbot` → set the token: `supabase secrets set --project-ref bszipcuuxqxrhsexdevi TELEGRAM_BOT_TOKEN=<token>`. Then `/newapp` → Mini App URL = **`https://timor-shop-staging.vercel.app`** (stable alias, currently pointing at the first preview deploy). CLI deploys get a new URL each time — after each `vercel deploy`, re-point the alias: `vercel alias set <new-deploy-url> timor-shop-staging.vercel.app`.
4. **verify.et** (optional): without `VERIFY_ET_API_KEY`, staging payment verification calls will fail — the 042/043 kill-switches mean you can also just leave verification off on staging. To test verification end-to-end, set the key (`supabase secrets set … VERIFY_ET_API_KEY=…`) and register `https://bszipcuuxqxrhsexdevi.supabase.co/functions/v1/verify-et-webhook` as a webhook on verify.et with the staging `VERIFY_ET_WEBHOOK_SECRET` (in `.env.staging`).
5. **Git remote**: the `dev` branch is local. Pushing to `llhdev/SchoolShop` needs the GitHub account you're signed in as (`santallh`) to be a collaborator — or push from an account with write access.

## Network gotcha on this dev machine

`*.supabase.co` (the project API hosts) is connection-reset from this machine — `api.supabase.com` (management), the Postgres pooler, and GitHub/Vercel APIs all work. Anything that must hit a project host directly (`scripts/setup-admin.js`, in-browser smoke tests) needs a different network or VPN. The pooler URL works for all SQL.
