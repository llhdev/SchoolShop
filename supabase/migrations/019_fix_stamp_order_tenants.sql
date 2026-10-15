-- Fix stamp_order_tenants (migration 018): the FOR-loop version corrupted
-- NEW.items (NULL items) whenever an ordered product existed in the catalog.
-- Reimplemented with the same jsonb_agg pattern as 018's backfill, which is
-- proven against real data. Same contract: stamp each item's product with
-- owner_id/shop_name and fill orders.tenant_ids on INSERT.
CREATE OR REPLACE FUNCTION public.stamp_order_tenants()
RETURNS trigger AS $$
BEGIN
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
        ELSE jsonb_set(
               jsonb_set(elem, '{product,owner_id}',
                 to_jsonb(COALESCE(p.owner_id::text, ''))),
               '{product,shop_name}',
               to_jsonb(COALESCE(pr.shop_name, ''))
             )
      END
    )
    FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
    LEFT JOIN public.products p ON p.id = elem->'product'->>'id'
    LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ), '[]'::jsonb);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
