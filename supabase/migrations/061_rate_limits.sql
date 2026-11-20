-- Timor Shop: per-IP rate limiting for the anonymous edge-function endpoints.
-- Run after 060_lockdown_legacy_storage_buckets.sql.
--
-- sign-proof-upload (r2-upload-sign) and verify-payment-reference are callable
-- by anonymous shoppers, so nothing stops one client from hammering them:
-- proof presigns are free junk-upload slots and every pre-check can burn a
-- verify.et credit. The edge functions now hash the caller's IP and call
-- public.check_rate_limit before doing any work (20 proof-upload presign
-- requests and 30 pre-checks per IP per hour). This is additive to the
-- daily global caps already in those functions.

-- ---------------------------------------------------------------------------
-- 1. rate_limits: one row per rate-limit key ("<scope>:<ip hash>"), holding
--    the current fixed window's start and hit count. Service-role only: RLS
--    enabled with NO policies (same pattern as payment_prechecks, 041), so
--    anon/authenticated roles have no access — the edge functions call it
--    with the service key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. check_rate_limit: fixed-window counter, atomic under concurrency. One
--    upsert takes the row lock on conflict, so concurrent callers serialize
--    and each sees the other's increment. Returns true when the call is
--    within the limit (starting a fresh window when none exists or the old
--    one expired), false when the window is full — in that case the count is
--    left untouched so it cannot drift upward on rejected calls.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  INSERT INTO public.rate_limits AS rl (key, window_start, count)
  VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE
    SET window_start = CASE
        WHEN rl.window_start + make_interval(secs => p_window_seconds) <= now()
        THEN now()
        ELSE rl.window_start
      END,
      count = CASE
        WHEN rl.window_start + make_interval(secs => p_window_seconds) <= now()
        THEN 1
        ELSE rl.count + 1
      END
    WHERE rl.window_start + make_interval(secs => p_window_seconds) <= now()
       OR rl.count < p_limit
  RETURNING true INTO v_allowed;

  -- A live window already at the limit fails the WHERE above: nothing was
  -- written and v_allowed stays null -> over limit.
  RETURN coalesce(v_allowed, false);
END;
$$;

-- Service-role only: the edge functions call this via PostgREST RPC with the
-- service key, which bypasses the revoke; clients never call it directly.
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer)
  FROM anon, authenticated, PUBLIC;

NOTIFY pgrst, 'reload schema';
