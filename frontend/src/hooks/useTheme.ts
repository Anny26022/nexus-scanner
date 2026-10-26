import { useLayoutEffect } from 'react';
import { useLocalStorageState } from './useLocalStorageState';

type Theme = 'light' | 'dark';
/** The saved appearance, or the host's `override` when embedded (which leaves the host's `<html>` alone). */
export function useTheme(override?: Theme) {
  const [savedChoice, setChoice] = useLocalStorageState<Theme>('nexus-scanner.ui.theme.v1', 'light');
  const choice: Theme = override ?? (savedChoice === 'dark' ? 'dark' : 'light');
  // External DOM synchronization includes portal surfaces as well as the app.
  useLayoutEffect(() => { if (!override) document.documentElement.dataset.theme = choice; }, [choice, override]);
  return { choice, setChoice };
}
