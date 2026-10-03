import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ProfileSyncRule } from "@traycer/protocol/host/profile-sync-schemas";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileCopyFlowHost } from "@/components/settings/panels/profile-copy/profile-copy-flow-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { clearProfileCopyObservations } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  hostDirectoryEntry,
  PREVIEW_REVISION,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  claudeProviderState,
  hostOption,
  managedProfile,
} from "../../profile-copy/__tests__/profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
  } => ({
    spine: null,
    hosts: [],
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: SCOPED_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

const RULE_ID = "99999999-9999-4999-8999-999999999999";
const SAVED_RULE: ProfileSyncRule = {
  ruleId: RULE_ID,
  sourceHostId: SOURCE_HOST_ID,
  destinationHostId: DEST_HOST_ID,
  scope: { kind: "selected", providers: ["codex"] },
  paused: false,
  revision: 1,
  lastCheckedAt: null,
  batchId: null,
  status: "waiting",
};

function resetStores(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
  useSettingsHostScopeStore.getState().setScopedHostId(null);
  clearProfileCopyObservations();
}

function mount(
  rules: readonly ProfileSyncRule[],
): MockHostMessenger<HostRpcRegistry> {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-sync",
    handlers: {
      "providers.list": () => ({
        providers: [
          claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          {
            ...claudeProviderState([
              managedProfile(
                "55555555-5555-4555-8555-555555555555",
                "Personal",
              ),
            ]),
            providerId: "codex",
          },
        ],
        native: null,
      }),
      "providers.profileCopy.sync.list": () => ({
        batches: [],
        rules: [...rules],
      }),
      "providers.profileCopy.sync.preview": (params) => ({
        selection: params,
        revision: PREVIEW_REVISION,
        items: [],
      }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      harness.hosts.find((host) => host.hostId === hostId)?.entry ??
      hostDirectoryEntry(hostId, hostId),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-sync",
    }),
  );
  harness.spine = spine;
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileCopyFlowHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return messenger;
}

function openSync(providerId: "claude" | null): void {
  act(() => {
    useProfileCopyFlowStore.getState().open({
      kind: "sync",
      sourceHostId: SOURCE_HOST_ID,
      providerId,
    });
  });
}

function previewCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
  return messenger.calls.filter(
    (call) => call.method === "providers.profileCopy.sync.preview",
  );
}

describe("ProfileSyncModal", () => {
  beforeEach(() => {
    resetStores();
    harness.spine = null;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
    ];
    // cmdk, behind the provider picker, needs these in jsdom.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects no destination by default and asks for none before one is chosen", async () => {
    const messenger = mount([]);
    openSync(null);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const box of boxes)
      expect(box.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Choose destination devices.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(previewCalls(messenger)).toHaveLength(0);
  });

  it("never offers the source host as a destination", async () => {
    mount([]);
    openSync(null);
    await screen.findByRole("checkbox", { name: /Linux box/ });
    expect(screen.queryByRole("checkbox", { name: /Studio Mac/ })).toBeNull();
  });

  it("opens from a provider with only that provider selected, else with every provider", async () => {
    mount([]);
    openSync("claude");
    const trigger = await screen.findByRole("button", {
      name: "Choose providers",
    });
    expect(trigger.textContent).toMatch(/Claude/);
    expect(trigger.textContent).not.toMatch(/Codex/);
    cleanup();
    resetStores();
    mount([]);
    openSync(null);
    const all = await screen.findByRole("button", { name: "Choose providers" });
    expect(all.textContent).toMatch(/Claude/);
    expect(all.textContent).toMatch(/Codex/);
  });

  it("previews the multi-provider selection against the captured source after 400ms", async () => {
    const messenger = mount([]);
    openSync("claude");
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose providers" }),
    );
    fireEvent.click(await screen.findByText("Codex"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Linux box/ }));
    expect(previewCalls(messenger)).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // Settings moves to another host mid-flow; the request must still go to the capture.
    act(() => {
      useSettingsHostScopeStore.getState().setScopedHostId("other-host");
    });
    await waitFor(() =>
      expect(previewCalls(messenger).length).toBeGreaterThan(0),
    );
    const call = previewCalls(messenger)[0];
    expect(call.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
    expect(call.params).toMatchObject({
      sourceHostId: SOURCE_HOST_ID,
      scope: { kind: "selected", providers: ["claude", "codex"] },
      destinationHostIds: [DEST_HOST_ID],
    });
  });

  it("loads a saved rule's scope into the editor instead of resetting to every provider", async () => {
    mount([SAVED_RULE]);
    openSync(null);
    fireEvent.mouseDown(
      await screen.findByRole("tab", { name: /Automatic sync/ }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const trigger = await screen.findByRole("button", {
      name: "Choose providers",
    });
    expect(trigger.textContent).toMatch(/Codex/);
    expect(trigger.textContent).not.toMatch(/Claude/);
    const all = screen.getByRole("checkbox", {
      name: /All supported providers, including future providers/,
    });
    expect(all.getAttribute("aria-checked")).toBe("false");
  });
});
