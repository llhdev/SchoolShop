import { Platform } from 'react-native';

/**
 * Web-only fatal error overlay.
 *
 * On the website and inside the Telegram Mini App there are no devtools, so a
 * startup crash would leave a silent blank page with no way to diagnose it.
 * This installs window error hooks that render the failure on screen instead.
 * It must stay the FIRST import in index.ts so the hooks are in place before
 * the rest of the app (whose import chain can itself throw) is evaluated.
 */
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const renderFatalError = (message: string) => {
    if (document.getElementById('fatal-error-overlay')) return;
    const el = document.createElement('pre');
    el.id = 'fatal-error-overlay';
    el.textContent = `Something went wrong while starting the app:\n\n${message}`;
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      margin: '0',
      padding: '24px',
      background: '#ffffff',
      color: '#b00020',
      fontSize: '14px',
      fontFamily: 'monospace',
      whiteSpace: 'pre-wrap',
      zIndex: '9999',
      overflow: 'auto',
    });
    document.body.appendChild(el);
  };

  window.addEventListener('error', (event) => {
    renderFatalError(event.message || String(event.error ?? 'Unknown error'));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string } | string | undefined;
    renderFatalError(
      (typeof reason === 'string' ? reason : reason?.message) ?? 'Unhandled promise rejection'
    );
  });
}

export {};
