import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useDroppable } from "@dnd-kit/core";
import { type StripAxis } from "@/components/epic-canvas/dnd/strip-axis";
import { registerTabStripGeometry } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { runHeaderStripCommitHandoff } from "./header-strip-commit-handoff";
import {
  HEADER_TAB_SLOT_DND_TYPE,
  HEADER_TAB_TRAILING_SLOT_DROP_ID,
  type HeaderTabSlotDropData,
} from "./header-tab-dnd";

/**
 * The DOM mechanics every tab strip's scroller shares, along the strip's own
 * axis: the commit re-base over every strip item, keeping the active member
 * in view (L-146), and the trailing drop slot. Returns the callback ref for
 * the scrolling element; `extraRef` also receives it.
 */
export function useStripScroller(input: {
  readonly axis: StripAxis;
  readonly activeItemId: string | null;
  readonly itemCount: number;
  readonly extraRef: ((node: HTMLDivElement | null) => void) | null;
}): (node: HTMLDivElement | null) => void {
  const { axis, itemCount, extraRef } = input;
  // Parent layout effects run AFTER every child's, so by here every strip item
  // has registered and published its current target. Driving the re-base from
  // this one boundary is what makes it reach EVERY item whose baseline moved -
  // an earlier per-item version reached only the items React happened to
  // re-render, which is one tab per commit.
  useLayoutEffect(() => {
    runHeaderStripCommitHandoff(axis);
  });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = scrollerRef.current;
    // Horizontal headers also publish the edge-menu snapshot through extraRef.
    if (element === null || extraRef !== null) return;
    return registerTabStripGeometry(element, axis, () => {});
  }, [axis, extraRef]);
  // Trailing slot: the strip's empty space after the last item accepts drops
  // at index `itemCount` (both reorder and tear-off).
  const trailingSlotData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: itemCount,
      isTrailing: true,
    }),
    [itemCount],
  );
  const { setNodeRef: trailingSlotRef } = useDroppable({
    id: HEADER_TAB_TRAILING_SLOT_DROP_ID,
    data: trailingSlotData,
  });
  // One stable callback ref for all three owners: a fresh callback ref on
  // every render detaches and re-attaches the node on every owner every
  // commit - which for dnd-kit means the drop slot is momentarily
  // unregistered mid-drag.
  return useCallback(
    (node: HTMLDivElement | null): void => {
      trailingSlotRef(node);
      scrollerRef.current = node;
      if (extraRef !== null) extraRef(node);
    },
    [trailingSlotRef, extraRef],
  );
}
