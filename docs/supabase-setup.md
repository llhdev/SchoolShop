# Supabase setup

Fresh-backend setup for Timor Shop, moved out of the root `AGENTS.md`. For the staging stack (second project, test bot) see `docs/staging-setup.md`.

1. Create a project at https://supabase.com and copy the **Project URL** and **anon public API key**.
2. Create `.env` from `.env.example`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<your-anon-public-key>
   ```
3. Apply every migration in `supabase/migrations/` in order — from the SQL Editor, or `supabase db push` if linked.
4. Enable **Email auto-confirm** (Authentication > Providers > Email) so tenant accounts are immediately active.
5. Create the super admin: `node scripts/setup-admin.js` (needs `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` in `.env`).
6. Mini App: `supabase functions deploy telegram-auth`, set the `TELEGRAM_BOT_TOKEN` secret (from @BotFather). Full steps in `docs/telegram-mini-app.md`.
7. Order notifications: `supabase functions deploy telegram-order-notify` (needs `TELEGRAM_BOT_TOKEN` and `PUBLISHABLE_KEY`; per-tenant chat ids in `profiles.telegram_chat_id`). Tenants without a chat id are skipped — order placement unaffected. A group upgraded to a supergroup gets its new chat id adopted automatically.
8. Payment verification: `supabase functions deploy verify-order-payment verify-payment-reference verify-et-webhook`; secrets `VERIFY_ET_API_KEY`, `VERIFY_FUNCTION_SECRET` (also `SELECT vault.create_secret('<same>', 'verify_function_secret')`), `VERIFY_ET_WEBHOOK_SECRET` (webhook URL `…/functions/v1/verify-et-webhook`), optionally `RECEIPT_MAX_AGE_HOURS` (default 24). Test with genuine CBE/Telebirr receipts via `scripts/test-reference-verification.js` before going live.
9. Image storage (R2): `supabase functions deploy r2-upload-sign`; secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`, `R2_PROOFS_BUCKET`. Buckets `timor-shop-images` (public, custom domain `img.timor.et`) and `timor-shop-proofs` (private — create it in the Cloudflare dashboard; the token can't create buckets). Legacy Supabase objects: `node scripts/migrate-images-to-r2.js --apply --delete` and `node scripts/migrate-proofs-to-r2.js --apply --delete`.
10. Start the app. It begins with empty products, orders, and categories.
