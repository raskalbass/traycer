import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { TaskTabLayout } from "@/lib/layout/layout-arrangement";
import { HORIZONTAL_STRIP_AXIS } from "@/components/epic-canvas/dnd/strip-axis";
import { readHeaderStripLayoutRect } from "./header-strip-geometry";

const TAB_SELECTOR = "[data-header-tab-key]";
const PIXEL_TOLERANCE = 1;

interface ActiveTabGeometry {
  readonly width: number;
  readonly key: string | null;
  readonly node: HTMLElement | null;
  readonly visible: boolean;
}

interface HiddenTabKeys {
  readonly left: ReadonlyArray<string>;
  readonly right: ReadonlyArray<string>;
}

interface HiddenTabsState {
  readonly hiddenTabKeys: HiddenTabKeys;
  readonly hasOverflow: boolean;
}

/** Observe the rendered tabs, including split members, but not collapsed groups. */
export function useHiddenHeaderTabs(layout: TaskTabLayout) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [{ hiddenTabKeys, hasOverflow }, setHiddenTabs] =
    useState<HiddenTabsState>({
      hiddenTabKeys: { left: [], right: [] },
      hasOverflow: false,
    });
  const activeGeometry = useRef<ActiveTabGeometry | null>(null);
  const invalidateLayout = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (element === null) return;
    let frame: number | null = null;
    let geometryDirty = true;
    let preserveVisibility = true;
    let revealSelection = true;
    // Content coordinates survive selection and scrolling. Only changed sizes
    // or membership require another read of every tab's layout.
    const bounds = new Map<string, { left: number; right: number }>();
    const targets = new Set<Element>();
    const refreshBounds = (viewportLeft: number, scrollLeft: number): void => {
      if (!geometryDirty) return;
      bounds.clear();
      for (const tab of element.querySelectorAll<HTMLElement>(TAB_SELECTOR)) {
        const key = tab.dataset.headerTabKey;
        const rect = readHeaderStripLayoutRect(tab, HORIZONTAL_STRIP_AXIS);
        if (key === undefined || rect.extent <= 0) continue;
        bounds.set(key, {
          left: rect.start - viewportLeft + scrollLeft,
          right: rect.end - viewportLeft + scrollLeft,
        });
      }
      geometryDirty = false;
    };
    const measure = () => {
      frame = null;
      const viewport = element.getBoundingClientRect();
      const width = element.clientWidth;
      const scrollLeft = element.scrollLeft;
      const overflowing =
        element.scrollWidth > availableHeaderWidth(element) + PIXEL_TOLERANCE;
      refreshBounds(viewport.left, scrollLeft);
      const activeTab = element.querySelector<HTMLElement>(
        `${TAB_SELECTOR}[aria-selected="true"]`,
      );
      const activeKey = activeTab?.dataset.headerTabKey ?? null;
      const activeBounds =
        activeKey === null ? undefined : bounds.get(activeKey);
      const previous = activeGeometry.current;
      // Preserve a visible tab when controls or a resize clip it, but never
      // undo a user's scroll toward other tabs just because an edge menu appears.
      const shouldReveal = shouldRevealActiveTab({
        revealSelection,
        previous,
        activeKey,
        activeTab,
        preserveVisibility,
        width,
      });
      const { left, right } = hiddenKeys(
        bounds,
        overflowing,
        scrollLeft,
        viewport.width,
      );
      revealSelection = false;
      preserveVisibility = false;
      // Tab geometry is complete before scrolling. Sample only the resulting
      // scroll offset so a following edge-control resize preserves the reveal.
      if (shouldReveal) {
        activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      const revealedScrollLeft = shouldReveal ? element.scrollLeft : scrollLeft;
      activeGeometry.current = {
        width,
        key: activeKey,
        node: activeTab,
        visible:
          activeBounds !== undefined &&
          activeBounds.left >= revealedScrollLeft - PIXEL_TOLERANCE &&
          activeBounds.right <=
            revealedScrollLeft + viewport.width + PIXEL_TOLERANCE,
      };
      setHiddenTabs((previousState) =>
        previousState.hasOverflow === overflowing &&
        sameKeys(previousState.hiddenTabKeys.left, left) &&
        sameKeys(previousState.hiddenTabKeys.right, right)
          ? previousState
          : { hiddenTabKeys: { left, right }, hasOverflow: overflowing },
      );
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    invalidateLayout.current = () => {
      geometryDirty = true;
      revealSelection = true;
      schedule();
    };
    const observer = new ResizeObserver(() => {
      geometryDirty = true;
      preserveVisibility = true;
      schedule();
    });
    const observeChildren = () => {
      const next = new Set<Element>([element, ...element.children]);
      if (element.parentElement !== null) next.add(element.parentElement);
      for (const target of targets) {
        if (!next.has(target)) {
          observer.unobserve(target);
          targets.delete(target);
        }
      }
      for (const target of next) {
        if (!targets.has(target)) {
          observer.observe(target);
          targets.add(target);
        }
      }
    };
    const mutations = new MutationObserver((records) => {
      let childrenChanged = false;
      let invalidated = false;
      for (const record of records) {
        if (record.type === "attributes") {
          invalidated = true;
          if (record.attributeName === "data-header-tab-key") {
            geometryDirty = true;
          }
        } else if (record.target === element) {
          childrenChanged = true;
          geometryDirty = true;
          invalidated = true;
        } else if (
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(TAB_SELECTOR) ||
                node.querySelector(TAB_SELECTOR) !== null),
          )
        ) {
          // Split members can join without changing the outer frame's size.
          geometryDirty = true;
          invalidated = true;
        }
      }
      if (childrenChanged) observeChildren();
      if (invalidated) schedule();
    });
    mutations.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "data-header-tab-key"],
    });
    element.addEventListener("scroll", schedule, { passive: true });
    observeChildren();
    schedule();
    return () => {
      invalidateLayout.current = null;
      activeGeometry.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      element.removeEventListener("scroll", schedule);
    };
  }, [element]);

  useLayoutEffect(() => {
    invalidateLayout.current?.();
  }, [element, layout]);

  const revealTab = useCallback(
    (key: string) => {
      const tab = Array.from(
        element?.querySelectorAll<HTMLElement>(TAB_SELECTOR) ?? [],
      ).find((candidate) => candidate.dataset.headerTabKey === key);
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
      tab?.focus({ preventScroll: true });
    },
    [element],
  );

  return {
    setScrollElement: setElement,
    hiddenTabKeys,
    hasOverflow,
    revealTab,
  };
}

function sameKeys(
  previous: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((key, index) => key === next[index])
  );
}

function availableHeaderWidth(element: HTMLElement): number {
  let width = element.clientWidth;
  // Add both control slots back so overflow cannot keep itself mounted.
  for (const control of element.parentElement?.querySelectorAll<HTMLElement>(
    "[data-hidden-tabs-control]",
  ) ?? []) {
    width += control.offsetWidth;
  }
  return width;
}

function shouldRevealActiveTab(input: {
  revealSelection: boolean;
  previous: ActiveTabGeometry | null;
  activeKey: string | null;
  activeTab: HTMLElement | null;
  preserveVisibility: boolean;
  width: number;
}): boolean {
  const { previous } = input;
  if (input.revealSelection || previous === null) return true;
  return (
    previous.key !== input.activeKey ||
    previous.node !== input.activeTab ||
    (input.preserveVisibility &&
      previous.visible &&
      previous.width > input.width)
  );
}

function hiddenKeys(
  bounds: ReadonlyMap<string, { left: number; right: number }>,
  overflowing: boolean,
  scrollLeft: number,
  width: number,
): HiddenTabKeys {
  const left: string[] = [];
  const right: string[] = [];
  if (overflowing) {
    for (const [key, rect] of bounds) {
      if (rect.left < scrollLeft - PIXEL_TOLERANCE) left.push(key);
      if (rect.right > scrollLeft + width + PIXEL_TOLERANCE) right.push(key);
    }
  }
  return { left, right };
}
