import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from './src/context/AppContext';
import { AppNavigator } from './src/navigation/AppNavigator';
import { initTelegram } from './src/lib/telegram';

export default function App() {
  // Load the Telegram WebApp API before anything hydrates. Outside Telegram
  // (native apps, plain browsers) this resolves immediately. The race with a
  // timeout guarantees the app renders even if the SDK script hangs on a
  // slow or blocked network.
  const [telegramReady, setTelegramReady] = useState(false);
  useEffect(() => {
    const timeout = setTimeout(() => setTelegramReady(true), 4000);
    initTelegram().finally(() => {
      clearTimeout(timeout);
      setTelegramReady(true);
    });
  }, []);

  if (!telegramReady) return null;

  return (
    <AppProvider>
      <AppNavigator />
      <StatusBar style="auto" />
    </AppProvider>
  );
}
