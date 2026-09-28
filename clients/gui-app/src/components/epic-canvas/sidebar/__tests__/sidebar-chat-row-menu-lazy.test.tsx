/**
 * Chat/artifact row menus: `LazyDropdownMenu` per row, one shared
 * `SidebarTreeContextMenu` root for the tree. Real primitives, except
 * call-through mount-count spies on `ContextMenu`/`DropdownMenu` - Radix's
 * Root renders no DOM node, so counting mounts is the only way to observe it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useEffect, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { ArtifactTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-artifact-tree";
import {
  SidebarBulkSelectionProvider,
  useSidebarBulkSelection,
  type SidebarBulkSelectionPanelId,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";

// Same faked boundary as the churn/Motion suites: no host.
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});

const OWNER_PR_REFERENCES = vi.hoisted(() =>
  Object.freeze({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
);
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => OWNER_PR_REFERENCES,
}));

vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-host-notification-indicators-query")
      >();
    const { EMPTY_INDICATOR_STATE_RESPONSE } =
      await import("@/stores/notifications/notification-indicator-state");
    const frozen = {
      data: EMPTY_INDICATOR_STATE_RESPONSE,
      isPending: false,
      isFetching: false,
      error: null,
      refetch: (): Promise<void> => Promise.resolve(),
    } as const;
    return { ...actual, useHostNotificationIndicators: () => frozen };
  },
);

// Live (mount minus unmount) count of the REAL `ContextMenu`/`DropdownMenu`
// roots, call-through unchanged - a spy on the primitives, not a fake.
const contextMenuMounts = vi.hoisted(() => ({ current: 0 }));
vi.mock("@/components/ui/context-menu", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/context-menu")>();
  function CountedContextMenu(props: Parameters<typeof actual.ContextMenu>[0]) {
    useEffect(() => {
      contextMenuMounts.current += 1;
      return () => {
        contextMenuMounts.current -= 1;
      };
    }, []);
    return <actual.ContextMenu {...props} />;
  }
  return { ...actual, ContextMenu: CountedContextMenu };
});

const dropdownMenuMounts = vi.hoisted(() => ({ current: 0 }));
vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/dropdown-menu")>();
  function CountedDropdownMenu(
    props: Parameters<typeof actual.DropdownMenu>[0],
  ) {
    useEffect(() => {
      dropdownMenuMounts.current += 1;
      return () => {
        dropdownMenuMounts.current -= 1;
      };
    }, []);
    return <actual.DropdownMenu {...props} />;
  }
  return { ...actual, DropdownMenu: CountedDropdownMenu };
});

const EPIC_ID = "epic-row-menu-lazy";
const TAB_ID = "tab-row-menu-lazy";
const USER_ID = "user-1";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Row menu lazy",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function chatEntry(
  id: string,
  title: string,
  parentId: string | null,
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", title);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("hostId", "host-a");
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function artifactEntry(
  id: string,
  title: string,
  parentId: string | null,
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("kind", "spec");
  entry.set("title", title);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  return entry;
}

interface RowSeed {
  readonly id: string;
  readonly parentId: string | null;
}

/** Flat root rows, no nesting - the common case. */
function flatRows(ids: readonly string[]): ReadonlyArray<RowSeed> {
  return ids.map((id) => ({ id, parentId: null }));
}

function seedDoc(
  rows: ReadonlyArray<RowSeed>,
  kind: "chats" | "artifacts",
): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chats = new Y.Map<unknown>();
  const artifacts = new Y.Map<unknown>();
  for (const row of rows) {
    if (kind === "chats") {
      chats.set(row.id, chatEntry(row.id, `Chat ${row.id}`, row.parentId));
    } else {
      artifacts.set(
        row.id,
        artifactEntry(row.id, `Artifact ${row.id}`, row.parentId),
      );
    }
  }
  epic.set("title", "Row menu lazy");
  epic.set("artifacts", artifacts);
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

function createSession(
  rows: ReadonlyArray<RowSeed>,
  kind: "chats" | "artifacts",
): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: USER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), seedDoc(rows, kind));
  return handle;
}

interface SelectionControls {
  readonly enterSelectionMode: () => void;
  readonly cancelSelection: () => void;
}

/** Captures selection-mode controls from inside the provider for the test to call. */
function SelectionModeEntry(props: {
  readonly onReady: (controls: SelectionControls) => void;
}) {
  const { enterSelectionMode, cancelSelection } = useSidebarBulkSelection();
  useEffect(() => {
    props.onReady({ enterSelectionMode, cancelSelection });
  }, [props, enterSelectionMode, cancelSelection]);
  return null;
}

/** The one thing that differs between the chat and artifact trees here. */
interface PanelFixture {
  readonly label: string;
  readonly panelId: SidebarBulkSelectionPanelId;
  readonly panel: ReactElement;
}

const CHAT_FIXTURE: PanelFixture = {
  label: "chat",
  panelId: "chats",
  panel: (
    <ChatTreePanelBody
      epicId={EPIC_ID}
      tabId={TAB_ID}
      messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
    />
  ),
};

const ARTIFACT_FIXTURE: PanelFixture = {
  label: "artifact",
  panelId: "artifacts",
  panel: <ArtifactTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />,
};

describe.each([CHAT_FIXTURE, ARTIFACT_FIXTURE])(
  "$label row menus are lazily mounted",
  (fixture) => {
    const opened: OpenedStoreForTest[] = [];
    const kind = fixture.panelId === "chats" ? "chats" : "artifacts";

    afterEach(() => {
      for (const handle of opened.splice(0)) handle.dispose();
      cleanup();
      contextMenuMounts.current = 0;
      dropdownMenuMounts.current = 0;
      useEpicSidebarExpansionStore.setState({
        userExpandedByScope: {},
        userCollapsedByScope: {},
      });
    });

    function renderSeededRows(
      rows: ReadonlyArray<RowSeed>,
    ): OpenedStoreForTest {
      const handle = createSession(rows, kind);
      opened.push(handle);
      render(
        <QueryClientProvider client={new QueryClient()}>
          <EpicSessionContext.Provider value={handle}>
            {fixture.panel}
          </EpicSessionContext.Provider>
        </QueryClientProvider>,
      );
      return handle;
    }

    function renderRows(ids: readonly string[]): void {
      renderSeededRows(flatRows(ids));
    }

    /** Under `StrictMode`, to exercise a cleanup effect's double-invoke. */
    function renderSeededRowsStrict(rows: ReadonlyArray<RowSeed>): void {
      const handle = createSession(rows, kind);
      opened.push(handle);
      render(
        <StrictMode>
          <QueryClientProvider client={new QueryClient()}>
            <EpicSessionContext.Provider value={handle}>
              {fixture.panel}
            </EpicSessionContext.Provider>
          </QueryClientProvider>
        </StrictMode>,
      );
    }

    it("mounts one context-menu root and no dropdown-menu roots before any interaction", () => {
      renderRows(["row-x", "row-y", "row-z"]);

      // Non-vacuity: three rows really rendered.
      expect(screen.getByTestId("epic-sidebar-item-row-x")).toBeTruthy();
      expect(screen.getByTestId("epic-sidebar-item-row-y")).toBeTruthy();
      expect(screen.getByTestId("epic-sidebar-item-row-z")).toBeTruthy();

      // One shared context-menu root for the whole tree, not one per row -
      // and no row's `LazyDropdownMenu` has armed a real `DropdownMenu`.
      expect(contextMenuMounts.current).toBe(1);
      expect(dropdownMenuMounts.current).toBe(0);
    });

    it("right-click on one row shows only that row's own actions", () => {
      renderRows(["row-x", "row-y"]);

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });

      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeTruthy();
      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-y"),
      ).toBeNull();
    });

    it("right-clicking a second row while the first's menu is open switches to only the second's actions", () => {
      renderRows(["row-x", "row-y"]);

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });
      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeTruthy();

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-y"));
      });

      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeNull();
      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-y"),
      ).toBeTruthy();
    });

    // Shift+F10 / the keyboard Menu key makes a real browser dispatch a native
    // `contextmenu` event at the focused element - jsdom does not synthesize
    // that translation from a keydown, so this dispatches the same terminal
    // native event a keyboard gesture would produce, directly.
    it("a keyboard-invoked context-menu gesture opens the row's real actions", () => {
      renderRows(["row-x"]);
      const row = screen.getByTestId("epic-sidebar-item-row-x");
      row.focus();

      act(() => {
        fireEvent.contextMenu(row);
      });

      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeTruthy();
    });

    it("does not reopen a stale menu for a row that unmounted and remounted, until a fresh gesture", () => {
      // StrictMode: the fix's cleanup effect must tell a real target unmount
      // from StrictMode's mount -> cleanup -> re-mount replay, or it would
      // spuriously clear (or fail to clear) state on the replay alone.
      renderSeededRowsStrict([
        { id: "row-p", parentId: null },
        { id: "row-x", parentId: "row-p" },
      ]);

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });
      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeTruthy();

      // Collapsing the parent unmounts its children synchronously (no exit
      // animation at that boundary) - row-x and its menu content are gone.
      act(() => {
        useEpicSidebarExpansionStore
          .getState()
          .collapse(TAB_ID, fixture.panelId, "row-p");
      });
      expect(screen.queryByTestId("epic-sidebar-item-row-x")).toBeNull();
      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeNull();

      act(() => {
        useEpicSidebarExpansionStore
          .getState()
          .expand(TAB_ID, fixture.panelId, "row-p");
      });

      // Non-vacuity: row-x is really back.
      expect(screen.getByTestId("epic-sidebar-item-row-x")).toBeTruthy();
      // Its menu must not reopen on its own - only a fresh gesture may.
      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeNull();

      // A fresh gesture must still open it normally - the row isn't left
      // broken by whatever cleared the stale state.
      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });
      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeTruthy();
    });

    it("does not reopen a stale menu for a row that entered and exited bulk-selection mode, until a fresh gesture", () => {
      const handle = createSession(flatRows(["row-x"]), kind);
      opened.push(handle);
      const selectionRef: { current: SelectionControls | null } = {
        current: null,
      };
      render(
        <QueryClientProvider client={new QueryClient()}>
          <EpicSessionContext.Provider value={handle}>
            <SidebarBulkSelectionProvider
              panelId={fixture.panelId}
              collapsed={false}
            >
              <SelectionModeEntry
                onReady={(controls) => (selectionRef.current = controls)}
              />
              {fixture.panel}
            </SidebarBulkSelectionProvider>
          </EpicSessionContext.Provider>
        </QueryClientProvider>,
      );
      const selection = selectionRef.current;
      if (selection === null)
        throw new Error("selection controls never captured");

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });
      expect(
        screen.getByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeTruthy();

      act(() => {
        selection.enterSelectionMode();
      });
      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeNull();

      act(() => {
        selection.cancelSelection();
      });

      // Non-vacuity: back out of selection mode.
      expect(screen.getByTestId("epic-sidebar-item-row-x")).toBeTruthy();
      // Its menu must not reopen on its own.
      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeNull();
    });

    it("a closed row's more-button carries no live dropdown-menu until armed", () => {
      renderRows(["row-x"]);

      const moreButton = screen.getByTestId("epic-sidebar-more-row-x");
      // Zero real `DropdownMenu` mounts, and the trigger button has not taken
      // on Radix's own `data-slot` (either would mean eager mounting).
      expect(dropdownMenuMounts.current).toBe(0);
      expect(moreButton.getAttribute("data-slot")).not.toBe(
        "dropdown-menu-trigger",
      );
    });

    it("pointer-down arms the more-button and opens this row's real actions", () => {
      renderRows(["row-x", "row-y"]);

      act(() => {
        fireEvent.pointerDown(screen.getByTestId("epic-sidebar-more-row-x"), {
          button: 0,
        });
      });

      expect(screen.getByTestId("epic-sidebar-delete-row-x")).toBeTruthy();
      expect(screen.queryByTestId("epic-sidebar-delete-row-y")).toBeNull();
    });

    it("a first keyboard open (no prior pointer interaction) also opens the real menu", () => {
      renderRows(["row-x"]);
      const moreButton = screen.getByTestId("epic-sidebar-more-row-x");
      moreButton.focus();

      act(() => {
        fireEvent.keyDown(moreButton, { key: "Enter" });
      });

      expect(screen.getByTestId("epic-sidebar-delete-row-x")).toBeTruthy();
    });

    it("right-click opens nothing while the row is in bulk-selection mode", () => {
      const handle = createSession(flatRows(["row-x"]), kind);
      opened.push(handle);
      const selectionRef: { current: SelectionControls | null } = {
        current: null,
      };
      render(
        <QueryClientProvider client={new QueryClient()}>
          <EpicSessionContext.Provider value={handle}>
            <SidebarBulkSelectionProvider
              panelId={fixture.panelId}
              collapsed={false}
            >
              <SelectionModeEntry
                onReady={(controls) => (selectionRef.current = controls)}
              />
              {fixture.panel}
            </SidebarBulkSelectionProvider>
          </EpicSessionContext.Provider>
        </QueryClientProvider>,
      );
      const selection = selectionRef.current;
      if (selection === null)
        throw new Error("selection controls never captured");

      act(() => {
        selection.enterSelectionMode();
      });

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });
      expect(
        screen.queryByTestId("epic-sidebar-context-delete-row-x"),
      ).toBeNull();
    });
  },
);

// Artifact-only: the row "+" (add child) button, a second `AddNodeDropdown`
// consumer now on `LazyDropdownMenu` too, distinct from the row's "..." menu.
describe("artifact add-child button", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
  });

  it("pointer-down opens the real add menu with its entries", () => {
    const handle = createSession(flatRows(["row-x"]), "artifacts");
    opened.push(handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={handle}>
          {ARTIFACT_FIXTURE.panel}
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("epic-sidebar-add-row-x"), {
        button: 0,
      });
    });

    expect(screen.getByTestId("epic-sidebar-add-menu-row-x")).toBeTruthy();
    expect(screen.getByTestId("epic-sidebar-add-spec-row-x")).toBeTruthy();
  });
});

// Chat-only: the shared root's row-targeting capture handler is the same
// code for both trees (`sidebar-reparent-row-drop-wrapper.tsx`).
describe("touch interaction inside an open context menu", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
  });

  it("a touch pointerdown on the open menu's own item reaches the item, and a long hold still leaves it clickable", () => {
    // Capture any long-press timer started by the initial pointerdown.
    vi.useFakeTimers();
    try {
      const handle = createSession(flatRows(["row-x"]), "chats");
      opened.push(handle);
      render(
        <QueryClientProvider client={new QueryClient()}>
          <EpicSessionContext.Provider value={handle}>
            {CHAT_FIXTURE.panel}
          </EpicSessionContext.Provider>
        </QueryClientProvider>,
      );

      act(() => {
        fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x"));
      });
      // "Copy ID" rather than "Delete"/"Rename": always enabled, so a
      // failure to select it can only be this event path, never a
      // write-permission gate.
      const copyItem = screen.getByTestId("epic-sidebar-context-copy-id-row-x");

      // A target listener proves ancestor capture did not swallow the event.
      const received = vi.fn();
      copyItem.addEventListener("pointerdown", received);
      act(() => {
        copyItem.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
          }),
        );
      });
      expect(received).toHaveBeenCalledTimes(1);

      // Holding inside the portal must not restart the tree trigger timer.
      act(() => {
        vi.advanceTimersByTime(750);
      });
      act(() => {
        copyItem.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
          }),
        );
      });

      expect(
        screen.getByTestId("epic-sidebar-context-copy-id-row-x"),
      ).toBeTruthy();
      expect(copyItem.getAttribute("aria-disabled")).not.toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});

interface MenuKindFixture {
  readonly label: string;
  readonly open: () => void;
  readonly contentSelector: string;
  readonly itemTestId: string;
}

const MENU_KINDS: ReadonlyArray<MenuKindFixture> = [
  {
    label: "context menu",
    open: () =>
      fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-row-x")),
    contentSelector: '[data-slot="context-menu-content"]',
    itemTestId: "epic-sidebar-context-copy-id-row-x",
  },
  {
    label: "dropdown menu",
    open: () =>
      fireEvent.pointerDown(screen.getByTestId("epic-sidebar-more-row-x"), {
        button: 0,
      }),
    contentSelector: '[data-slot="dropdown-menu-content"]',
    itemTestId: "epic-sidebar-copy-id-row-x",
  },
];

// Chat-only: same shared `ContextMenuTrigger`/row-boundary code for both
// trees, and both menu kinds use Radix's `DismissableLayer` for outside-press
// dismissal.
describe.each(MENU_KINDS)(
  "$label dismissal after an inside press",
  (menuKind) => {
    const opened: OpenedStoreForTest[] = [];

    afterEach(() => {
      for (const handle of opened.splice(0)) handle.dispose();
      cleanup();
    });

    it("one outside press dismisses it, even after an inside press that doesn't close it", () => {
      // `DismissableLayer` installs its own document-level "pointerdown"
      // listener via `window.setTimeout(fn, 0)`, not synchronously on mount
      // (@radix-ui/react-dismissable-layer/dist/index.js:330-332) - fake timers
      // give a deterministic zero-delay flush instead of a real sleep.
      vi.useFakeTimers();
      try {
        const handle = createSession(flatRows(["row-x"]), "chats");
        opened.push(handle);
        render(
          <QueryClientProvider client={new QueryClient()}>
            <EpicSessionContext.Provider value={handle}>
              {CHAT_FIXTURE.panel}
            </EpicSessionContext.Provider>
          </QueryClientProvider>,
        );
        const documentListenerSpy = vi.spyOn(document, "addEventListener");

        act(() => {
          menuKind.open();
        });
        const content = document.querySelector(menuKind.contentSelector);
        if (content === null) throw new Error(`no ${menuKind.label} content`);
        expect(screen.getByTestId(menuKind.itemTestId)).toBeTruthy();

        act(() => {
          vi.advanceTimersByTime(0);
        });
        // Non-vacuity: the listener this whole test depends on is really there
        // before any press, not assumed from a guessed flush count.
        expect(
          documentListenerSpy.mock.calls.some(
            (call) => call[0] === "pointerdown",
          ),
        ).toBe(true);

        // A full mouse gesture, not just `pointerdown`: the installed version
        // defers its outside-dismiss decision to the following `click` for a
        // primary-button press, so a bare `pointerdown` alone proves nothing
        // about whether a press actually dismissed the menu.
        const press = (target: Element): void => {
          const init = {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            button: 0,
          };
          act(() => {
            fireEvent.pointerDown(target, init);
            fireEvent.pointerUp(target, init);
            fireEvent.click(target, init);
          });
        };

        // Padding inside the menu, not an item - must not close it. Also the
        // press `DismissableLayer` needs to see to correctly clear "the last
        // pointer-down was inside" before the outside press below.
        press(content);
        expect(screen.getByTestId(menuKind.itemTestId)).toBeTruthy();

        // A single press outside must now dismiss it.
        press(document.body);
        expect(screen.queryByTestId(menuKind.itemTestId)).toBeNull();
        documentListenerSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
