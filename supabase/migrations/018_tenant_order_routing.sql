-- Timor Shop tenant order routing
-- Run this in the Supabase SQL Editor after 017_product_shop_names.sql is in place.
--
-- 1. Each tenant admin's Telegram group chat id, set by the super admin from
--    Tenant Management. The telegram-order-notify Edge Function reads this to
--    route each shop's line items to that shop's group.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS telegram_chat_id text;

-- 2. Which tenants are involved in an order (derived from the ordered
--    products' owners). Drives tenant-scoped order lists for tenant admins.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tenant_ids uuid[] NOT NULL DEFAULT '{}';

-- 3. Stamp each order item with its product's owner_id/shop_name and fill
--    tenant_ids whenever an order is inserted. Server-side so the mapping is
--    authoritative even if the client payload omits owner info, and item
--    ownership survives product deletion.
CREATE OR REPLACE FUNCTION public.stamp_order_tenants()
RETURNS trigger AS $$
DECLARE
  product_map jsonb;
  item jsonb;
  stamped jsonb := '[]'::jsonb;
  owner uuid;
  tenant_list uuid[] := '{}';
BEGIN
  SELECT COALESCE(jsonb_object_agg(p.id, jsonb_build_object(
           'owner_id', p.owner_id,
           'shop_name', pr.shop_name
         )), '{}'::jsonb)
  INTO product_map
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  WHERE p.id IN (
    SELECT elem->'product'->>'id'
    FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
    WHERE elem->'product'->>'id' IS NOT NULL
  );

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) LOOP
    IF product_map ? (item->'product'->>'id') THEN
      item := jsonb_set(
        item,
        '{product,owner_id}',
        to_jsonb((product_map->(item->'product'->>'id')->>'owner_id')::text)
      );
      item := jsonb_set(
        item,
        '{product,shop_name}',
        to_jsonb(product_map->(item->'product'->>'id')->>'shop_name')
      );
      owner := NULLIF(product_map->(item->'product'->>'id')->>'owner_id', '')::uuid;
      IF owner IS NOT NULL AND NOT (owner = ANY(tenant_list)) THEN
        tenant_list := tenant_list || owner;
      END IF;
    END IF;
    stamped := stamped || item;
  END LOOP;

  NEW.items := stamped;
  NEW.tenant_ids := tenant_list;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stamp_order_tenants_trigger ON orders;
CREATE TRIGGER stamp_order_tenants_trigger
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION public.stamp_order_tenants();

-- 4. Backfill pre-migration orders using the same lookup. COALESCE guards
--    rows whose items snapshot is NULL (jsonb_array_elements(NULL) yields no
--    rows, which would make jsonb_agg return NULL and trip the NOT NULL
--    constraint).
UPDATE public.orders o
SET tenant_ids = COALESCE((
      SELECT array_agg(DISTINCT p.owner_id)
      FROM public.products p
      WHERE p.owner_id IS NOT NULL
        AND p.id IN (
          SELECT elem->'product'->>'id'
          FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS elem
          WHERE elem->'product'->>'id' IS NOT NULL
        )
    ), '{}'),
    items = COALESCE((
      SELECT jsonb_agg(
        CASE
          WHEN elem->'product'->>'id' IS NULL THEN elem
          ELSE jsonb_set(
                 jsonb_set(elem, '{product,owner_id}',
                   to_jsonb(COALESCE(p.owner_id::text, ''))),
                 '{product,shop_name}',
                 to_jsonb(COALESCE(pr.shop_name, ''))
               )
        END
      )
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS elem
      LEFT JOIN public.products p ON p.id = elem->'product'->>'id'
      LEFT JOIN public.profiles pr ON pr.id = p.owner_id
    ), '[]'::jsonb)
WHERE o.tenant_ids = '{}';
