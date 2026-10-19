import { useEffect } from 'react';

export function useMountEffect(effect: () => void | (() => void)): void {
  // Mount-only subscription/cleanup for external resources.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, []);
}
