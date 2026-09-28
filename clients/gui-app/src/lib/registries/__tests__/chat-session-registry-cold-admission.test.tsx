import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setTabCycleRepeating } from "@/lib/keybindings/tab-cycle-activity";
import { COLD_ADMISSION_SETTLE_MS } from "@/lib/registries/cold-admission";
import { useChatPrewarmEligible } from "@/lib/registries/chat-prewarm";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ChatStreamClientFactory,
} from "@/stores/chats/chat-session-store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  CHAT_A,
  SPEC_A,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { getProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";

// W3-A cold-open admission timing. Reuses the lighter override-factory seam
// (`__setChatStreamClientFactoryForTests`) rather than
// `chat-session-registry.test.tsx`'s full HostClient/MockHostMessenger rig,
// which exists for owner-identity discrimination this suite never exercises.

// Hoisted: the mock factories below read these before the module's own
// top-level `const`s would otherwise be initialized.
const { EPIC_ID, HOST_ID, USER_ID } = vi.hoisted(() => ({
  EPIC_ID: "epic-1",
  HOST_ID: "host-cold-admission",
  USER_ID: "user-cold-admission",
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => EPIC_ID,
}));

const visibility = vi.hoisted(() => ({
  paneVisible: true,
  tabSelected: true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => visibility.paneVisible,
}));
vi.mock("@/components/epic-canvas/canvas/tab-body-selected-context", () => ({
  useTabBodySelected: () => visibility.tabSelected,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({
    hostId: HOST_ID,
    label: "Test host",
    kind: "local" as const,
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: "1.0.0",
    transportDialability: "dialable" as const,
  }),
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLease: () => null,
}));

// Only needs to satisfy the hook's top-level calls: the stream itself is
// driven through `__setChatStreamClientFactoryForTests` below.
vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => HOST_ID,
    getActiveHost: () => null,
    getRequestContextUserId: () => USER_ID,
    onChange: () => () => undefined,
  }),
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

// Never called under the override; throwing turns a regression that bypasses
// it into a hard failure instead of a silent real dial under jsdom. A stable
// module-level function: the real hook's factory is referentially stable and
// the acquisition effect depends on it, so a fresh one per render would
// re-run that effect on every render.
function throwIfTransportOpened(): never {
  throw new Error("test: openTransport must not be called under the override");
}
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => throwIfTransportOpened,
}));

import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";

function QueryWrapper(props: { readonly children: ReactNode }): ReactNode {
  // Stable across this component instance's rerenders, matching the real
  // app's provider: a fresh client every render would also destabilize
  // `useQueryClient()`, another of the acquisition effect's dependencies.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function StrictWrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <QueryWrapper {...props} />
    </StrictMode>
  );
}

describe("useChatSessionHandle cold-open admission (W3-A)", () => {
  let streamFactorySpy: Mock<ChatStreamClientFactory>;

  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: USER_ID,
        userName: USER_ID,
        email: `${USER_ID}@example.com`,
      },
    });
    visibility.paneVisible = true;
    visibility.tabSelected = true;
    setTabCycleRepeating(false);
    streamFactorySpy = vi.fn<ChatStreamClientFactory>(() => ({
      sendAction: () => undefined,
      close: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
    }));
    __setChatStreamClientFactoryForTests(streamFactorySpy);
  });

  afterEach(() => {
    cleanup();
    setTabCycleRepeating(false);
    __setChatStreamClientFactoryForTests(null);
    disposeAllChatSessions();
    useAuthStore.setState({ profile: null, status: "signed-out" });
  });

  it("admits nothing while cycling through many cold chats, then admits exactly the final one once settled", () => {
    vi.useFakeTimers();
    try {
      setTabCycleRepeating(true);
      const { rerender } = renderHook(
        ({ chatId }: { chatId: string }) =>
          useChatSessionHandle(chatId, HOST_ID, true, "surface"),
        { wrapper: QueryWrapper, initialProps: { chatId: "chat-0" } },
      );

      for (let index = 1; index <= 9; index += 1) {
        act(() => {
          vi.advanceTimersByTime(50);
        });
        act(() => {
          rerender({ chatId: `chat-${index}` });
        });
      }
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(streamFactorySpy).not.toHaveBeenCalled();

      // Settle: no further activity for the remaining window.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(streamFactorySpy).toHaveBeenCalledTimes(1);
      expect(streamFactorySpy).toHaveBeenCalledWith(
        EPIC_ID,
        "chat-9",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits immediately on a single non-repeat open", () => {
    setTabCycleRepeating(false);
    renderHook(
      () => useChatSessionHandle("chat-solo", HOST_ID, true, "surface"),
      {
        wrapper: QueryWrapper,
      },
    );

    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(streamFactorySpy).toHaveBeenCalledWith(
      EPIC_ID,
      "chat-solo",
      expect.anything(),
    );
  });

  it("commits the final target once when repeat ends in the same update, never acquiring a stale intermediate target", () => {
    setTabCycleRepeating(true);
    const { rerender } = renderHook(
      ({ chatId }: { chatId: string }) =>
        useChatSessionHandle(chatId, HOST_ID, true, "surface"),
      { wrapper: QueryWrapper, initialProps: { chatId: "chat-a" } },
    );

    act(() => {
      rerender({ chatId: "chat-b" });
    });
    expect(streamFactorySpy).not.toHaveBeenCalled();

    // Keyup: final target and `repeating: false` land in one React update.
    act(() => {
      rerender({ chatId: "chat-final" });
      setTabCycleRepeating(false);
    });

    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(streamFactorySpy).toHaveBeenCalledWith(
      EPIC_ID,
      "chat-final",
      expect.anything(),
    );
  });

  it("reacquires a warm, already-presented chat on keyup after a repeat-time remount, without advancing the settle timer or rebuilding its transport", () => {
    setTabCycleRepeating(false);
    const first = renderHook(
      () => useChatSessionHandle("chat-warm", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );
    expect(first.result.current).not.toBeNull();
    const handle = first.result.current;
    if (handle === null) throw new Error("expected a handle");
    __getChatSessionRegistryForTests().markPresented(handle);
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);

    // Not transient anymore, so closing the tab parks it warm.
    first.unmount();
    expect(
      __getChatSessionRegistryForTests().peek(EPIC_ID, "chat-warm", HOST_ID),
    ).toBe(handle);

    // A brand-new mount is not "this mount's own warm handle", even though
    // the registry already has one - it is paced like any other cold body,
    // not exempted by someone else's warmth.
    setTabCycleRepeating(true);
    const second = renderHook(
      () => useChatSessionHandle("chat-warm", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );
    expect(second.result.current).toBeNull();
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);

    // Keyup lands admission at once - no 150ms wait needed - and the registry
    // hands back the SAME warm store: no second transport.
    act(() => {
      setTabCycleRepeating(false);
    });
    expect(second.result.current).toBe(handle);
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
  });

  it("clears a stale handle the instant its identity changes mid-repeat, before the new target's deferred admission ever runs", () => {
    setTabCycleRepeating(false);
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string }) =>
        useChatSessionHandle(chatId, HOST_ID, true, "surface"),
      { wrapper: QueryWrapper, initialProps: { chatId: "chat-x" } },
    );
    expect(result.current).not.toBeNull();
    const handleX = result.current;
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);

    // Mid-repeat, the caller swaps to a different, never-opened chat. Its
    // admission is deferred (cold + repeating), but the OLD chat's handle
    // must not linger on screen in the meantime.
    act(() => {
      setTabCycleRepeating(true);
    });
    act(() => {
      rerender({ chatId: "chat-y" });
    });

    expect(result.current).toBeNull();
    expect(result.current).not.toBe(handleX);
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending cold admission when the tab is hidden mid-repeat, rather than merely delaying it", () => {
    vi.useFakeTimers();
    try {
      setTabCycleRepeating(true);
      const { rerender } = renderHook(
        () => useChatSessionHandle("chat-hidden", HOST_ID, true, "surface"),
        { wrapper: QueryWrapper },
      );

      act(() => {
        vi.advanceTimersByTime(80);
      });
      act(() => {
        visibility.paneVisible = false;
        rerender();
      });

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(streamFactorySpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("under StrictMode double-invoked effects, acquires exactly once", async () => {
    setTabCycleRepeating(false);
    const { result } = renderHook(
      () => useChatSessionHandle("chat-strict", HOST_ID, true, "surface"),
      { wrapper: StrictWrapper },
    );

    // The queued microtask decrement lets the surviving setup pass join.
    await act(async () => {
      await Promise.resolve();
    });

    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  it("a startup prewarm and a tile mounting the same chat/host key open exactly one stream, one registry entry, and one byte-accounting entry", () => {
    // `registry.acquire`'s scope-key dedup must hold ACROSS demand kinds, not
    // just between two "surface" mounts (already covered in
    // chat-session-registry.test.tsx).
    setTabCycleRepeating(false);
    const chatWindows = getProcessMemoryRuntime().chatWindows;
    const sessionCountBefore = chatWindows.sessionCount();
    const startup = renderHook(
      () =>
        useChatSessionHandle("chat-startup-and-tile", HOST_ID, true, "startup"),
      { wrapper: QueryWrapper },
    );
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    const startupHandle = startup.result.current;
    if (startupHandle === null) throw new Error("expected a handle");

    const tile = renderHook(
      () =>
        useChatSessionHandle("chat-startup-and-tile", HOST_ID, true, "surface"),
      { wrapper: QueryWrapper },
    );

    // One stream, one registry entry, one new chatWindows accounting entry.
    expect(streamFactorySpy).toHaveBeenCalledTimes(1);
    expect(tile.result.current).toBe(startupHandle);
    expect(__getChatSessionRegistryForTests().size()).toBe(1);
    expect(
      __getChatSessionRegistryForTests().peek(
        EPIC_ID,
        "chat-startup-and-tile",
        HOST_ID,
      ),
    ).toBe(startupHandle);
    expect(chatWindows.sessionCount() - sessionCountBefore).toBe(1);
  });

  it("earns presented status after 150ms continuously visible with a loaded snapshot, with no manual markPresented", () => {
    vi.useFakeTimers();
    try {
      setTabCycleRepeating(false);
      const { result } = renderHook(
        () =>
          useChatSessionHandle(
            "chat-earns-presented",
            HOST_ID,
            true,
            "surface",
          ),
        { wrapper: QueryWrapper },
      );
      const handle = result.current;
      if (handle === null) throw new Error("expected a handle");
      const registry = __getChatSessionRegistryForTests();
      expect(registry.isTransient(handle)).toBe(true);

      act(() => {
        handle.store.setState({ snapshotLoaded: true });
      });
      act(() => {
        vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS - 1);
      });
      expect(registry.isTransient(handle)).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(registry.isTransient(handle)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("retained-hidden prewarm queue (W4 R-A)", () => {
    it("acquires a cold retained-hidden body after the settle window, non-transient", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false; // retained sibling, not the pane's front tab
        const { result } = renderHook(
          () =>
            useChatSessionHandle("chat-hidden-cold", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        expect(result.current).toBeNull();
        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS - 1);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        expect(streamFactorySpy).toHaveBeenCalledWith(
          EPIC_ID,
          "chat-hidden-cold",
          expect.anything(),
        );
        expect(result.current).not.toBeNull();
        const handle = result.current;
        if (handle === null) throw new Error("expected a handle");
        expect(__getChatSessionRegistryForTests().isTransient(handle)).toBe(
          false,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("acquires a visible foreground chat immediately while a hidden retained neighbour only queues", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = true;
        const foreground = renderHook(
          () =>
            useChatSessionHandle("chat-foreground", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        expect(streamFactorySpy).toHaveBeenCalledWith(
          EPIC_ID,
          "chat-foreground",
          expect.anything(),
        );
        expect(foreground.result.current).not.toBeNull();

        // A retained sibling in the same, visible pane - merely queued.
        visibility.tabSelected = false;
        renderHook(
          () =>
            useChatSessionHandle("chat-neighbour", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(2);
        expect(streamFactorySpy).toHaveBeenLastCalledWith(
          EPIC_ID,
          "chat-neighbour",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("blocks hidden acquisition while tab-cycle repeats, cancels an in-flight timer the instant a repeat starts, and restarts the full settle window on keyup", () => {
      vi.useFakeTimers();
      try {
        setTabCycleRepeating(false);
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        renderHook(
          () => useChatSessionHandle("chat-repeat-a", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );

        // A repeat starting mid-settle cancels the pending timer synchronously.
        act(() => {
          vi.advanceTimersByTime(80);
        });
        act(() => {
          setTabCycleRepeating(true);
        });
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        // A second retained body queues while still repeating - no timer starts.
        renderHook(
          () => useChatSessionHandle("chat-repeat-b", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        // Keyup restarts the settle window from a full 150ms, not from
        // wherever the cancelled timer left off.
        act(() => {
          setTabCycleRepeating(false);
        });
        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS - 1);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("paces multiple queued hidden acquisitions one per settle interval, same-pane siblings before hidden top-level pane bodies", () => {
      vi.useFakeTimers();
      try {
        setTabCycleRepeating(false);

        // A hidden TOP-LEVEL pane body, queued first.
        visibility.paneVisible = false;
        visibility.tabSelected = true;
        renderHook(
          () =>
            useChatSessionHandle("chat-other-pane", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        // Same-pane retained siblings, queued after.
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        renderHook(
          () =>
            useChatSessionHandle("chat-sibling-1", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );
        renderHook(
          () =>
            useChatSessionHandle("chat-sibling-2", HOST_ID, true, "surface"),
          {
            wrapper: QueryWrapper,
          },
        );

        expect(streamFactorySpy).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        expect(streamFactorySpy).toHaveBeenNthCalledWith(
          1,
          EPIC_ID,
          "chat-sibling-1",
          expect.anything(),
        );

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(2);
        expect(streamFactorySpy).toHaveBeenNthCalledWith(
          2,
          EPIC_ID,
          "chat-sibling-2",
          expect.anything(),
        );

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(3);
        expect(streamFactorySpy).toHaveBeenNthCalledWith(
          3,
          EPIC_ID,
          "chat-other-pane",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a queued hidden prewarm on unmount before it settles", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        const hidden = renderHook(
          () =>
            useChatSessionHandle("chat-cancel-me", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(80);
        });
        hidden.unmount();

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();
        expect(
          __getChatSessionRegistryForTests().peek(
            EPIC_ID,
            "chat-cancel-me",
            HOST_ID,
          ),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels every queued hidden prewarm on session-wide disposal, so a stale timer cannot recreate a session after logout", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        renderHook(
          () =>
            useChatSessionHandle("chat-logout-race", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(80);
        });
        act(() => {
          disposeAllChatSessions();
        });

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(streamFactorySpy).not.toHaveBeenCalled();
        expect(
          __getChatSessionRegistryForTests().peek(
            EPIC_ID,
            "chat-logout-race",
            HOST_ID,
          ),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reuses an already-prewarmed hidden session when it becomes visible, without rebuilding its transport", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        const { result, rerender } = renderHook(
          () => useChatSessionHandle("chat-reuse", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        const prewarmedHandle = result.current;
        if (prewarmedHandle === null) throw new Error("expected a handle");
        expect(
          __getChatSessionRegistryForTests().isTransient(prewarmedHandle),
        ).toBe(false);

        // A repeat starting while still hidden must not re-queue this
        // already-mounted retained handle behind the hidden prewarm pacer.
        visibility.tabSelected = false;
        act(() => {
          setTabCycleRepeating(true);
          rerender();
        });
        expect(result.current).toBe(prewarmedHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(result.current).toBe(prewarmedHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        // The tab becomes the pane's front tab, still mid-repeat.
        visibility.tabSelected = true;
        act(() => {
          rerender();
        });

        expect(result.current).toBe(prewarmedHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears a hidden neighbour's retained handle when the registry evicts it under byte pressure, and only requeues on the next repeat-settle edge, not immediately", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = false;
        const { result, rerender } = renderHook(
          () =>
            useChatSessionHandle(
              "chat-neighbour-evict",
              HOST_ID,
              true,
              "surface",
            ),
          { wrapper: QueryWrapper },
        );

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        const prewarmedHandle = result.current;
        if (prewarmedHandle === null) throw new Error("expected a handle");

        // Hidden acquires are marked presented and released immediately, so
        // this is a lease-free warm entry - evictable like any other.
        const registry = __getChatSessionRegistryForTests();
        expect(registry.isTransient(prewarmedHandle)).toBe(false);

        act(() => {
          expect(registry.evictOldestEligibleForByteBudget()).toBe(true);
        });
        expect(
          registry.peek(EPIC_ID, "chat-neighbour-evict", HOST_ID),
        ).toBeNull();
        expect(result.current).toBeNull();

        // Not immediate: nothing re-queues until an effect dependency changes.
        act(() => {
          vi.advanceTimersByTime(5_000);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        // A repeat-settle edge re-runs the effect and requeues it.
        act(() => {
          setTabCycleRepeating(true);
          rerender();
        });
        act(() => {
          setTabCycleRepeating(false);
          rerender();
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(streamFactorySpy).toHaveBeenCalledTimes(2);
        expect(streamFactorySpy).toHaveBeenLastCalledWith(
          EPIC_ID,
          "chat-neighbour-evict",
          expect.anything(),
        );
        expect(result.current).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("useChatPrewarmEligible (W4 R-A nearest-neighbour + repeat)", () => {
    const VIEW_TAB_ID = "view-tab-prewarm";
    const PANE_ID = "pane-prewarm";
    const ACTIVE_INSTANCE_ID = "inst-active-nonchat";
    const NEAR_CHAT_INSTANCE_ID = "inst-chat-near";
    const FAR_CHAT_INSTANCE_ID = "inst-chat-far";

    let ownedHandles: ChatSessionStoreHandle[] = [];

    function makeHandle(chatId: string): ChatSessionStoreHandle {
      const handle = createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      });
      ownedHandles.push(handle);
      return handle;
    }

    beforeEach(() => {
      // One pane: a non-chat active tab in front, a chat visited most
      // recently before it (the nearest hidden neighbour), and an older
      // retained chat further back in the MRU history.
      useEpicCanvasStore.setState({
        canvasByTabId: {
          [VIEW_TAB_ID]: {
            root: {
              kind: "pane",
              id: PANE_ID,
              tabInstanceIds: [
                ACTIVE_INSTANCE_ID,
                NEAR_CHAT_INSTANCE_ID,
                FAR_CHAT_INSTANCE_ID,
              ],
              activeTabId: ACTIVE_INSTANCE_ID,
              previewTabId: null,
              activationHistory: [
                ACTIVE_INSTANCE_ID,
                NEAR_CHAT_INSTANCE_ID,
                FAR_CHAT_INSTANCE_ID,
              ],
            },
            activePaneId: PANE_ID,
            tilesByInstanceId: {
              [ACTIVE_INSTANCE_ID]: {
                ...SPEC_A,
                instanceId: ACTIVE_INSTANCE_ID,
              },
              [NEAR_CHAT_INSTANCE_ID]: {
                ...CHAT_A,
                instanceId: NEAR_CHAT_INSTANCE_ID,
              },
              [FAR_CHAT_INSTANCE_ID]: {
                ...CHAT_A,
                instanceId: FAR_CHAT_INSTANCE_ID,
              },
            },
            sizesByGroupId: {},
          },
        },
      });
    });

    afterEach(() => {
      useEpicCanvasStore.setState({ canvasByTabId: {} });
      for (const handle of ownedHandles) handle.dispose();
      ownedHandles = [];
    });

    it("prepares a fresh, already-nearest handle only after its own settle window - a warm handle is not exempt", () => {
      vi.useFakeTimers();
      try {
        const nearHandle = makeHandle("chat-near");
        visibility.paneVisible = true;
        setTabCycleRepeating(false);

        const { result } = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            nearHandle,
          ),
        );
        expect(result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS - 1);
        });
        expect(result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(result.current).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("only the nearest hidden chat ever prepares; an older retained sibling never does", () => {
      vi.useFakeTimers();
      try {
        const nearHandle = makeHandle("chat-near");
        const farHandle = makeHandle("chat-far");
        visibility.paneVisible = true;
        setTabCycleRepeating(false);

        const near = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            nearHandle,
          ),
        );
        const far = renderHook(() =>
          useChatPrewarmEligible(VIEW_TAB_ID, FAR_CHAT_INSTANCE_ID, farHandle),
        );

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(near.result.current).toBe(true);
        expect(far.result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(far.result.current).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a not-yet-settled preparation the instant a repeat starts, then - once already prepared - pauses and instantly resumes across a later repeat, all on the same mounted hook", () => {
      vi.useFakeTimers();
      try {
        const nearHandle = makeHandle("chat-near");
        visibility.paneVisible = true;
        setTabCycleRepeating(false);

        const { result } = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            nearHandle,
          ),
        );
        expect(result.current).toBe(false);

        // A repeat starting mid-settle cancels the pending preparation.
        act(() => {
          vi.advanceTimersByTime(80);
        });
        act(() => {
          setTabCycleRepeating(true);
        });
        expect(result.current).toBe(false);
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(result.current).toBe(false);

        // Keyup: never having prepared, it needs a full fresh settle.
        act(() => {
          setTabCycleRepeating(false);
        });
        expect(result.current).toBe(false);
        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS - 1);
        });
        expect(result.current).toBe(false);
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(result.current).toBe(true);

        // Now genuinely prepared. A later repeat merely PAUSES it - no
        // pending timer to cancel, no re-settle needed on the way back.
        act(() => {
          setTabCycleRepeating(true);
        });
        expect(result.current).toBe(false);

        act(() => {
          setTabCycleRepeating(false);
        });
        expect(result.current).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a warm session moved from a visible tile to a hidden remount reuses its transport with no second factory call, and its row preparation still needs its own settle", () => {
      vi.useFakeTimers();
      try {
        visibility.paneVisible = true;
        visibility.tabSelected = true;
        const visibleMount = renderHook(
          () =>
            useChatSessionHandle("chat-warm-remount", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);
        const warmHandle = visibleMount.result.current;
        if (warmHandle === null) throw new Error("expected a handle");

        // Earn non-transient ("presented") status while still visible, so
        // the unmount below releases synchronously instead of deferring to
        // a microtask.
        act(() => {
          warmHandle.store.setState({ snapshotLoaded: true });
        });
        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(__getChatSessionRegistryForTests().isTransient(warmHandle)).toBe(
          false,
        );

        visibleMount.unmount();
        expect(
          __getChatSessionRegistryForTests().peek(
            EPIC_ID,
            "chat-warm-remount",
            HOST_ID,
          ),
        ).toBe(warmHandle);

        // Hidden remount of the SAME warm chat: this new mount does not own
        // the handle yet, so its BODY acquisition is still paced through the
        // hidden prewarm queue - reusing the warm store costs a settle
        // window, even though it needs no second transport.
        visibility.tabSelected = false;
        const hiddenMount = renderHook(
          () =>
            useChatSessionHandle("chat-warm-remount", HOST_ID, true, "surface"),
          { wrapper: QueryWrapper },
        );
        expect(hiddenMount.result.current).toBeNull();
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS);
        });
        expect(hiddenMount.result.current).toBe(warmHandle);
        expect(streamFactorySpy).toHaveBeenCalledTimes(1);

        // The BODY still has to earn its own preparation - warmth on the
        // session plane buys it nothing on the row-rendering plane.
        setTabCycleRepeating(false);
        const eligible = renderHook(() =>
          useChatPrewarmEligible(
            VIEW_TAB_ID,
            NEAR_CHAT_INSTANCE_ID,
            warmHandle,
          ),
        );
        expect(eligible.result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(COLD_ADMISSION_SETTLE_MS - 1);
        });
        expect(eligible.result.current).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(eligible.result.current).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
