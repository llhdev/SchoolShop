import { Alert, Platform } from 'react-native';

export type NotifyType = 'success' | 'error' | 'info';

const TOAST_COLORS: Record<NotifyType, string> = {
  success: '#28A745',
  error: '#DC3545',
  info: '#1A1A1A',
};

function getToastContainer(): HTMLElement {
  let container = document.getElementById('app-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'app-toast-container';
    container.setAttribute(
      'style',
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'display:flex;flex-direction:column;align-items:center;gap:8px;' +
        'z-index:99999;pointer-events:none;max-width:90vw;'
    );
    document.body.appendChild(container);
  }
  return container;
}

function showWebToast(message: string, type: NotifyType) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.setAttribute(
    'style',
    `background:${TOAST_COLORS[type]};color:#FFFFFF;padding:12px 20px;border-radius:10px;` +
      'font:500 14px system-ui,-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.25);' +
      'opacity:0;transition:opacity 0.2s ease;text-align:center;'
  );
  getToastContainer().appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

/**
 * User-facing feedback that works on every platform. Alert.alert is a silent
 * no-op on react-native-web, so web gets a transient toast instead; native
 * keeps the familiar alert dialog. Use for errors/success/info — for
 * destructive confirmations keep using confirmAction (utils/confirm.ts).
 */
export function notify(message: string, type: NotifyType = 'info', title?: string) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    showWebToast(message, type);
    return;
  }
  const fallbackTitle = type === 'error' ? 'Error' : type === 'success' ? 'Success' : 'Notice';
  Alert.alert(title ?? fallbackTitle, message);
}
