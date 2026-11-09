/**
 * Temporary kill-switches for features we want to keep in the codebase but
 * turn off for a period of time. Flip the flag back to `true` to re-enable.
 */

/**
 * Merchant (tenant admin) account editing: gateway (username), password,
 * shop description, Telegram username, bank transfer details, and the
 * shop shipping fee. When `false`, the Account & Security screen shows a
 * "temporarily unavailable" notice for STAFF accounts, its entry points are
 * hidden for them, and the shipping-fee field on Add/Edit Item is removed.
 * The super admin is unaffected — and since migration 048 the shop OWNER
 * always gets in (it manages the shop's staff and settings there); the flag
 * only freezes staff accounts.
 */
export const MERCHANT_ACCOUNT_EDITING_ENABLED = false;
