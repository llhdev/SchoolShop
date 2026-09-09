import { registerRootComponent } from 'expo';

// First, before anything that can throw: surface fatal errors on screen on
// web (the Mini App has no devtools — a crash must be visible, not blank).
import './src/lib/errorOverlay';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
