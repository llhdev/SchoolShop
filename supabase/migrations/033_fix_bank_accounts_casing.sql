-- Timor Shop: update_own_bank_accounts must accept the client's camelCase
-- keys. Run after 032_backfill_bank_accounts.sql.
--
-- The app sends BankAccount objects as { accountNumber, bankName?, qrImageUrl? }
-- (src/types), but 031's RPC only read snake_case keys — so every entry was
-- filtered out as "missing account_number" and the whole list was replaced
-- with []. Accept both casings, normalize to snake_case for storage.

CREATE OR REPLACE FUNCTION public.update_own_bank_accounts(p_accounts jsonb)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET bank_accounts = COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'account_number', account_number,
                   'bank_name', bank_name,
                   'qr_image_url', qr_image_url
                 )
               )
        FROM (
          SELECT
            COALESCE(
              NULLIF(trim(elem->>'account_number'), ''),
              NULLIF(trim(elem->>'accountNumber'), '')
            ) AS account_number,
            NULLIF(
              trim(COALESCE(elem->>'bank_name', elem->>'bankName', '')),
              ''
            ) AS bank_name,
            NULLIF(
              trim(COALESCE(elem->>'qr_image_url', elem->>'qrImageUrl', '')),
              ''
            ) AS qr_image_url
          FROM jsonb_array_elements(COALESCE(p_accounts, '[]'::jsonb)) AS elem
        ) AS parsed
        WHERE parsed.account_number IS NOT NULL
      ), '[]'::jsonb)
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
