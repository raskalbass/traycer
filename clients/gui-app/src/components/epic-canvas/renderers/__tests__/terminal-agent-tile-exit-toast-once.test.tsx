import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { create, type StoreApi } from "zustand";
import type { TerminalSessionExitReason } from "@traycer/protocol/host/terminal/unary-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";

// `TerminalAgentLive` used to guard its non-zero-exit error toast with a
// per-mount `useRef`, so every remount of the live component - which happens
// while the same warm handle survives in the session registry - re-fired the
// toast and stacked dozens of copies. It now guards with a module-level
// `WeakSet<TerminalSessionStoreHandle>` keyed on the handle, plus a stable
// sonner id. This test pins: one exited handle toasts once no matter how many
// times the tile remounts, and a genuinely different handle (a fresh exit
// observation) toasts again.

const testState = vi.hoisted(() => ({
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null as string | null,
  },
  navigateResults: [] as Array<NestedFocusTarget | null>,
  navigateNested: vi.fn(),
}));

type ExitedStoreState = {
  readonly status: "exited" | "running";
  readonly connectionStatus: "open";
  readonly exitCode: number | null;
  readonly exitReason: TerminalSessionExitReason | null;
  readonly effectiveCols: number;
  readonly effectiveRows: number;
  readonly lastOutputPreview: string | null;
  readonly writeInput: () => null;
  readonly requestResize: () => null;
  readonly setWriter: () => undefined;
};

type ExitedHandleFixture = {
  readonly epicId: string;
  readonly sessionId: string;
  readonly dispose: () => undefined;
  readonly store: StoreApi<ExitedStoreState>;
};

function createExitedHandle(sessionId: string): ExitedHandleFixture {
  return {
    epicId: "epic-test",
    sessionId,
    dispose: () => undefined,
    store: create<ExitedStoreState>(() => ({
      status: "exited",
      connectionStatus: "open",
      exitCode: 1,
      exitReason: null,
      effectiveCols: 80,
      effectiveRows: 24,
      lastOutputPreview: null,
      writeInput: () => null,
      requestResize: () => null,
      setWriter: () => undefined,
    })),
  };
}

const handleState = vi.hoisted(() => ({
  current: null as ExitedHandleFixture | null,
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => testState.reachability,
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: handleState.current,
    createIsError: false,
    createError: null,
    retry: () => undefined,
    hostHasSession: false,
  }),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    // The fork dialog stays mounted under the tile and imports this control.
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/lib/host", () => {
  const entry = {
    hostId: "test-host",
    label: "Test host",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    transportDialability: "dialable",
  };
  return {
    useHostBinding: () => null,
    useHostClient: () => ({
      request: () => new Promise(() => {}),
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
    }),
    useHostDirectory: () => ({
      findById: () => entry,
      onChange: () => ({ dispose: () => undefined }),
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => "host-test",
    getRequestContextUserId: () => "user-test",
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: () => ({
    id: "agent-1",
    harnessId: "claude" as const,
    title: "Claude agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    hostId: "host-test",
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    workspaceFolders: [],
    model: null,
    reasoningEffort: null,
    agentMode: "regular" as const,
  }),
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => ({
    isError: false,
    isPending: false,
    isIdle: true,
    error: null,
    reset: () => undefined,
    mutateAsync: () => new Promise(() => {}),
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({ data: { binding: null } }),
}));

const reportableErrorToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast,
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";

const EPIC_ID = "epic-1";
const HOST_ID = "test-host";

function withQueryClient(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId="test-host">{node}</TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function resetNavigationSpy(): void {
  testState.navigateResults = [];
  testState.navigateNested.mockReset();
  testState.navigateNested.mockImplementation(
    (
      _epicId: string,
      _tabId: string,
      prepare: () => NestedFocusTarget | null,
    ) => {
      const target = prepare();
      testState.navigateResults.push(target);
      return target;
    },
  );
}

function agentNode(id: string, instanceId: string): EpicNodeRef {
  return {
    id,
    instanceId,
    type: "terminal-agent",
    name: "claude",
    hostId: HOST_ID,
  };
}

function openAgentFixture(): {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly closingNode: EpicNodeRef;
} {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  const closingNode = agentNode("agent-1", "inst-agent-1");
  store.openTileInTab(viewTabId, closingNode);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  const pane = collectPanes(canvas.root)[0];
  return { viewTabId, paneId: pane.id, closingNode };
}

describe("<TuiAgentTile /> exit toast dedupe", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    reportableErrorToast.mockReset();
    handleState.current = createExitedHandle("agent-1");
    testState.reachability = {
      status: "reachable",
      hostLabel: "Host A",
      basis: "directory",
      unavailability: null,
    };
    resetNavigationSpy();
  });

  afterEach(() => {
    cleanup();
  });

  it("toasts once per exited handle, not once per remount, and toasts again for a fresh handle", async () => {
    const fixture = openAgentFixture();

    const { unmount } = render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalledTimes(1);
    });
    expect(reportableErrorToast).toHaveBeenCalledWith(
      "Terminal agent exited with an error.",
      expect.objectContaining({ id: "terminal-agent-exit:agent-1" }),
      expect.anything(),
    );

    unmount();

    // Re-render the same tile props with the SAME handle object - this is the
    // remount that used to stack a fresh toast every time, because the guard
    // was a per-mount `useRef` rather than keyed on the handle.
    const { unmount: unmountAgain } = render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    await waitFor(() => {
      const canvas =
        useEpicCanvasStore.getState().canvasByTabId[fixture.viewTabId];
      if (canvas === undefined) throw new Error("expected view tab canvas");
      expect(
        canvas.tilesByInstanceId[fixture.closingNode.instanceId],
      ).toBeDefined();
    });
    expect(reportableErrorToast).toHaveBeenCalledTimes(1);

    unmountAgain();

    // A DIFFERENT handle object - a fresh exit observation, e.g. after a
    // force-release - is not covered by the first handle's WeakSet entry and
    // toasts again.
    handleState.current = createExitedHandle("agent-1");

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalledTimes(2);
    });
  });

  it("re-arms when the same handle returns to running and exits again", async () => {
    const fixture = openAgentFixture();
    const handle = createExitedHandle("agent-1");
    handleState.current = handle;

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalledTimes(1);
    });

    // A restart or a revive in place: the SAME handle goes back to running,
    // then the relaunched process fails as well. That second exit is a new
    // one and must not be swallowed by the first exit's entry.
    act(() => {
      handle.store.setState({ status: "running", exitCode: null });
    });
    act(() => {
      handle.store.setState({ status: "exited", exitCode: 1 });
    });

    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalledTimes(2);
    });
  });
});
