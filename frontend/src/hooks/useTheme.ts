import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useLocalStorageState } from './useLocalStorageState';

type Theme = 'system' | 'light' | 'dark';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const subscribe = (notify: () => void) => {
  const query = media();
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
export function useTheme() {
  const [choice, setChoice] = useLocalStorageState<Theme>('nexus-scanner.ui.theme.v1', 'system');
  const dark = useSyncExternalStore(subscribe, () => media().matches, () => false);
  const theme = choice === 'system' ? dark ? 'dark' : 'light' : choice;
  // External DOM synchronization includes portal surfaces as well as the app.
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return { choice, setChoice };
}
