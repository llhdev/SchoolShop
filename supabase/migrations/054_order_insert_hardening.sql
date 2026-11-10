-- 054: order-insert hardening + shop_name stamping fix
--
-- Two holes found in the full staging QA pass:
--
-- 1. stamp_order_tenants ran as the INVOKER. Order inserts come from anon
--    shoppers, and anon cannot read profiles, so every item snapshot was
--    stamped with shop_name='' (owner_id was fine — products is
--    public-read). AdminAnalysis groups rows by the snapshot's shop name, so
--    this corrupted the per-store breakdown. Fix: SECURITY DEFINER.
--
-- 2. The public orders INSERT policy (check: true) let a crafted client
--    insert an order with status='paid' (or any item_statuses), skipping the
--    entire staff lifecycle. Fix: the same trigger now forces
--    status='pending' and wipes item_statuses on insert, mirroring what
--    force_order_created_at (041) already does for created_at.
--    payment_proofs/payment_references stay client-set — both are
--    legitimately attached at checkout.
--
-- Also backfills shop_name on existing order items (from each product's
-- owner profile) so historical analysis rows display correctly.

CREATE OR REPLACE FUNCTION public.stamp_order_tenants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- New orders always enter the staff lifecycle at pending; a shopper must
  -- not be able to pre-set their own status or per-item statuses.
  NEW.status := 'pending';
  NEW.item_statuses := '{}'::jsonb;

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
    CROSS JOIN LATERAL (
      SELECT jsonb_set(
               jsonb_set(elem, '{product,owner_id}',
                 to_jsonb(COALESCE(p.owner_id::text, ''))),
               '{product,shop_name}',
                 to_jsonb(COALESCE(pr.shop_name, '')))
             AS it
    ) AS base
  ), '[]'::jsonb);

  RETURN NEW;
END;
$function$;

-- Backfill shop_name on order items stamped while the trigger was invoker
-- (empty string), resolved from the product owner's profile.
UPDATE public.orders o
SET items = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->'product'->>'id' IS NOT NULL
           AND COALESCE(elem->'product'->>'shop_name', '') = ''
           AND pr.shop_name IS NOT NULL
      THEN jsonb_set(elem, '{product,shop_name}', to_jsonb(pr.shop_name))
      ELSE elem
    END
  )
  FROM jsonb_array_elements(o.items) AS elem
  LEFT JOIN public.products p ON p.id = elem->'product'->>'id'
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(o.items) AS e
  WHERE COALESCE(e->'product'->>'shop_name', '') = ''
    AND e->'product'->>'id' IS NOT NULL
);
