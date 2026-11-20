-- 063: stamp_order_tenants money/payment hardening + stronger password policy.
--
-- Builds on 054's stamp_order_tenants (order-insert hardening) and 051's
-- admin_set_tenant_password. The public orders INSERT policy (check: true)
-- means every client-supplied column is forgeable; this migration moves the
-- money math and the payment-verification bookkeeping server-side.
--
-- 1. Phone required ------------------------------------------------------------
--    The order id paired with the phone number is the shopper-lookup
--    capability, so phone-less orders must be impossible.
--
-- 2. telegram_notifications wiped on insert ------------------------------------
--    That jsonb column is written only by the telegram-order-notify edge
--    function (057, service role); a crafted insert must not plant message
--    locators or caption text.
--
-- 3. Server-side money recompute ------------------------------------------------
--    The client computes unit prices, per-shop shipping fees, and the order
--    total — all forgeable. The trigger now resolves the true unit price per
--    line from products.price / products.variants (mirroring
--    supabase/functions/_shared/variantPricing.ts: the chosen option's price
--    in the first price-affecting variant group overrides the base price),
--    overwrites the item's unitPrice and the snapshot product.price with it,
--    rebuilds shipping_fees from profiles.shipping_fee (031: once per order
--    per shop, 0/NULL = free), and recomputes total as
--    sum(qty * unit price) + sum(shipping fees). Lines whose product no
--    longer exists keep their sent prices (nothing to resolve against) — the
--    staff lifecycle still gates them.
--
-- 4. payment_references / payment_warnings gated on payment_prechecks ----------
--    A payment_references entry (tenant id -> {provider, reference, key}, 041)
--    claims checkout verified that reference against verify.et. Keep an entry
--    only when a payment_prechecks row exists for the exact
--    (provider, reference, idempotency_key) triple — the precheck table is
--    service-role only, so an anon client cannot plant rows there. Warning
--    entries (056) that carry a reference are likewise dropped when no
--    precheck row matches that reference; reference-less warnings (the
--    'unreadable' OCR pass) are kept as-is. When in doubt the entry is
--    dropped: the post-order verify-order-payment pipeline is the
--    authoritative verifier and re-derives state server-side.
--
-- 5. admin_set_tenant_password: minimum length 12 + session invalidation -------
--    Rotating a staff password must kill that account's live sessions. The
--    RPC writes auth.users directly (GoTrue is bypassed), so no automatic
--    invalidation happens — the refresh tokens are deleted explicitly. The
--    SET search_path = public, extensions from 051 is deliberate
--    (gen_salt/crypt live in extensions) and preserved.

-- ---------------------------------------------------------------------------
-- 1–4. stamp_order_tenants
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_order_tenants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- 1. Phone required: order id + phone is the shopper-lookup capability.
  IF NEW.phone_number IS NULL OR btrim(NEW.phone_number) = '' THEN
    RAISE EXCEPTION 'A phone number is required to place an order.';
  END IF;

  -- New orders always enter the staff lifecycle at pending; a shopper must
  -- not be able to pre-set their own status or per-item statuses (054).
  NEW.status := 'pending';
  NEW.item_statuses := '{}'::jsonb;

  -- 2. telegram_notifications is server-only (057): written by the
  -- telegram-order-notify edge function after the order exists.
  NEW.telegram_notifications := '{}'::jsonb;

  NEW.tenant_ids := COALESCE((
    SELECT array_agg(DISTINCT p.owner_id)
    FROM public.products p
    WHERE p.owner_id IS NOT NULL
      AND p.id IN (
        SELECT elem->'product'->>'id'
        FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
        WHERE elem->'product'->>'id' IS NOT NULL
      )
  ), '{}');

  -- 3. Item stamping (054: owner_id/shop_name snapshot, branch re-validation)
  --    plus server-side unit-price resolution. The laterals mirror
  --    _shared/variantPricing.ts: the FIRST variant group with
  --    affects_price = true sets the price; the line's selectedOptions pick
  --    one option of that group; the option's own price overrides the
  --    product's base price; anything malformed falls back to the base price.
  NEW.items := COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN elem->'product'->>'id' IS NULL THEN elem
        WHEN b.id IS NOT NULL THEN
          jsonb_set(
            jsonb_set(base.it, '{branchId}', to_jsonb(b.id::text)),
            '{branchName}', to_jsonb(b.name))
        ELSE base.it - 'branchId' - 'branchName'
      END
    )
    FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
    LEFT JOIN public.products p ON p.id = elem->'product'->>'id'
    LEFT JOIN public.profiles pr ON pr.id = p.owner_id
    LEFT JOIN public.branches b
      ON b.id::text = elem->>'branchId' AND b.tenant_id = p.owner_id
    -- First price-affecting variant group (malformed groups skipped).
    LEFT JOIN LATERAL (
      SELECT g AS grp
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p.variants) = 'array'
                  THEN p.variants ELSE '[]'::jsonb END) AS g
      WHERE jsonb_typeof(g->'name') = 'string'
        AND g->'affects_price' = 'true'::jsonb
      LIMIT 1
    ) AS price_group ON true
    -- The line's chosen option in that group.
    LEFT JOIN LATERAL (
      SELECT o->>'option' AS opt_name
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(elem->'selectedOptions') = 'array'
                  THEN elem->'selectedOptions' ELSE '[]'::jsonb END) AS o
      WHERE o->>'group' = (price_group.grp->>'name')
      LIMIT 1
    ) AS chosen ON true
    -- The chosen option's own price, when it carries one.
    LEFT JOIN LATERAL (
      SELECT (op->>'price')::numeric AS opt_price
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(price_group.grp->'options') = 'array'
                  THEN price_group.grp->'options' ELSE '[]'::jsonb END) AS op
      WHERE jsonb_typeof(op->'name') = 'string'
        AND op->>'name' = chosen.opt_name
        AND jsonb_typeof(op->'price') = 'number'
      LIMIT 1
    ) AS opt ON true
    CROSS JOIN LATERAL (
      SELECT jsonb_set(
               jsonb_set(elem, '{product,owner_id}',
                 to_jsonb(COALESCE(p.owner_id::text, ''))),
               '{product,shop_name}',
                 to_jsonb(COALESCE(pr.shop_name, '')))
             AS it
    ) AS stamped
    -- Overwrite both the line's unitPrice and the snapshot product.price with
    -- the resolved price so forged line prices can't survive. Unknown
    -- products keep what the client sent (nothing to resolve against).
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN p.id IS NULL THEN stamped.it
               ELSE jsonb_set(
                      jsonb_set(stamped.it, '{product,price}',
                        to_jsonb(COALESCE(opt.opt_price, p.price))),
                      '{unitPrice}',
                        to_jsonb(COALESCE(opt.opt_price, p.price)))
             END AS it
    ) AS base
  ), '[]'::jsonb);

  -- 3b. Shipping fees: rebuilt from the stamped items' owners and each shop's
  -- current profiles.shipping_fee (031) — once per order per shop, > 0 only.
  NEW.shipping_fees := COALESCE((
    SELECT jsonb_object_agg(owners.owner_id, shop.shipping_fee)
    FROM (
      SELECT DISTINCT it->'product'->>'owner_id' AS owner_id
      FROM jsonb_array_elements(NEW.items) AS it
    ) AS owners
    JOIN public.profiles shop ON shop.id::text = owners.owner_id
    WHERE owners.owner_id IS NOT NULL
      AND owners.owner_id <> ''
      AND COALESCE(shop.shipping_fee, 0) > 0
  ), '{}'::jsonb);

  -- 3c. Total: sum(qty * resolved unit price) + sum(shipping fees).
  NEW.total := COALESCE((
    SELECT sum(
             COALESCE((it->>'quantity')::numeric, 0)
             * COALESCE((it->>'unitPrice')::numeric,
                        (it->'product'->>'price')::numeric, 0))
    FROM jsonb_array_elements(NEW.items) AS it
  ), 0)
  + COALESCE((
    SELECT sum((fee.value)::numeric)
    FROM jsonb_each(NEW.shipping_fees) AS fee
  ), 0);

  -- 4a. payment_references: keep an entry only when the exact
  -- (provider, reference, idempotency key) triple was actually checked
  -- pre-order — payment_prechecks is service-role only (041).
  NEW.payment_references := COALESCE((
    SELECT jsonb_object_agg(ref.key, ref.value)
    FROM jsonb_each(COALESCE(NEW.payment_references, '{}'::jsonb)) AS ref
    WHERE jsonb_typeof(ref.value) = 'object'
      AND EXISTS (
        SELECT 1
        FROM public.payment_prechecks pp
        WHERE pp.provider = ref.value->>'provider'
          AND pp.reference = ref.value->>'reference'
          AND pp.idempotency_key = ref.value->>'key'
      )
  ), '{}'::jsonb);

  -- 4b. payment_warnings (056): a warning carrying a reference is meaningful
  -- only when that reference was actually checked; reference-less warnings
  -- (the 'unreadable' OCR pass, where no verification could run) are kept.
  NEW.payment_warnings := COALESCE((
    SELECT jsonb_object_agg(w.key, w.value)
    FROM jsonb_each(COALESCE(NEW.payment_warnings, '{}'::jsonb)) AS w
    WHERE jsonb_typeof(w.value) = 'object'
      AND (
        w.value->>'reference' IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.payment_prechecks pp
          WHERE pp.reference = w.value->>'reference'
        )
      )
  ), '{}'::jsonb);

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. admin_set_tenant_password: 12-char minimum + refresh-token invalidation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_tenant_password(
  tenant_id uuid,
  new_password text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    IF NOT (
      public.is_shop_owner()
      AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = tenant_id AND parent_tenant_id = auth.uid()
      )
    ) THEN
      RAISE EXCEPTION 'Only the super admin or the shop owner can set account passwords.';
    END IF;
  END IF;

  IF length(new_password) < 12 THEN
    RAISE EXCEPTION 'Password must be at least 12 characters.';
  END IF;

  UPDATE auth.users
  SET encrypted_password = crypt(new_password, gen_salt('bf'))
  WHERE id = tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found.';
  END IF;

  -- Rotating a staff password must kill that account's live sessions. This
  -- RPC writes auth.users directly, bypassing GoTrue, so no automatic
  -- invalidation happens — delete the refresh tokens explicitly; existing
  -- sessions then die as soon as their access token expires.
  DELETE FROM auth.refresh_tokens WHERE user_id = tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;

NOTIFY pgrst, 'reload schema';
