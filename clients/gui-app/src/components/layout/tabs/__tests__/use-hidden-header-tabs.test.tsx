import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { useHiddenHeaderTabs } from "@/components/layout/tabs/use-hidden-header-tabs";
import type { TaskTabLayout } from "@/lib/layout/layout-arrangement";

interface Box {
  readonly left: number;
  readonly right: number;
}

interface Geometry {
  viewport: Box;
  outerWidth: number;
  scrollWidth: number;
  controlWidth: number;
  /** Scroll offset of the viewport. Tab boxes below are content-coordinate
   * (i.e. what `getBoundingClientRect` would return at `scrollLeft: 0`); a
   * real scroll is simulated by moving this, never by mutating `tabs`. */
  scrollLeft: number;
  tabs: Record<string, Box>;
}

let geometry: Geometry;
let activeKey: string | null = null;
let resizeObservers: ControllableResizeObserver[] = [];

/**
 * Deferred `requestAnimationFrame`, so a test controls exactly when the
 * hook's coalesced measurement actually runs instead of it firing inline.
 */
let rafCallbacks: Map<number, FrameRequestCallback> = new Map();
let nextRafId = 0;

function installRaf(): void {
  rafCallbacks = new Map();
  nextRafId = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => {
      nextRafId += 1;
      rafCallbacks.set(nextRafId, callback);
      return nextRafId;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    rafCallbacks.delete(id);
  });
}

function flushRaf(): void {
  const pending = [...rafCallbacks.values()];
  rafCallbacks.clear();
  act(() => {
    for (const callback of pending) callback(0);
  });
}

/**
 * Let any pending MutationObserver microtask deliver its records (it always
 * schedules through the same `requestAnimationFrame` stub), then flush the
 * frame. Safe to call when nothing is pending - both steps are then no-ops.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  flushRaf();
}

class ControllableResizeObserver {
  readonly observed = new Set<Element>();
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  // Like the real observer, deliver an initial notification once a target is
  // observed; the hook relies on it for its first measurement.
  observe(target: Element): void {
    this.observed.add(target);
    this.callback();
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  disconnect(): void {
    this.observed.clear();
  }
  /** Simulate the browser reporting a resize on an already-observed target. */
  trigger(): void {
    this.callback();
  }
}

function rect(box: Box): DOMRect {
  return {
    left: box.left,
    right: box.right,
    x: box.left,
    y: 0,
    top: 0,
    bottom: 20,
    width: box.right - box.left,
    height: 20,
    toJSON: () => ({}),
  };
}

function installGeometry(): void {
  const define = (name: string, getter: (el: HTMLElement) => unknown) =>
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return getter(this);
      },
    });
  // The viewport shares its row with the two edge slots, so it is narrower
  // by one slot width per slot mounted (400 with both slots, 480 with none).
  define("clientWidth", (el) => {
    if (el.dataset.testid !== "viewport") return 0;
    const controls =
      el.parentElement?.querySelectorAll("[data-hidden-tabs-control]").length ??
      0;
    return geometry.outerWidth - controls * geometry.controlWidth;
  });
  define("scrollWidth", (el) =>
    el.dataset.testid === "viewport" ? geometry.scrollWidth : 0,
  );
  define("offsetWidth", (el) =>
    el.hasAttribute("data-hidden-tabs-control") ? geometry.controlWidth : 0,
  );
  define("scrollLeft", (el) =>
    el.dataset.testid === "viewport" ? geometry.scrollLeft : 0,
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.dataset.testid === "viewport") return rect(geometry.viewport);
      const key = this.dataset.headerTabKey;
      const box = key === undefined ? undefined : geometry.tabs[key];
      if (box === undefined) return rect({ left: 0, right: 0 });
      // Content position minus the current scroll - a real scroll moves
      // rendered content without moving the tab's fixed content position.
      return rect({
        left: box.left - geometry.scrollLeft,
        right: box.right - geometry.scrollLeft,
      });
    },
  });
}

function uninstallGeometry(): void {
  for (const name of [
    "clientWidth",
    "scrollWidth",
    "offsetWidth",
    "scrollLeft",
    "getBoundingClientRect",
  ]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
}

function Harness(props: {
  readonly layout: TaskTabLayout;
  readonly keys: ReadonlyArray<string>;
}) {
  const { setScrollElement, hiddenTabKeys, hasOverflow, revealTab } =
    useHiddenHeaderTabs(props.layout);
  return (
    <div>
      <div ref={setScrollElement} data-testid="viewport">
        {props.keys.map((key) => (
          <button
            key={key}
            type="button"
            data-header-tab-key={key}
            role="tab"
            aria-selected={key === activeKey}
          >
            {key}
          </button>
        ))}
      </div>
      {hasOverflow ? (
        <>
          <span data-hidden-tabs-control="left" />
          <span data-hidden-tabs-control="right" />
        </>
      ) : null}
      <output data-testid="hidden">
        {hiddenTabKeys.left.join(",")}|{hiddenTabKeys.right.join(",")}
      </output>
      <output data-testid="overflow">{String(hasOverflow)}</output>
      <button type="button" onClick={() => revealTab("b")}>
        reveal-b
      </button>
      <button type="button" onClick={() => revealTab("missing")}>
        reveal-missing
      </button>
    </div>
  );
}

// "left|right" membership of the two edge menus.
function hidden(): string {
  return screen.getByTestId("hidden").textContent;
}

function overflow(): string {
  return screen.getByTestId("overflow").textContent;
}

function controlCount(): number {
  return document.querySelectorAll("[data-hidden-tabs-control]").length;
}

function overflowingGeometry(): Geometry {
  return {
    viewport: { left: 100, right: 500 },
    outerWidth: 480,
    scrollWidth: 600,
    controlWidth: 40,
    scrollLeft: 0,
    tabs: {
      a: { left: 60, right: 160 },
      b: { left: 160, right: 300 },
      c: { left: 300, right: 420 },
      d: { left: 420, right: 520 },
    },
  };
}

async function mount(
  layout: TaskTabLayout,
  keys: ReadonlyArray<string>,
): Promise<RenderResult> {
  const view = render(<Harness layout={layout} keys={keys} />);
  await settle();
  return view;
}

/** Dispatch every observed resize and let the coalesced frame run. */
async function fireResize(): Promise<void> {
  act(() => {
    for (const observer of resizeObservers) observer.trigger();
  });
  await settle();
}

async function fireScroll(element: HTMLElement): Promise<void> {
  fireEvent.scroll(element);
  await settle();
}

beforeEach(() => {
  resizeObservers = [];
  activeKey = null;
  geometry = overflowingGeometry();
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  installGeometry();
  installRaf();
});

afterEach(() => {
  cleanup();
  uninstallGeometry();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useHiddenHeaderTabs", () => {
  it("lists tabs clipped on either edge, in DOM order, and not the fully visible ones", async () => {
    await mount("scroll", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("a|d");
  });

  it("tolerates one pixel of sub-pixel clipping", async () => {
    geometry.tabs.d = { left: 420, right: 501 };
    geometry.tabs.a = { left: 99, right: 160 };
    await mount("scroll", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("|");
  });

  it("reports nothing when the content fits", async () => {
    geometry.scrollWidth = 400;
    await mount("scroll", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("|");
  });

  it("re-measures when the strip scrolls", async () => {
    await mount("scroll", ["a", "b", "c", "d"]);
    // Content is fixed; scrolling right by 20 brings 'd' fully into view
    // while 'a' - off the left edge from the very start - stays hidden.
    geometry.scrollLeft = 20;
    await fireScroll(screen.getByTestId("viewport"));
    expect(hidden()).toBe("a|");
  });

  it("re-measures when the viewport is resized", async () => {
    await mount("scroll", ["a", "b", "c", "d"]);
    geometry.viewport = { left: 100, right: 700 };
    geometry.outerWidth = 640;
    geometry.scrollWidth = 700;
    await fireResize();
    expect(hidden()).toBe("a|");
  });

  it("clears the hidden membership once a resize makes everything fit", async () => {
    await mount("scroll", ["a", "b", "c", "d"]);
    geometry.scrollWidth = 400;
    await fireResize();
    expect(hidden()).toBe("|");
  });

  it("lists a tab that is added past the edge", async () => {
    const view = await mount("scroll", ["a", "b"]);
    expect(hidden()).toBe("a|");
    const observeSpy = vi.spyOn(
      ControllableResizeObserver.prototype,
      "observe",
    );
    observeSpy.mockClear();
    geometry.tabs.e = { left: 520, right: 620 };
    // The DOM change is observed through a MutationObserver callback.
    view.rerender(<Harness layout="scroll" keys={["a", "b", "e"]} />);
    await settle();
    expect(hidden()).toBe("a|e");
    // A genuine membership change re-subscribes the resize targets - unlike
    // an attribute-only invalidation, which must not (see below).
    expect(observeSpy).toHaveBeenCalled();
    observeSpy.mockRestore();
  });

  it("drops a removed tab, e.g. a collapsed group, from the membership", async () => {
    const view = await mount("scroll", ["a", "b", "c", "d"]);
    view.rerender(<Harness layout="scroll" keys={["b", "c"]} />);
    await settle();
    expect(hidden()).toBe("|");
  });

  it("ignores tabs with no rendered width", async () => {
    geometry.tabs.d = { left: 0, right: 0 };
    await mount("scroll", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("a|");
  });

  it("lists hidden tabs in shrink layout too when even compact tabs overflow", async () => {
    await mount("shrink", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("a|d");
  });

  it("lists no hidden tabs in shrink layout when the tabs fit", async () => {
    geometry.scrollWidth = 400;
    await mount("shrink", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("|");
  });

  it("recomputes from the new geometry when the layout switches", async () => {
    const view = await mount("scroll", ["a", "b", "c", "d"]);
    expect(hidden()).toBe("a|d");
    geometry.scrollWidth = 400;
    // The layout-change effect invalidates and reschedules on its own,
    // without touching the ResizeObserver.
    view.rerender(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    await settle();
    expect(hidden()).toBe("|");
  });

  it("subtracts both edge slots' footprint so they cannot keep themselves mounted", async () => {
    await mount("scroll", ["a", "b", "c", "d"]);
    expect(hidden()).not.toBe("|");
    // Slots mounted: clientWidth is 400. 470 content overflows that but fits
    // the 480px that exist once both slots are gone, so the slots must clear
    // and stay cleared after clientWidth grows back to 480.
    geometry.scrollWidth = 470;
    await fireResize();
    expect(hidden()).toBe("|");
    await fireResize();
    expect(hidden()).toBe("|");
  });

  it("still reports overflow when content exceeds the width even after both slots' footprint is added back", async () => {
    await mount("scroll", ["a", "b", "c", "d"]);
    geometry.scrollWidth = 490;
    await fireResize();
    expect(hidden()).toBe("a|d");
  });

  describe("per-side edge menus", () => {
    const KEYS = ["a", "b", "c", "d"];

    it("mounts both control slots whenever the strip overflows, even if one side is empty", async () => {
      geometry.tabs.a = { left: 100, right: 160 };
      await mount("scroll", KEYS);
      expect(hidden()).toBe("|d");
      expect(overflow()).toBe("true");
      expect(controlCount()).toBe(2);
    });

    it("moves tabs between sides only as the strip scrolls", async () => {
      // Four uniform 100-wide tabs (content coordinates) in a 150-wide
      // viewport: scrolling is the only thing that changes which side a tab
      // is hidden on.
      geometry.viewport = { left: 0, right: 150 };
      geometry.outerWidth = 150;
      geometry.controlWidth = 20;
      geometry.scrollWidth = 400;
      geometry.tabs = {
        a: { left: 0, right: 100 },
        b: { left: 100, right: 200 },
        c: { left: 200, right: 300 },
        d: { left: 300, right: 400 },
      };
      geometry.scrollLeft = 0;
      await mount("scroll", KEYS);
      expect(hidden()).toBe("|b,c,d");
      geometry.scrollLeft = 125;
      await fireScroll(screen.getByTestId("viewport"));
      expect(hidden()).toBe("a,b|c,d");
      geometry.scrollLeft = 250;
      await fireScroll(screen.getByTestId("viewport"));
      expect(hidden()).toBe("a,b,c|");
    });

    it("lists a tab wider than the viewport on both sides", async () => {
      geometry.tabs = {
        a: { left: 60, right: 160 },
        b: { left: 50, right: 600 },
        c: { left: 600, right: 700 },
        d: { left: 700, right: 800 },
      };
      await mount("scroll", KEYS);
      expect(hidden()).toBe("a,b|b,c,d");
    });

    it("keeps DOM order within each side", async () => {
      geometry.tabs = {
        a: { left: 0, right: 50 },
        b: { left: 50, right: 99 },
        c: { left: 99, right: 400 },
        d: { left: 500, right: 560 },
      };
      await mount("scroll", ["d", "c", "b", "a"]);
      expect(hidden()).toBe("b,a|d");
    });

    it("does not let the two-slot footprint sustain overflow after a resize", async () => {
      await mount("scroll", KEYS);
      expect(controlCount()).toBe(2);
      // 470 fits the 480px that exist once both slots are gone.
      geometry.scrollWidth = 470;
      await fireResize();
      expect(overflow()).toBe("false");
      expect(controlCount()).toBe(0);
      await fireResize();
      expect(overflow()).toBe("false");
      expect(hidden()).toBe("|");
    });

    it("keeps overflow when content exceeds the width with both slots added back", async () => {
      await mount("scroll", KEYS);
      geometry.scrollWidth = 490;
      await fireResize();
      expect(overflow()).toBe("true");
      expect(controlCount()).toBe(2);
    });

    it("reports no overflow and no slots when everything fits", async () => {
      geometry.scrollWidth = 400;
      await mount("scroll", KEYS);
      expect(overflow()).toBe("false");
      expect(controlCount()).toBe(0);
    });
  });

  it("reveal scrolls the tab into view and focuses it", async () => {
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    await mount("scroll", ["a", "b", "c", "d"]);
    scroll.mockClear();
    fireEvent.click(screen.getByText("reveal-b"));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scroll.mock.contexts[0]).toBe(screen.getByText("b"));
    expect(document.activeElement).toBe(screen.getByText("b"));
  });

  it("reveal of an unknown key is a no-op", async () => {
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    await mount("scroll", ["a", "b"]);
    scroll.mockClear();
    fireEvent.click(screen.getByText("reveal-missing"));
    expect(scroll).not.toHaveBeenCalled();
  });

  describe("active tab re-reveal", () => {
    const KEYS = ["a", "b", "c", "d"];

    async function renderWithActive(
      active: string,
      layout: TaskTabLayout,
    ): Promise<MockInstance<Element["scrollIntoView"]>> {
      activeKey = active;
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      await mount(layout, KEYS);
      // Mount itself reveals the active tab; only later calls are under test.
      scroll.mockClear();
      return scroll;
    }

    it("does not snap back when a manual scroll makes the active tab visible", async () => {
      // 'd' sits at content 320..420, clipped at mount; scrolling to 20
      // brings it fully into view, via the cached bounds.
      const scroll = await renderWithActive("d", "scroll");
      geometry.scrollLeft = 20;
      await fireScroll(screen.getByTestId("viewport"));
      expect(scroll).not.toHaveBeenCalled();
    });

    it("does not snap back when a manual scroll hides the active tab", async () => {
      const scroll = await renderWithActive("b", "scroll");
      // 'b' sits at content 160..300; scrolling to 70 clips it on the left,
      // via the cached bounds - no fresh tab rect is read for this.
      geometry.scrollLeft = 70;
      await fireScroll(screen.getByTestId("viewport"));
      expect(scroll).not.toHaveBeenCalled();
      expect(hidden()).toContain("b");
    });

    it("does not reveal a hidden active tab when the edge slots narrow the viewport", async () => {
      geometry.scrollWidth = 400;
      const scroll = await renderWithActive("a", "scroll");
      expect(hidden()).toBe("|");
      geometry.scrollWidth = 600;
      await fireResize();
      expect(hidden()).toBe("a|d");
      // Both slots are now mounted and the viewport narrower; the observer
      // reports that too.
      await fireResize();
      expect(hidden()).toBe("a|d");
      expect(scroll).not.toHaveBeenCalled();
    });

    it("reveals the active tab when the viewport shrinks while it was visible", async () => {
      geometry.scrollWidth = 400;
      const scroll = await renderWithActive("b", "scroll");
      geometry.outerWidth = 300;
      await fireResize();
      expect(scroll).toHaveBeenCalled();
      for (const context of scroll.mock.contexts) {
        expect(context).toBe(screen.getByText("b"));
      }
    });

    it("tracks an aria-selected-only change, so a later shrink reveals the new active tab", async () => {
      geometry.scrollWidth = 400;
      activeKey = "b";
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      const view = await mount("scroll", KEYS);
      // Both tabs stay visible and no child is added or removed: only the
      // selection attribute moves, which the hook must observe by itself.
      activeKey = "c";
      view.rerender(<Harness layout="scroll" keys={KEYS} />);
      await settle();
      scroll.mockClear();
      geometry.outerWidth = 300;
      await fireResize();
      expect(scroll).toHaveBeenCalled();
      for (const context of scroll.mock.contexts) {
        expect(context).toBe(screen.getByText("c"));
      }
    });
  });

  describe("reordering frames with a translate transform", () => {
    const TRANSLATE_72 = "matrix(1, 0, 0, 1, 72, 0)";
    const TRANSLATE_MINUS_72 = "matrix(1, 0, 0, 1, -72, 0)";
    const TRANSLATE_72_3D =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 72, 0, 0, 1)";
    const TRANSLATE_MINUS_72_3D =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -72, 0, 0, 1)";

    interface Frame {
      readonly id: string;
      readonly keys: ReadonlyArray<string>;
      readonly transform: string;
    }

    function FrameHarness(props: { readonly frames: ReadonlyArray<Frame> }) {
      const { setScrollElement, hiddenTabKeys, hasOverflow } =
        useHiddenHeaderTabs("scroll");
      return (
        <div>
          <div ref={setScrollElement} data-testid="viewport">
            {props.frames.map((frame) => (
              <div
                key={frame.id}
                data-strip-item-id={frame.id}
                style={{ transform: frame.transform }}
              >
                {frame.keys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    data-header-tab-key={key}
                    aria-selected={key === activeKey}
                  >
                    {key}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {hasOverflow ? (
            <>
              <span data-hidden-tabs-control="left" />
              <span data-hidden-tabs-control="right" />
            </>
          ) : null}
          <output data-testid="hidden">
            {hiddenTabKeys.left.join(",")}|{hiddenTabKeys.right.join(",")}
          </output>
        </div>
      );
    }

    async function mountFrames(
      frames: ReadonlyArray<Frame>,
    ): Promise<RenderResult> {
      const view = render(<FrameHarness frames={frames} />);
      await settle();
      return view;
    }

    // Viewport 0..444, three 192px tabs. Initially A,B,C sit untransformed
    // (A 0..192, B 192..384, C 384..576, so only C is clipped). After the
    // reorder to A,C,B the final layout is A 0..192, C 192..384, B 384..576
    // (only B is clipped), while mid-flip the rendered rects are shifted by
    // the frames' transforms: C 264..456 (+72), B 312..504 (-72).
    function initialGeometry(): void {
      geometry.viewport = { left: 0, right: 444 };
      geometry.outerWidth = 444;
      geometry.scrollWidth = 576;
      geometry.tabs = {
        a: { left: 0, right: 192 },
        b: { left: 192, right: 384 },
        c: { left: 384, right: 576 },
      };
    }

    function midFlipGeometry(): void {
      geometry.tabs = {
        a: { left: 0, right: 192 },
        c: { left: 264, right: 456 },
        b: { left: 312, right: 504 },
      };
    }

    function settleGeometry(): void {
      geometry.tabs = {
        a: { left: 0, right: 192 },
        c: { left: 192, right: 384 },
        b: { left: 384, right: 576 },
      };
    }

    const ABC: ReadonlyArray<Frame> = [
      { id: "a", keys: ["a"], transform: "none" },
      { id: "b", keys: ["b"], transform: "none" },
      { id: "c", keys: ["c"], transform: "none" },
    ];

    function reorderedFrames(
      cTransform: string,
      bTransform: string,
    ): ReadonlyArray<Frame> {
      return [
        { id: "a", keys: ["a"], transform: "none" },
        { id: "c", keys: ["c"], transform: cTransform },
        { id: "b", keys: ["b"], transform: bTransform },
      ];
    }

    it.each([
      { name: "2D", c: TRANSLATE_72, b: TRANSLATE_MINUS_72 },
      { name: "3D", c: TRANSLATE_72_3D, b: TRANSLATE_MINUS_72_3D },
    ])(
      "hides only the tab clipped in its final layout, mid-flip and after it settles ($name matrix)",
      async ({ c, b }) => {
        initialGeometry();
        const view = await mountFrames(ABC);
        expect(hidden()).toBe("|c");

        midFlipGeometry();
        view.rerender(<FrameHarness frames={reorderedFrames(c, b)} />);
        await settle();
        expect(hidden()).toBe("|b");

        // Only the transforms settle: same children, no resize, scroll or
        // selection change.
        settleGeometry();
        view.rerender(
          <FrameHarness frames={reorderedFrames("none", "none")} />,
        );
        await settle();
        expect(hidden()).toBe("|b");
      },
    );

    it("keeps member offsets when split members share one translated frame", async () => {
      geometry.viewport = { left: 0, right: 444 };
      geometry.outerWidth = 444;
      geometry.scrollWidth = 576;
      // Frame translated +72: members rendered 264..456 and 456..648, final
      // 192..384 and 384..576.
      geometry.tabs = {
        x: { left: 264, right: 456 },
        y: { left: 456, right: 648 },
      };
      await mountFrames([
        { id: "split", keys: ["x", "y"], transform: TRANSLATE_72 },
      ]);
      expect(hidden()).toBe("|y");
    });

    it("keeps tabs without a frame working", async () => {
      // The plain harness renders bare buttons with no [data-strip-item-id].
      await mount("scroll", ["a", "b", "c", "d"]);
      expect(hidden()).toBe("a|d");
    });

    it("snapshots active visibility by its final position, so a later shrink reveals it", async () => {
      initialGeometry();
      midFlipGeometry();
      activeKey = "c";
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      await mountFrames(reorderedFrames(TRANSLATE_72, TRANSLATE_MINUS_72));
      // Rendered 264..456 looks clipped, but C's final 192..384 is visible.
      scroll.mockClear();
      geometry.outerWidth = 360;
      await fireResize();
      expect(scroll).toHaveBeenCalled();
      for (const context of scroll.mock.contexts) {
        expect(context).toBe(screen.getByText("c"));
      }
    });
  });

  describe("frame batching and the bounds cache", () => {
    it("coalesces resize and scroll signals into one measurement per frame", async () => {
      await mount("scroll", ["a", "b", "c", "d"]);
      const rectSpy = vi.spyOn(
        screen.getByTestId("viewport"),
        "getBoundingClientRect",
      );
      rectSpy.mockClear();
      geometry.scrollLeft = 20;
      act(() => {
        for (const observer of resizeObservers) observer.trigger();
        fireEvent.scroll(screen.getByTestId("viewport"));
      });
      // Two distinct signal sources, still exactly one pending frame, and no
      // measurement has actually run yet.
      expect(rafCallbacks.size).toBe(1);
      expect(rectSpy).not.toHaveBeenCalled();
      await settle();
      // Coalesced into exactly one measurement pass, not one per signal.
      expect(rectSpy).toHaveBeenCalledTimes(1);
      expect(hidden()).toBe("a|");
    });

    it("tracks a selection-only change from the cached bounds, reading no tab rects and re-subscribing nothing", async () => {
      activeKey = "a";
      const view = await mount("scroll", ["a", "b", "c", "d"]);
      expect(hidden()).toBe("a|d");
      const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
      const observeSpy = vi.spyOn(
        ControllableResizeObserver.prototype,
        "observe",
      );
      const revealSpy = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      rectSpy.mockClear();
      observeSpy.mockClear();
      revealSpy.mockClear();
      activeKey = "b";
      view.rerender(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
      await settle();
      const tabRectReads = rectSpy.mock.instances.filter(
        (instance) =>
          instance instanceof HTMLElement &&
          instance.dataset.headerTabKey !== undefined,
      );
      expect(tabRectReads).toEqual([]);
      expect(observeSpy).not.toHaveBeenCalled();
      // The cache is reused, but the newly-selected tab is still revealed.
      expect(revealSpy).toHaveBeenCalledTimes(1);
      expect(revealSpy.mock.contexts[0]).toBe(screen.getByText("b"));
      // The membership list is unaffected - only the active-tab tracking ran.
      expect(hidden()).toBe("a|d");
    });

    it("invalidates cached bounds on a tab identity change without re-subscribing resize targets", async () => {
      await mount("scroll", ["a", "b", "c", "d"]);
      expect(hidden()).toBe("a|d");
      const observeSpy = vi.spyOn(
        ControllableResizeObserver.prototype,
        "observe",
      );
      observeSpy.mockClear();
      geometry.tabs.e = geometry.tabs.d;
      act(() => {
        screen.getByText("d").setAttribute("data-header-tab-key", "e");
      });
      await settle();
      expect(hidden()).toBe("a|e");
      expect(observeSpy).not.toHaveBeenCalled();
    });
  });

  describe("active tab reveal regressions (W1-A review)", () => {
    /**
     * `scrollIntoView` has no real layout to act on in jsdom, so it must be a
     * fake with a real side effect: it nudges `geometry.scrollLeft` just
     * enough to bring the target's box (found via `boxFor`) into the CURRENT
     * viewport, exactly like a real "nearest" scroll would. Both regressions
     * below hinge on whether that side effect is correctly trusted (or
     * re-triggered) by the next measurement pass.
     */
    function installNearestScrollMock(
      boxFor: (element: HTMLElement) => Box | undefined,
    ): MockInstance<Element["scrollIntoView"]> {
      return vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(function (this: Element) {
          if (!(this instanceof HTMLElement)) return;
          const box = boxFor(this);
          if (box === undefined) return;
          const viewportWidth =
            geometry.viewport.right - geometry.viewport.left;
          if (box.left < geometry.scrollLeft) {
            geometry.scrollLeft = box.left;
          } else if (box.right > geometry.scrollLeft + viewportWidth) {
            geometry.scrollLeft = box.right - viewportWidth;
          }
        });
    }

    it("re-reveals the active tab after opening it overflows a fitting strip and edge controls narrow the viewport", async () => {
      geometry.outerWidth = 300;
      geometry.controlWidth = 40;
      geometry.viewport = { left: 0, right: 300 };
      geometry.scrollWidth = 200;
      geometry.tabs = {
        a: { left: 0, right: 100 },
        b: { left: 100, right: 200 },
      };
      activeKey = null;
      const view = await mount("scroll", ["a", "b"]);
      expect(hidden()).toBe("|");

      const scrollSpy = installNearestScrollMock((element) => {
        const key = element.dataset.headerTabKey;
        return key === undefined ? undefined : geometry.tabs[key];
      });
      scrollSpy.mockClear();

      // Open a new, wide, LAST tab and select it in the same update - this is
      // what makes a previously-fitting strip overflow for the first time.
      geometry.tabs.c = { left: 200, right: 320 };
      geometry.scrollWidth = 320;
      activeKey = "c";
      view.rerender(<Harness layout="scroll" keys={["a", "b", "c"]} />);
      await settle();

      // First measurement: overflow just detected, using the OLD (full,
      // control-free) viewport. The reveal lands 'c' exactly at that edge.
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(geometry.scrollLeft).toBe(20);
      expect(controlCount()).toBe(2);

      // Mounting the two edge controls narrows the strip's own rendered box -
      // a real ResizeObserver would report this on the next frame.
      geometry.viewport = { left: 0, right: 220 };
      await fireResize();

      // 'c' is genuinely clipped again by the narrower viewport. The hook
      // must re-reveal it rather than trust a visibility snapshot that was
      // taken before the first scroll's effect had actually landed.
      expect(scrollSpy).toHaveBeenCalledTimes(2);
      expect(geometry.scrollLeft).toBe(100);
    });

    it("re-reveals when the selected tab identity moves to a different, stable DOM control (split-side reversal)", async () => {
      // A split's two members are stable nodes - "left slot" / "right slot" -
      // that never remount. A reversal swaps which tab key and selection
      // state each slot carries; the string active key can stay identical
      // while the physically-selected control changes.
      function SplitHarness(props: {
        readonly left: { readonly key: string; readonly selected: boolean };
        readonly right: { readonly key: string; readonly selected: boolean };
      }) {
        const { setScrollElement, hiddenTabKeys, hasOverflow } =
          useHiddenHeaderTabs("scroll");
        return (
          <div>
            <div ref={setScrollElement} data-testid="viewport">
              <button
                key="left-slot"
                type="button"
                role="tab"
                data-slot="left"
                data-header-tab-key={props.left.key}
                aria-selected={props.left.selected}
              >
                {props.left.key}
              </button>
              <button
                key="right-slot"
                type="button"
                role="tab"
                data-slot="right"
                data-header-tab-key={props.right.key}
                aria-selected={props.right.selected}
              >
                {props.right.key}
              </button>
            </div>
            {hasOverflow ? (
              <>
                <span data-hidden-tabs-control="left" />
                <span data-hidden-tabs-control="right" />
              </>
            ) : null}
            <output data-testid="hidden">
              {hiddenTabKeys.left.join(",")}|{hiddenTabKeys.right.join(",")}
            </output>
          </div>
        );
      }

      geometry.outerWidth = 240;
      geometry.controlWidth = 20;
      geometry.viewport = { left: 0, right: 200 };
      geometry.scrollWidth = 400;
      // Physical slot positions - fixed for the whole test, unlike the
      // headerTabKey-keyed `geometry.tabs` used elsewhere in this file.
      const slotBoxes: Record<string, Box> = {
        left: { left: 0, right: 100 },
        right: { left: 300, right: 400 },
      };
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement): DOMRect {
          if (this.dataset.testid === "viewport")
            return rect(geometry.viewport);
          const slot = this.dataset.slot;
          const box = slot === undefined ? undefined : slotBoxes[slot];
          if (box === undefined) return rect({ left: 0, right: 0 });
          return rect({
            left: box.left - geometry.scrollLeft,
            right: box.right - geometry.scrollLeft,
          });
        });
      const scrollSpy = installNearestScrollMock((element) => {
        const slot = element.dataset.slot;
        return slot === undefined ? undefined : slotBoxes[slot];
      });

      const view = render(
        <SplitHarness
          left={{ key: "x", selected: true }}
          right={{ key: "y", selected: false }}
        />,
      );
      await settle();
      // Selected left member ('x') visible; right member ('y') offscreen.
      expect(hidden()).toBe("|y");
      scrollSpy.mockClear();

      // Reverse views: the selected tab identity ('x') moves onto the RIGHT
      // (offscreen) physical slot; 'y' takes the left, visible slot. Neither
      // the string active key nor the viewport width changes.
      view.rerender(
        <SplitHarness
          left={{ key: "y", selected: false }}
          right={{ key: "x", selected: true }}
        />,
      );
      await settle();

      expect(hidden()).toBe("|x");
      // The selected tab is now genuinely offscreen and must be re-revealed,
      // even though its string key never changed.
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(geometry.scrollLeft).toBe(200);

      rectSpy.mockRestore();
    });
  });
});
