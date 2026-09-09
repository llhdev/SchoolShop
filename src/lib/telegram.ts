import { Platform } from 'react-native';

/**
 * Telegram Mini App (TMA) integration.
 *
 * A TMA is a web page running inside Telegram's WebView. Telegram injects a
 * `TelegramWebviewProxy` bridge into the page before load; the official
 * `telegram-web-app.js` script wraps that bridge in a usable API
 * (`window.Telegram.WebApp`). We only load that script when the bridge is
 * present, so regular browsers never pay for the extra request and native
 * builds never touch this module's web paths.
 *
 * Every helper here is a no-op (or returns null/false) outside Telegram, so
 * callers on native and plain web do not need their own guards beyond
 * checking `isTelegramMiniApp()`.
 */

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramMainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isEnabled: boolean;
  show(): void;
  hide(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  enable(): void;
  disable(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
  setText(text: string): void;
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_visible?: boolean;
    is_enabled?: boolean;
  }): void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export interface TelegramInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TelegramWebApp {
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  disableVerticalSwipes(): void;
  enableVerticalSwipes(): void;
  lockOrientation?(): void;
  unlockOrientation?(): void;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  initData: string;
  initDataUnsafe: { user?: TelegramUser; start_param?: string };
  safeAreaInset: TelegramInsets;
  contentSafeAreaInset: TelegramInsets;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
  onEvent(eventType: string, eventHandler: () => void): void;
  offEvent(eventType: string, eventHandler: () => void): void;
}

interface TelegramWindow {
  TelegramWebviewProxy?: unknown;
  Telegram?: { WebApp?: TelegramWebApp };
  document?: Document;
}

function tgWindow(): TelegramWindow | null {
  if (Platform.OS !== 'web') return null;
  return (globalThis as unknown as { window?: TelegramWindow }).window ?? null;
}

let webApp: TelegramWebApp | null = null;
let chromeAvailable = false;
let initPromise: Promise<TelegramWebApp | null> | null = null;

/**
 * True only when the real Telegram SDK loaded. A Mini App whose SDK script
 * failed to load still gets a stub WebApp (identity works, native chrome
 * doesn't) — callers that hide in-app UI in favour of Telegram's native
 * controls must check this and fall back.
 */
export function hasTelegramChrome(): boolean {
  return chromeAvailable;
}

function noop(): void {}

/**
 * Minimal WebApp stand-in used when the official SDK script cannot load but
 * the page IS running inside a Mini App WebView (detected via the signed
 * `tgWebAppData` query parameter Telegram appends to the URL). Exposes the
 * real initData/initDataUnsafe so shopper authentication works; every native
 * chrome method is an inert no-op.
 */
function createStubWebApp(initData: string): TelegramWebApp {
  let user: TelegramUser | undefined;
  try {
    const raw = new URLSearchParams(initData).get('user');
    if (raw) user = JSON.parse(raw) as TelegramUser;
  } catch {
    // Malformed user payload: leave undefined; auth will fail gracefully.
  }
  const startParam = new URLSearchParams(initData).get('start_param') ?? undefined;
  const mainButton: TelegramMainButton = {
    text: '',
    color: '',
    textColor: '',
    isVisible: false,
    isEnabled: false,
    show: noop,
    hide: noop,
    showProgress: noop,
    hideProgress: noop,
    enable: noop,
    disable: noop,
    onClick: noop,
    offClick: noop,
    setText: noop,
    setParams: noop,
  };
  const backButton: TelegramBackButton = {
    isVisible: false,
    show: noop,
    hide: noop,
    onClick: noop,
    offClick: noop,
  };
  return {
    ready: noop,
    expand: noop,
    close: noop,
    setHeaderColor: noop,
    setBackgroundColor: noop,
    disableVerticalSwipes: noop,
    enableVerticalSwipes: noop,
    lockOrientation: noop,
    unlockOrientation: noop,
    isExpanded: true,
    viewportHeight: 0,
    viewportStableHeight: 0,
    colorScheme: 'light',
    themeParams: {},
    initData,
    initDataUnsafe: { user, start_param: startParam },
    safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
    contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
    MainButton: mainButton,
    BackButton: backButton,
    onEvent: noop,
    offEvent: noop,
  };
}

/** Signed initData from the page URL, when Telegram launched us as a Mini App. */
function initDataFromUrl(): string {
  try {
    const win = tgWindow();
    const search = win?.document?.location?.search ?? '';
    return new URLSearchParams(search).get('tgWebAppData') ?? '';
  } catch {
    return '';
  }
}

function injectTelegramScript(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const win = tgWindow();
    if (!win?.document) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    // Never let a slow or blocked telegram.org hang app startup: if the
    // script neither loads nor errors in time, give up — the app then runs
    // in plain-web mode inside the WebView.
    const timeout = setTimeout(finish, timeoutMs);

    const existing = win.document.querySelector<HTMLScriptElement>(
      'script[data-tma-sdk]'
    );
    if (existing) {
      if (win.Telegram?.WebApp) {
        finish();
        return;
      }
      existing.addEventListener('load', finish);
      existing.addEventListener('error', finish);
      return;
    }
    const script = win.document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;
    script.dataset.tmaSdk = 'true';
    script.onload = finish;
    script.onerror = finish;
    win.document.head.appendChild(script);
  });
}

/**
 * Load the Telegram WebApp API if (and only if) the page runs inside
 * Telegram. Resolves immediately with null outside Telegram. Call once from
 * the root component before app state hydration.
 */
export function initTelegram(): Promise<TelegramWebApp | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const win = tgWindow();
    if (!win?.TelegramWebviewProxy) return null;
    await injectTelegramScript();
    webApp = win.Telegram?.WebApp ?? null;
    chromeAvailable = webApp != null;
    if (!webApp) {
      // The SDK script failed to load (slow/blocked telegram.org). Identity
      // does not depend on it — Mini Apps receive signed initData as the
      // tgWebAppData query parameter — so fall back to a stub. Native chrome
      // (MainButton, BackButton, theme colors) stays inert; callers that hide
      // in-app UI for Telegram's controls check hasTelegramChrome().
      const initData = initDataFromUrl();
      if (initData) webApp = createStubWebApp(initData);
    }
    if (webApp) {
      try {
        webApp.ready();
        webApp.expand();
        webApp.disableVerticalSwipes();
        webApp.lockOrientation?.();
      } catch {
        // Older Telegram clients may not support every method; ignore.
      }
    }
    return webApp;
  })();
  return initPromise;
}

/** Returns the WebApp API, or null outside Telegram / before init resolves. */
export function getTelegram(): TelegramWebApp | null {
  return webApp;
}

export function isTelegramMiniApp(): boolean {
  return Platform.OS === 'web' && webApp != null;
}

export function getTelegramUser(): TelegramUser | null {
  return webApp?.initDataUnsafe?.user ?? null;
}

/** Signed initData string to exchange with the telegram-auth Edge Function. */
export function getTelegramInitData(): string {
  return webApp?.initData ?? '';
}

/**
 * Bottom safe-area inset reported by Telegram. Inside a Mini App the CSS
 * env(safe-area-inset-*) values are unreliable, so use this for bottom
 * chrome (tab bar, CTA buttons) instead. Returns zeros outside Telegram.
 */
export function getTelegramBottomInset(): number {
  return webApp?.contentSafeAreaInset?.bottom ?? 0;
}

export function getTelegramColorScheme(): 'light' | 'dark' | null {
  return webApp?.colorScheme ?? null;
}

/** Subscribe to Telegram theme changes; returns an unsubscribe function. */
export function onTelegramThemeChanged(handler: () => void): () => void {
  if (!webApp) return () => {};
  webApp.onEvent('themeChanged', handler);
  return () => webApp?.offEvent('themeChanged', handler);
}

/** Apply app background/header colors to the Telegram chrome. */
export function applyTelegramColors(background: string, header: string): void {
  if (!webApp) return;
  try {
    webApp.setBackgroundColor(background);
    webApp.setHeaderColor(header);
  } catch {
    // Unsupported on older clients; cosmetic only.
  }
}

/**
 * Drive Telegram's MainButton (the native bottom CTA). Pass null config to
 * hide it. textColor is forced to white by Telegram unless the button color
 * is very light — keep the app primary color here.
 */
let mainButtonHandler: (() => void) | null = null;

export function configureTelegramMainButton(
  config: {
    text: string;
    color: string;
    enabled: boolean;
    onPress: () => void;
  } | null
): void {
  if (!webApp) return;
  const button = webApp.MainButton;
  if (!config) {
    if (mainButtonHandler) {
      button.offClick(mainButtonHandler);
      mainButtonHandler = null;
    }
    button.hide();
    return;
  }
  button.setParams({
    text: config.text,
    color: config.color,
    is_enabled: config.enabled,
    is_visible: true,
  });
  // Detach the previously registered handler, not the incoming one — passing
  // the new handler here used to leave stale closures subscribed.
  if (mainButtonHandler) button.offClick(mainButtonHandler);
  mainButtonHandler = config.onPress;
  button.onClick(config.onPress);
  button.show();
}

/** Show/hide the native loading spinner on the Telegram MainButton. */
export function setTelegramMainButtonProgress(visible: boolean): void {
  if (!webApp) return;
  try {
    if (visible) webApp.MainButton.showProgress();
    else webApp.MainButton.hideProgress();
  } catch {
    // Unsupported on older clients; cosmetic only.
  }
}
