// verify.et bank-account registry sync, shared by verify-order-payment
// (which syncs every tenant's accounts) and verify-payment-reference
// (which syncs only the checkout tenant's). Registering accounts lets
// verify.et resolve a receipt's receiver to a concrete account, which is
// what makes the recipient check conclusive.

export interface RegistryAccount {
  accountNumber: string;
  bankName: string | null;
}

/** Best-effort: make sure every tenant bank account exists in the verify.et
 *  registry, so the receiver on a receipt can be resolved to a concrete
 *  account. Failures only degrade the recipient check to "review". */
export async function syncRegistry(apiKey: string, tenantAccounts: RegistryAccount[]): Promise<void> {
  try {
    const res = await fetch('https://verify.et/api/bank-accounts', {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) {
      console.error('registry list failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    const body = await res.json().catch(() => null);
    const existing = new Set<string>();
    for (const item of Array.isArray(body?.data) ? body.data : []) {
      const num = item?.accountNumber ?? item?.account_number ?? item?.number;
      if (num) existing.add(String(num).replace(/\D/g, ''));
    }
    let added = 0;
    for (const account of tenantAccounts) {
      const digits = account.accountNumber.replace(/\D/g, '');
      if (!digits || existing.has(digits) || added >= 20) continue;
      const create = await fetch('https://verify.et/api/bank-accounts', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber: account.accountNumber, bankName: account.bankName }),
      });
      if (create.ok) {
        existing.add(digits);
        added++;
      } else {
        console.error('registry add failed:', create.status, await create.text().catch(() => ''));
      }
    }
  } catch (error) {
    console.error('registry sync error:', error);
  }
}
