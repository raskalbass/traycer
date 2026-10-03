import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  profileSyncSelectionSchema,
  profileSyncStartSchema,
} from "@traycer/protocol/host/profile-sync-schemas";
import type {
  ProfileSyncBatch,
  ProfileSyncItem,
  ProfileSyncRule,
  ProfileSyncSelection,
} from "@traycer/protocol/host/profile-sync-schemas";
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

// Per-test knobs for the start and resolve answers; reset in beforeEach.
let startFailures = 0;
let startBatchSource: string | null = null;
let listFails = false;

interface MountOptions {
  readonly rules: readonly ProfileSyncRule[];
  readonly providers: readonly ProviderCliState[];
  readonly previewItems: (
    selection: ProfileSyncSelection,
  ) => readonly ProfileSyncItem[];
  readonly startItems: (
    selection: ProfileSyncSelection,
  ) => readonly ProfileSyncItem[];
}

function defaultProviders(): readonly ProviderCliState[] {
  return [
    claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
    {
      ...claudeProviderState([
        managedProfile("55555555-5555-4555-8555-555555555555", "Personal"),
      ]),
      providerId: "codex",
    },
  ];
}

function noItems(): readonly ProfileSyncItem[] {
  return [];
}

function mount(
  rules: readonly ProfileSyncRule[],
): MockHostMessenger<HostRpcRegistry> {
  return mountWith({
    rules,
    providers: defaultProviders(),
    previewItems: noItems,
    startItems: noItems,
  });
}

function mountWith(options: MountOptions): MockHostMessenger<HostRpcRegistry> {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-sync",
    handlers: {
      "providers.list": () => ({
        providers: [...options.providers],
        native: null,
      }),
      "providers.profileCopy.sync.list": () => {
        if (listFails) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "history unavailable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.list",
            fatalDetails: null,
          });
        }
        return { batches: [], rules: [...options.rules] };
      },
      "providers.profileCopy.sync.preview": (params) => ({
        selection: params,
        revision: PREVIEW_REVISION,
        items: [...options.previewItems(params)],
      }),
      "providers.profileCopy.sync.start": (params): ProfileSyncBatch => {
        if (startFailures > 0) {
          startFailures -= 1;
          // An answer lost on the wire: the host may or may not have started.
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "start unconfirmed",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.start",
            fatalDetails: null,
          });
        }
        return {
          batchId: params.batchId,
          sourceHostId: startBatchSource ?? params.selection.sourceHostId,
          createdAt: 1,
          automatic: false,
          items: [...options.startItems(params.selection)],
        };
      },
      "providers.profileCopy.sync.resolve": (params): ProfileSyncBatch => ({
        batchId: params.batchId,
        sourceHostId: params.sourceHostId,
        createdAt: 1,
        automatic: false,
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

const STAMP = "c".repeat(64);
const CATALOG_PROFILE_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const CATALOG_PROFILE_B = "22222222-bbbb-4bbb-8bbb-222222222222";

type PreviewDestination = NonNullable<
  ProfileSyncItem["preview"]
>["destinations"][number];

function previewDestination(
  destinationHostId: string,
  disposition: "automatic" | "already-present",
): PreviewDestination {
  return {
    destinationHostId,
    feasibility: {
      automatic: {
        status: "available" as const,
        admissionRevision: "b".repeat(64),
      },
      manual: {
        status: "unavailable" as const,
        reason: "manual-login-unavailable" as const,
      },
    },
    disposition,
    reason: null,
    existingProfileId: null,
    destinationProviderEnabled: true,
  };
}

function syncItem(
  index: number,
  destinationHostId: string,
  state: ProfileSyncItem["state"],
  destinations: PreviewDestination[],
): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: SOURCE_PROFILE_ID,
    name: `Profile ${String(index)}`,
    destinationHostId,
    operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    preview: {
      source: {
        sourceHostId: SOURCE_HOST_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        providerId: "claude",
      },
      previewRevision: PREVIEW_REVISION,
      destinations,
    },
    outcome: null,
    state,
    sourceSettings: {
      name: `Profile ${String(index)}`,
      color: "#ef4444",
      enabled: true,
    },
    sourceIdentityStamp: STAMP,
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

function startCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
  return messenger.calls.filter(
    (call) => call.method === "providers.profileCopy.sync.start",
  );
}

async function pickDestinations(names: readonly RegExp[]): Promise<void> {
  for (const name of names) {
    fireEvent.click(await screen.findByRole("checkbox", { name }));
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe("ProfileSyncModal review regressions", () => {
  beforeEach(() => {
    startFailures = 0;
    startBatchSource = null;
    listFails = false;
    resetStores();
    harness.spine = null;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
    ];
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

  it("describes each destination from its own preview row and leaves already-present out of the review count", async () => {
    mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        // The matching destination is second: reading the first row would say
        // "already has this account" for a profile that WILL be copied.
        syncItem(1, DEST_HOST_ID, "ready", [
          previewDestination(DEST_HOST_TWO_ID, "already-present"),
          previewDestination(DEST_HOST_ID, "automatic"),
        ]),
        syncItem(2, DEST_HOST_TWO_ID, "already-present", [
          previewDestination(DEST_HOST_TWO_ID, "already-present"),
        ]),
        syncItem(3, DEST_HOST_TWO_ID, "ready", [
          previewDestination(DEST_HOST_TWO_ID, "automatic"),
        ]),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/, /Old Mac/]);
    const summaries = await screen.findAllByText(/\d+ profiles ·/);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.textContent).toMatch(/1 profiles · Ready/);
    // Two rows, one already present: nothing here needs review.
    expect(summaries[1]?.textContent).toMatch(/2 profiles · Ready/);
    expect(summaries[1]?.textContent).not.toMatch(/need review/);
    const firstDetails = summaries[0].closest("details");
    if (firstDetails === null)
      throw new Error("expected the Linux box details");
    expect(within(firstDetails).queryByText(/already has this/)).toBeNull();
  });

  it("an empty start answer keeps the selection, says nothing was started and refetches the preview", async () => {
    const messenger = mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        syncItem(1, DEST_HOST_ID, "ready", [
          previewDestination(DEST_HOST_ID, "automatic"),
        ]),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/]);
    await screen.findByText("1 profile transfers selected");
    const before = previewCalls(messenger).length;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText(
        "Nothing was started. Check the selection and try again.",
      ),
    ).toBeTruthy();
    expect(startCalls(messenger)).toHaveLength(1);
    // Still the selection view: no results screen, the destination stays chosen.
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: /Linux box/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() =>
      expect(previewCalls(messenger).length).toBeGreaterThan(before),
    );
    // The refetch settled on the SAME preview revision. A retry must not reuse
    // the batch id of the start that started nothing, or the host would replay
    // that empty batch instead of starting the selection.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Sync now" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
    const batchIds = startCalls(messenger).map(
      (call) => profileSyncStartSchema.parse(call.params).batchId,
    );
    expect(batchIds[0]).toBeTruthy();
    expect(batchIds[1]).toBeTruthy();
    expect(batchIds[1]).not.toBe(batchIds[0]);
  });

  describe("source catalog limits the selectable providers", () => {
    function catalogWithUnsupported(): readonly ProviderCliState[] {
      return [
        claudeProviderState([
          managedProfile(CATALOG_PROFILE_A, "Work"),
          managedProfile(CATALOG_PROFILE_B, "Personal"),
        ]),
        {
          ...claudeProviderState([
            managedProfile("55555555-5555-4555-8555-555555555555", "Main"),
          ]),
          providerId: "codex",
        },
        {
          ...claudeProviderState([
            managedProfile("66666666-6666-4666-8666-666666666666", "One"),
            managedProfile("77777777-7777-4777-8777-777777777777", "Two"),
            managedProfile("88888888-8888-4888-8888-888888888888", "Three"),
          ]),
          providerId: "opencode",
        },
      ];
    }

    it("starts with only the catalog's transferable providers selected, with the matching count", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      await waitFor(() => expect(trigger.textContent).toMatch(/Claude/));
      expect(trigger.textContent).toMatch(/Codex/);
      expect(trigger.textContent).not.toMatch(/Grok|Antigravity|Gemini|Open/);
      // Three profiles across the two (the opencode ones cannot be transferred).
      expect(screen.getByText(/2 selected/).textContent).toMatch(/3 profiles/);
    });

    it("offers only those providers, and Select all / Clear stay inside them", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.click(
        await screen.findByRole("button", { name: "Choose providers" }),
      );
      expect(await screen.findAllByRole("option")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.getByText(/0 selected/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Select all" }));
      expect(screen.getByText(/2 selected/).textContent).toMatch(/3 profiles/);
    });

    it("sends only the catalog providers in the preview and the start", async () => {
      const messenger = mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await screen.findByRole("button", { name: "Choose providers" });
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      expect(previewCalls(messenger).at(-1)?.params).toMatchObject({
        scope: { kind: "selected", providers: ["claude", "codex"] },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
      expect(startCalls(messenger)[0]?.params).toMatchObject({
        selection: {
          scope: { kind: "selected", providers: ["claude", "codex"] },
        },
      });
    });

    it("a new automatic rule defaults to the same catalog providers", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        {
          button: 0,
        },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Add device" }),
      );
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      await waitFor(() => expect(trigger.textContent).toMatch(/Claude/));
      expect(trigger.textContent).toMatch(/Codex/);
      expect(trigger.textContent).not.toMatch(/Grok|Antigravity|Gemini|Open/);
      fireEvent.click(trigger);
      expect(await screen.findAllByRole("option")).toHaveLength(2);
    });
  });

  describe("round 2: request ids, captured source and run capacity", () => {
    const READY_ITEM = (): ProfileSyncItem[] => [
      syncItem(1, DEST_HOST_ID, "ready", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
    ];

    async function settled(
      messenger: MockHostMessenger<HostRpcRegistry>,
      previewsBefore: number,
    ): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        expect(previewCalls(messenger).length).toBeGreaterThan(previewsBefore);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
    }

    it("two different selections on the same preview revision send different batch ids after an unconfirmed first start", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      const before = previewCalls(messenger).length;
      fireEvent.click(await screen.findByRole("checkbox", { name: /Old Mac/ }));
      await settled(messenger, before);
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(first.revision).toBe(second.revision);
      expect(first.selection.destinationHostIds).toEqual([DEST_HOST_ID]);
      expect(second.selection.destinationHostIds).toEqual([
        DEST_HOST_ID,
        DEST_HOST_TWO_ID,
      ]);
      expect(second.batchId).not.toBe(first.batchId);
    });

    it("an unconfirmed start retried for the same selection keeps its batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(first.batchId).toBeTruthy();
      expect(second.batchId).toBe(first.batchId);
    });

    it("result actions dispatch to the captured source even when the returned batch names another host", async () => {
      startBatchSource = DEST_HOST_ID;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: () => [
          syncItem(1, DEST_HOST_ID, "unconfirmed", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Check status" }),
      );
      const resolves = () =>
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.sync.resolve",
        );
      await waitFor(() => expect(resolves()).toHaveLength(1));
      expect(resolves()[0]?.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
      expect(resolves()[0]?.params).toMatchObject({
        sourceHostId: SOURCE_HOST_ID,
      });
      expect(
        messenger.calls.some(
          (call) =>
            call.method.startsWith("providers.profileCopy.") &&
            call.method !== "providers.profileCopy.sync.start" &&
            call.authority.endpoint.hostId === DEST_HOST_ID,
        ),
      ).toBe(false);
    });

    describe("run capacity of 512 profile transfers", () => {
      const LIMIT_TEXT =
        "Choose fewer providers or devices: a run supports up to 512 profile transfers.";

      function catalog(profiles: number): readonly ProviderCliState[] {
        return [
          claudeProviderState(
            Array.from({ length: profiles }, (_unused, index) =>
              managedProfile(
                `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                `Profile ${String(index + 1)}`,
              ),
            ),
          ),
        ];
      }

      function deviceName(index: number): RegExp {
        return new RegExp(`Device ${String(index)}(?!\\d)`);
      }

      async function chooseDevices(count: number): Promise<void> {
        for (let index = 1; index <= count; index += 1) {
          fireEvent.click(
            await screen.findByRole("checkbox", { name: deviceName(index) }),
          );
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
      }

      beforeEach(() => {
        harness.hosts = [
          hostOption(SOURCE_HOST_ID, "Studio Mac", true),
          ...Array.from({ length: 16 }, (_unused, index) =>
            hostOption(
              `capacity-host-${String(index + 1)}`,
              `Device ${String(index + 1)}`,
              false,
            ),
          ),
        ];
      });

      it("33 profiles to 16 devices is refused before any preview or start, with an explanation", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(33),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        expect(await screen.findByText(LIMIT_TEXT)).toBeTruthy();
        expect(previewCalls(messenger)).toHaveLength(0);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        expect(startCalls(messenger)).toHaveLength(0);
      });

      it("dropping to 15 devices lifts the refusal and previews", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(33),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        await screen.findByText(LIMIT_TEXT);
        fireEvent.click(
          await screen.findByRole("checkbox", { name: deviceName(16) }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(0),
        );
        expect(screen.queryByText(LIMIT_TEXT)).toBeNull();
        const lastPreview = previewCalls(messenger).at(-1);
        expect(lastPreview).toBeDefined();
        const requested = profileSyncSelectionSchema.parse(lastPreview?.params);
        expect(requested.destinationHostIds).toHaveLength(15);
        expect(requested.destinationHostIds).not.toContain("capacity-host-16");
      });

      it("exactly 32 profiles to 16 devices (512) is allowed", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(32),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(0),
        );
        expect(screen.queryByText(LIMIT_TEXT)).toBeNull();
      });
    });
  });

  describe("round 3: sync history gate and host removal", () => {
    function perDestination(
      selection: ProfileSyncSelection,
    ): readonly ProfileSyncItem[] {
      return selection.destinationHostIds.map((id, index) =>
        syncItem(index + 1, id, "ready", [previewDestination(id, "automatic")]),
      );
    }

    function refreshHosts(): void {
      // The host options are read by the flow body above the modal: re-render
      // it with a fresh view object, leaving `session` (and so the modal's
      // selection state) untouched.
      act(() => {
        useProfileCopyFlowStore.setState((state) => ({
          view: state.view === null ? null : { ...state.view },
        }));
      });
    }

    it("shows no empty-rules state, Add device or editor until the sync history loads, then the authoritative rule", async () => {
      listFails = true;
      mountWith({
        rules: [SAVED_RULE],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      const retry = await screen.findByRole("button", { name: "Try again" });
      expect(screen.queryByText(/No automatic rules yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();
      expect(screen.queryByText("Add automatic sync")).toBeNull();
      listFails = false;
      fireEvent.click(retry);
      expect(
        await screen.findByRole("heading", { name: "Linux box" }),
      ).toBeTruthy();
      expect(screen.queryByText(/No automatic rules yet/)).toBeNull();
      expect(screen.getByRole("button", { name: "Add device" })).toBeTruthy();
    });

    it("drops a removed destination from the count, the preview and the start, and keeps an offline device selectable", async () => {
      const offline = hostOption("offline-host", "Sleeping box", false);
      harness.hosts = [
        ...harness.hosts,
        {
          ...offline,
          connectable: false,
          health: { ...offline.health, live: false },
        },
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: perDestination,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/, /Old Mac/, /Sleeping box/]);
      await screen.findByText("3 profile transfers selected");
      harness.hosts = harness.hosts.filter(
        (host) => host.hostId !== DEST_HOST_TWO_ID,
      );
      refreshHosts();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(
        await screen.findByText("2 profile transfers selected"),
      ).toBeTruthy();
      expect(screen.queryByRole("checkbox", { name: /Old Mac/ })).toBeNull();
      const lastPreview = previewCalls(messenger).at(-1);
      expect(lastPreview).toBeDefined();
      const requested = profileSyncSelectionSchema.parse(lastPreview?.params);
      expect(requested.destinationHostIds).toEqual([
        DEST_HOST_ID,
        "offline-host",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
      const started = profileSyncStartSchema.parse(
        startCalls(messenger)[0].params,
      );
      expect(started.selection.destinationHostIds).toEqual([
        DEST_HOST_ID,
        "offline-host",
      ]);
    });

    it("a removed selected device no longer counts toward the 16-device limit", async () => {
      harness.hosts = [
        hostOption(SOURCE_HOST_ID, "Studio Mac", true),
        ...Array.from({ length: 17 }, (_unused, index) =>
          hostOption(
            `limit-host-${String(index + 1)}`,
            `Device ${String(index + 1)}`,
            false,
          ),
        ),
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      for (let index = 1; index <= 16; index += 1) {
        fireEvent.click(
          await screen.findByRole("checkbox", {
            name: new RegExp(`Device ${String(index)}(?!\\d)`),
          }),
        );
      }
      const seventeenth = await screen.findByRole("checkbox", {
        name: /Device 17(?!\d)/,
      });
      expect(seventeenth.hasAttribute("disabled")).toBe(true);
      harness.hosts = harness.hosts.filter(
        (host) => host.hostId !== "limit-host-16",
      );
      refreshHosts();
      const reopened = await screen.findByRole("checkbox", {
        name: /Device 17(?!\d)/,
      });
      expect(reopened.hasAttribute("disabled")).toBe(false);
      // Choosing it prunes the removed device from the outgoing request too.
      fireEvent.click(reopened);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        const last = previewCalls(messenger).at(-1);
        expect(last).toBeDefined();
        const requested = profileSyncSelectionSchema.parse(last?.params);
        expect(requested.destinationHostIds).toContain("limit-host-17");
      });
      const finalPreview = profileSyncSelectionSchema.parse(
        previewCalls(messenger).at(-1)?.params,
      );
      expect(finalPreview.destinationHostIds).not.toContain("limit-host-16");
      expect(finalPreview.destinationHostIds).toHaveLength(16);
    });
  });
});
