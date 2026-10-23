import { useLayoutEffect } from 'react';
import { useLocalStorageState } from './useLocalStorageState';

type Theme = 'light' | 'dark';
export function useTheme() {
  const [savedChoice, setChoice] = useLocalStorageState<Theme>('nexus-scanner.ui.theme.v1', 'light');
  const choice: Theme = savedChoice === 'dark' ? 'dark' : 'light';
  // External DOM synchronization includes portal surfaces as well as the app.
  useLayoutEffect(() => { document.documentElement.dataset.theme = choice; }, [choice]);
  return { choice, setChoice };
}
