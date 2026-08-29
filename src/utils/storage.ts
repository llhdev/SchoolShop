import AsyncStorage from '@react-native-async-storage/async-storage';
import { Theme } from '../types';

const THEME_KEY = '@onlineshop_theme';

export async function loadTheme(): Promise<Theme | null> {
  try {
    const value = await AsyncStorage.getItem(THEME_KEY);
    return value === 'dark' ? 'dark' : value === 'light' ? 'light' : null;
  } catch {
    return null;
  }
}

export async function saveTheme(theme: Theme): Promise<void> {
  try {
    await AsyncStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}
