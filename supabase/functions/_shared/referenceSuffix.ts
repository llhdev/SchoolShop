// verify.et request shaping for CBE references. Modern CBE Receipt IDs
// (the mbreciept.cbe.com.et tokens) are self-contained, but legacy FT
// references are only unique per receiver account, so verify.et requires
// the receiver account's 8-digit suffix for those. Sending a suffix for a
// Receipt ID is rejected, so the field is added only for FT references.
//
// Used by BOTH verify-payment-reference (pre-order) and verify-order-payment
// (order-time replay): the replay body must stay byte-identical so verify.et
// treats it as the same idempotent request.

export interface BankAccountLike {
  accountNumber: string;
  bankName: string | null;
}

/** 8-digit receiver-account suffix for legacy CBE FT references; undefined
 *  when the reference is a modern Receipt ID or no CBE account is known. */
export function cbeSuffixFor(
  provider: string,
  reference: string,
  accounts: BankAccountLike[]
): string | undefined {
  if (provider !== 'cbe' || !/^FT/i.test(reference)) return undefined;
  const digitAccounts = accounts
    .map((a) => ({ digits: a.accountNumber.replace(/\D/g, ''), bankName: a.bankName }))
    .filter((a) => a.digits.length >= 8);
  // Prefer the account explicitly labeled CBE; otherwise bank accounts are
  // longer than Ethiopian phone numbers (10-12 digits), so take the longest.
  const named = digitAccounts.find((a) => /cbe|commercial/i.test(a.bankName ?? ''));
  const pick = named ?? digitAccounts.sort((a, b) => b.digits.length - a.digits.length)[0];
  return pick ? pick.digits.slice(-8) : undefined;
}
