import { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, ViewStyle } from 'react-native';
import { SafeAreaView, Edge } from 'react-native-safe-area-context';
import { useThemeColors, spacing, ColorPalette } from '../constants/theme';

interface ScreenProps {
  children: ReactNode;
  style?: ViewStyle;
  centered?: boolean;
  scroll?: boolean;
  noPadding?: boolean;
  edges?: Edge[];
}

export function Screen({
  children,
  style,
  centered = false,
  scroll = false,
  noPadding = false,
  edges = ['top', 'left', 'right', 'bottom'],
}: ScreenProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const content = (
    <View
      style={[
        styles.container,
        centered && styles.centered,
        noPadding && styles.noPadding,
        style,
      ]}
    >
      {children}
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={edges}>
      {scroll ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          contentInsetAdjustmentBehavior="never"
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
    },
    container: {
      flex: 1,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    noPadding: {
      paddingHorizontal: 0,
      paddingVertical: 0,
    },
    centered: {
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
