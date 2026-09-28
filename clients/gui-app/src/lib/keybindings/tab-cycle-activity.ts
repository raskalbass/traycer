let repeating = false;
const listeners = new Set<() => void>();

export function isTabCycleRepeating(): boolean {
  return repeating;
}

export function subscribeTabCycleActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Dispatch owns writes; cold-resource admission only reads/subscribes. */
export function setTabCycleRepeating(next: boolean): void {
  if (repeating === next) return;
  repeating = next;
  listeners.forEach((listener) => listener());
}
