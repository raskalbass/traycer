import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  isTabCycleRepeating,
  subscribeTabCycleActivity,
} from "@/lib/keybindings/tab-cycle-activity";

// Longer than the cursor's 100 ms fallback, so a held key cannot admit one
// cold resource per fallback frame. A pause stays short; keyup admits at once.
export const COLD_ADMISSION_SETTLE_MS = 150;

export function admitColdResource(
  warm: boolean,
  repeating: boolean,
  acquire: () => (() => void) | void,
): () => void {
  if (warm || !repeating) return acquire() ?? (() => {});
  let pending = true;
  let release: (() => void) | void;
  const admit = (): void => {
    if (!pending) return;
    pending = false;
    clearTimeout(timer);
    release = acquire();
  };
  const timer = setTimeout(admit, COLD_ADMISSION_SETTLE_MS);
  return () => {
    pending = false;
    clearTimeout(timer);
    release?.();
  };
}

export function useTabCycleRepeating(): boolean {
  return useSyncExternalStore(subscribeTabCycleActivity, isTabCycleRepeating);
}

/**
 * Keyup is an external-store render, not an imperative acquire: the committed
 * target's layout effect runs only after React cleans up the previous target.
 * Layout admission also preserves attach-before-screencast ordering.
 */
export function useColdAdmission(
  key: string,
  warm: boolean,
  visible: boolean,
): boolean {
  const repeating = useTabCycleRepeating();
  const [admitted, setAdmitted] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!visible || warm) return;
    return admitColdResource(false, repeating, () => {
      setAdmitted(key);
    });
  }, [key, warm, visible, repeating]);
  return warm || admitted === key;
}
