import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  SurfaceDemandContext,
  type ActiveSurfaceDemand,
} from "@/stores/tabs/surface-demand";
import { useAuthStore } from "@/stores/auth/auth-store";

// The read, the sharing and the apply are owned by the coordinator and proven
// in `cloud-draft-ingest-owner.test.ts`. The hook is only the lease: it holds
// one acquisition while its surface is settled, visible and signed in.
const directoryMock = vi.hoisted(() => ({
  visible: true,
  chats: [] as ReadonlyArray<CloudChatSummary>,
  snapshotSeq: 0,
}));
const acquireMock = vi.hoisted(() => ({
  acquire: vi.fn<(input: unknown) => () => void>(),
  release: vi.fn<() => void>(),
}));

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: directoryMock.visible,
    settled: true,
    scopeId: "scp_1",
    chats: directoryMock.chats,
    snapshotIngestSeq: (): number => directoryMock.snapshotSeq,
  }),
}));
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  acquireCloudDraftIngest: (input: unknown): (() => void) =>
    acquireMock.acquire(input),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const CLIENT = { request: () => Promise.reject(new Error("unused")) };

function wrapperFor(demand: ActiveSurfaceDemand) {
  const queryClient = new QueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <SurfaceDemandContext.Provider value={demand}>
          {children}
        </SurfaceDemandContext.Provider>
      </QueryClientProvider>
    );
  };
}

function signIn(userId: string | null): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: userId === null ? null : { userId, username: userId },
  });
}

beforeEach(() => {
  directoryMock.visible = true;
  directoryMock.chats = [];
  acquireMock.acquire.mockReset();
  acquireMock.release.mockReset();
  acquireMock.acquire.mockReturnValue(acquireMock.release);
  signIn("user-1");
});

afterEach(() => {
  // globals are off, so nothing unmounts a hook between tests: one left
  // mounted would re-acquire on the next test's sign-in.
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useCloudDraftsIngest", () => {
  it("holds one acquisition for a settled, visible, signed-in surface and releases it on unmount", () => {
    const view = renderHook(
      () => useCloudDraftsIngest(CLIENT as never, "host-a"),
      {
        wrapper: wrapperFor("settled"),
      },
    );

    expect(acquireMock.acquire).toHaveBeenCalledTimes(1);
    expect(acquireMock.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-a",
        scopeId: "scp_1",
        readOwner: "user-1",
        settled: true,
      }),
    );
    expect(acquireMock.release).not.toHaveBeenCalled();

    view.unmount();
    expect(acquireMock.release).toHaveBeenCalledTimes(1);
  });

  it("swaps its acquisition when the directory lists new chats", () => {
    const view = renderHook(
      () => useCloudDraftsIngest(CLIENT as never, "host-a"),
      {
        wrapper: wrapperFor("settled"),
      },
    );

    directoryMock.chats = [];
    view.rerender();

    expect(acquireMock.acquire).toHaveBeenCalledTimes(2);
    expect(acquireMock.release).toHaveBeenCalledTimes(1);
  });

  it("takes no lease for a preview surface", () => {
    renderHook(() => useCloudDraftsIngest(CLIENT as never, "host-a"), {
      wrapper: wrapperFor("preview"),
    });

    expect(acquireMock.acquire).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the directory is not visible",
      arrange: () => {
        directoryMock.visible = false;
      },
      client: CLIENT,
      hostId: "host-a",
    },
    {
      name: "no account is signed in",
      arrange: () => {
        signIn(null);
      },
      client: CLIENT,
      hostId: "host-a",
    },
    {
      name: "there is no client",
      arrange: () => {},
      client: null,
      hostId: "host-a",
    },
    {
      name: "there is no host",
      arrange: () => {},
      client: CLIENT,
      hostId: null,
    },
  ])("takes no lease while $name", ({ arrange, client, hostId }) => {
    arrange();

    renderHook(() => useCloudDraftsIngest(client as never, hostId), {
      wrapper: wrapperFor("settled"),
    });

    expect(acquireMock.acquire).not.toHaveBeenCalled();
  });
});
