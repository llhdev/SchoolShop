// Admin setup configuration used by scripts/setup-admin.js.
// The app itself no longer uses a shared keyword; admins are found by username.

export function getAdminEmail(): string {
  return process.env.EXPO_PUBLIC_ADMIN_EMAIL ?? '';
}

export function getAdminPassword(): string {
  return process.env.EXPO_PUBLIC_ADMIN_PASSWORD ?? '';
}
