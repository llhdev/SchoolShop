// Hidden admin access configuration.
// The keyword opens the admin login screen; the actual credentials live in environment variables.
export const ADMIN_KEYWORD = 'santa2024';

export function getAdminEmail(): string {
  return process.env.EXPO_PUBLIC_ADMIN_EMAIL ?? '';
}

export function getAdminPassword(): string {
  return process.env.EXPO_PUBLIC_ADMIN_PASSWORD ?? '';
}
