-- Timor Shop: backfill bank_accounts (again) + keep the legacy bank RPC in sync.
-- Run after 031_shipping_fee_bank_accounts.sql.
--
-- 1. 031's backfill ran before some tenants saved via the pre-031 app build,
--    which writes the retired profiles.bank_account_number column — mirror
--    any such value into bank_accounts now. Idempotent: only touches rows
--    whose bank_accounts is still empty.
-- 2. Old cached app bundles still call update_own_bank_details (migration
--    020). Rewrite it so a legacy save also populates bank_accounts, keeping
--    old clients compatible with the checkout that reads the new column.

UPDATE public.profiles
SET bank_accounts = jsonb_build_array(
      jsonb_build_object(
        'account_number', bank_account_number,
        'bank_name', NULL,
        'qr_image_url', bank_qr_image_url
      )
    )
WHERE bank_account_number IS NOT NULL
  AND bank_account_number <> ''
  AND bank_accounts = '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.update_own_bank_details(
  p_account_number text,
  p_qr_image_url text
)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET bank_account_number = nullif(trim(p_account_number), ''),
      bank_qr_image_url = nullif(trim(p_qr_image_url), ''),
      bank_accounts = CASE
        WHEN nullif(trim(p_account_number), '') IS NULL THEN '[]'::jsonb
        ELSE jsonb_build_array(
               jsonb_build_object(
                 'account_number', trim(p_account_number),
                 'bank_name', NULL,
                 'qr_image_url', nullif(trim(p_qr_image_url), '')
               )
             )
      END
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
