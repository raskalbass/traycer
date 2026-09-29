import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClient } from "@tanstack/react-query";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";
import {
  acquireCloudDraftIngest,
  acquireDraftMirrorSession,
  cloudDraftIngestSeq,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { appLogger } from "@/lib/logger";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

// The reader has its own suite (digest, decode, outcomes). Here it only has to
// reach the requester through the port - so the signal the owner hands the read
// is observable - and answer with a decoded head.
const HEAD: DraftHeadReaderRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: { major: 1, minor: 0 },
  kind: "draft",
  surfaceKind: "landing",
  lastTouchedAt: 1,
  target: { epicId: null, chatId: null, blockId: null },
  hostLocal: { hostId: "host-owner", workspace: null },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: null,
    runSettings: null,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
};

// The landing writer the coordinator installs through. It is the owner's real
// collaborator, so a failing install is made here rather than by reaching into
// the store's setter: while `failing`, it throws; otherwise it is the real one.
const installGate = vi.hoisted(() => ({ failing: false, attempts: 0 }));
// The owner host's blob read, which an apply awaits before it installs a head
// that names images. Held open, it is a real point the apply is parked at.
// The cloud image recovery an apply runs AFTER its row is installed. Held
// open, it parks an apply that has already installed.
const recoveryGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  calls: 0,
}));
const blobGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  reads: 0,
}));
vi.mock("@/stores/home/landing-draft-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/home/landing-draft-store")>();
  return {
    ...actual,
    applyLandingHostDocument: (
      ...args: Parameters<typeof actual.applyLandingHostDocument>
    ): boolean => {
      installGate.attempts += 1;
      if (installGate.failing) throw new Error("install failed");
      return actual.applyLandingHostDocument(...args);
    },
  };
});

vi.mock("@/lib/drafts/cloud-draft-image-recovery", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/cloud-draft-image-recovery")
    >();
  return {
    ...actual,
    recoverCloudDraftImages: async (): Promise<void> => {
      recoveryGate.calls += 1;
      await recoveryGate.hold;
    },
  };
});

vi.mock("@/lib/drafts/draft-blob-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/drafts/draft-blob-transport")>();
  return {
    ...actual,
    readDraftBlobsIntoLocalStore: async (): Promise<
      ReadonlyMap<string, never>
    > => {
      blobGate.reads += 1;
      await blobGate.hold;
      return new Map<string, never>();
    },
  };
});

// What the head read answered is what the apply installs: the requester's
// response carries the head's own metadata (`chat`, the source of the actual
// revision) plus the text and image hashes of the decoded record.
interface HeadResponse {
  readonly outcome: "ok" | "unpublished";
  readonly chat: CloudChatSummary;
  readonly text: string | null;
  readonly hashes: string[];
}

vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: async (options: {
    identity: unknown;
    port: { resolveHead: (identity: unknown) => Promise<HeadResponse> };
  }): Promise<
    | { kind: "ok"; record: DraftHeadReaderRecord; summary: CloudChatSummary }
    | { kind: "unpublished" }
  > => {
    const answer = await options.port.resolveHead(options.identity);
    if (answer.outcome === "unpublished") return { kind: "unpublished" };
    return {
      kind: "ok",
      summary: answer.chat,
      record: {
        ...HEAD,
        portable: {
          ...HEAD.portable,
          blobHashes: answer.hashes,
          content:
            answer.text === null
              ? HEAD.portable.content
              : {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: answer.text }],
                    },
                  ],
                },
        },
      },
    };
  },
}));

const HOST_ID = "host-ingesting";
const OWNER_HOST_ID = "host-owner";
const SCOPE_ID = "scp_1";
const USER = "user-1";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);
const RETRY_BASE_MS = 2_000;
const IMAGE_HASH = "c".repeat(64);

function summary(
  headSha256: string,
  overrides: Partial<CloudChatSummary> | null,
): CloudChatSummary {
  return {
    identity: { taskId: SCOPE_ID, chatId: "draft-1", ownerUserId: USER },
    ownerHostId: OWNER_HOST_ID,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
    ...overrides,
  };
}

/** The head's own answer; each field defaults to the first head, revision 1. */
interface HeadAnswer {
  readonly digest?: string;
  readonly revision?: number;
  readonly text?: string;
  readonly hashes?: string[];
  /** A successful read that carries no head (default: the head itself). */
  readonly outcome?: "unpublished";
}

interface HeadRead {
  readonly signal: AbortSignal;
  readonly resolve: (answer: HeadAnswer | undefined) => void;
  readonly reject: (error: Error) => void;
}

/** A requester whose head reads stay pending until the test settles them. */
function requester(): {
  readonly client: never;
  readonly reads: HeadRead[];
} {
  const reads: HeadRead[] = [];
  const client = {
    request: () => Promise.reject(new Error("unused")),
    requestWithSignal: (
      _method: string,
      _params: unknown,
      signal: AbortSignal,
    ) =>
      new Promise((resolve, reject: (error: Error) => void) => {
        reads.push({
          signal,
          resolve: (answer) => {
            resolve({
              outcome: answer?.outcome ?? "ok",
              chat: summary(answer?.digest ?? DIGEST_ONE, {
                throughRecordSeq: answer?.revision ?? 1,
              }),
              text: answer?.text ?? null,
              hashes: answer?.hashes ?? [],
            });
          },
          reject,
        });
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
  };
  return { client: client as never, reads };
}

let queryClient: QueryClient;

function acquire(
  client: never,
  overrides: {
    chats?: readonly CloudChatSummary[];
    settled?: boolean;
    fenceSeq?: number;
    readOwner?: string;
    hostId?: string;
  },
): () => void {
  return acquireCloudDraftIngest({
    queryClient,
    client,
    hostId: overrides.hostId ?? HOST_ID,
    scopeId: SCOPE_ID,
    readOwner: overrides.readOwner ?? USER,
    chats: overrides.chats ?? [summary(DIGEST_ONE, null)],
    settled: overrides.settled ?? false,
    fenceSeq: overrides.fenceSeq ?? 0,
  });
}

/** Lets the owner's release microtask, and the promise hops behind it, run. */
async function flush(): Promise<void> {
  for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();
}

function draftIds(): string[] {
  return useLandingDraftStore.getState().drafts.map((draft) => draft.id);
}

function rowText(): string {
  const row = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === "draft-1");
  return JSON.stringify(row?.content ?? null);
}

/** A mirror session for `hostId`: an apply reads images through the one it needs. */
function mountSession(hostId: string): void {
  acquireDraftMirrorSession({
    hostId,
    client: {
      request: () =>
        Promise.resolve({
          drafts: [],
          tombstones: [],
          snapshotSeq: 0,
          scopeId: null,
        }),
    } as never,
    streamClient: fakeDraftStreamClient(),
    timing: undefined,
  });
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

beforeEach(() => {
  queryClient = new QueryClient();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  signIn(USER);
});

afterEach(() => {
  focusManager.setFocused(undefined);
  installGate.failing = false;
  installGate.attempts = 0;
  blobGate.hold = null;
  blobGate.reads = 0;
  recoveryGate.hold = null;
  recoveryGate.calls = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  queryClient.clear();
  resetDraftMirrorCoordinatorForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("acquireCloudDraftIngest - sharing and custody", () => {
  it("shares one head read and one fence between mounts of the same head, and installs it once", async () => {
    const { client, reads } = requester();
    const seqBefore = cloudDraftIngestSeq();

    const releaseA = acquire(client, {});
    const releaseB = acquire(client, {});

    expect(reads).toHaveLength(1);
    // The fence is reserved at acquire, before the read settles, once.
    expect(cloudDraftIngestSeq()).toBe(seqBefore + 1);
    expect(draftIds()).toEqual([]);

    reads[0].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    expect(reads).toHaveLength(1);

    releaseA();
    releaseB();
  });

  it.each([
    { released: "the first", index: 0 },
    { released: "the later", index: 1 },
  ])(
    "keeps the read alive when $released of two mounts releases, and applies the head for the other",
    async ({ index }) => {
      const { client, reads } = requester();
      const releases = [acquire(client, {}), acquire(client, {})];

      releases[index]();
      await flush();
      expect(reads[0].signal.aborted).toBe(false);

      reads[0].resolve(undefined);
      await vi.waitFor(() => {
        expect(draftIds()).toEqual(["draft-1"]);
      });
      releases[1 - index]();
    },
  );

  it("cancels the read when the last mount releases before it settles, applies nothing, and reads afresh for a later mount", async () => {
    const { client, reads } = requester();
    const releaseA = acquire(client, {});
    const releaseB = acquire(client, {});

    releaseA();
    releaseB();
    await flush();

    expect(reads[0].signal.aborted).toBe(true);
    reads[0].resolve(undefined);
    await flush();
    expect(draftIds()).toEqual([]);

    const release = acquire(client, {});
    expect(reads).toHaveLength(2);
    reads[1].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    release();
  });

  it("does not cancel for a release the same commit re-acquires", async () => {
    const { client, reads } = requester();
    const release = acquire(client, {});

    release();
    const again = acquire(client, {});
    await flush();

    expect(reads).toHaveLength(1);
    expect(reads[0].signal.aborted).toBe(false);
    reads[0].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    again();
  });

  it("lets a handed-off apply finish after every mount has released", async () => {
    // The head names an image on the owner host, so its apply parks at that
    // host's blob read until the test opens it.
    let openBlobRead: () => void = () => undefined;
    blobGate.hold = new Promise<void>((resolve) => {
      openBlobRead = resolve;
    });
    mountSession(OWNER_HOST_ID);
    const { client, reads } = requester();
    const release = acquire(client, {});

    reads[0].resolve({ hashes: [IMAGE_HASH] });
    await vi.waitFor(() => {
      expect(blobGate.reads).toBe(1);
    });
    expect(draftIds()).toEqual([]);

    release();
    await flush();
    expect(draftIds()).toEqual([]);

    openBlobRead();
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
  });

  it("neither re-reads nor re-applies a head an earlier mount already installed", async () => {
    const { client, reads } = requester();
    const first = acquire(client, {});
    reads[0].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    const seqAfterApply = cloudDraftIngestSeq();

    const second = acquire(client, {});
    await flush();

    expect(reads).toHaveLength(1);
    expect(cloudDraftIngestSeq()).toBe(seqAfterApply);
    first();
    second();
  });

  it("reads a newer head of the same draft as its own entry", async () => {
    const { client, reads } = requester();
    const first = acquire(client, { chats: [summary(DIGEST_ONE, null)] });
    reads[0].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    first();

    const second = acquire(client, { chats: [summary(DIGEST_TWO, null)] });

    expect(reads).toHaveLength(2);
    second();
  });

  it("does not read a row the ingesting host owns itself", async () => {
    const { client, reads } = requester();

    const release = acquire(client, {
      chats: [summary(DIGEST_ONE, { ownerHostId: HOST_ID })],
    });
    await flush();

    expect(reads).toHaveLength(0);
    release();
  });
});

describe("acquireCloudDraftIngest - account and failure safeguards", () => {
  it("refuses to start a head read for an owner that is no longer the signed-in account", async () => {
    const { client, reads } = requester();

    const release = acquire(client, { readOwner: "user-2" });
    await flush();

    expect(reads).toHaveLength(0);
    expect(draftIds()).toEqual([]);
    release();
  });

  it.each([
    {
      change: "the account switches",
      apply: () => {
        signIn("user-2");
      },
    },
    {
      change: "a fresh sign-in attempt starts",
      apply: () => {
        useAuthStore.setState({ status: "signing-in" });
      },
    },
  ])(
    "drops a head that settles after $change during the read",
    async ({ apply }) => {
      const { client, reads } = requester();
      const release = acquire(client, {});

      apply();
      reads[0].resolve(undefined);
      await flush();
      await vi.waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });

      expect(draftIds()).toEqual([]);
      release();
    },
  );

  it("retries a failing head read twice on a doubling delay, then stops", async () => {
    vi.useFakeTimers();
    const { client, reads } = requester();
    const release = acquire(client, {});

    reads[0].reject(new Error("transient"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(2);

    reads[1].reject(new Error("transient"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2 - 1);
    expect(reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(3);

    reads[2].reject(new Error("persistent"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 100);
    expect(reads).toHaveLength(3);
    expect(draftIds()).toEqual([]);
    release();
  });

  it("retries a throwing apply, gives up with one warning, and re-applies the cached head on the next mount without reading", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    installGate.failing = true;
    const { client, reads } = requester();
    const release = acquire(client, {});
    reads[0].resolve(undefined);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);

    expect(installGate.attempts).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(draftIds()).toEqual([]);

    // Nothing was committed, so the entry does not keep the row's custody
    // once its mounts are gone: the next mount hands the cached head over.
    release();
    await flush();
    installGate.failing = false;
    const next = acquire(client, {});
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(reads).toHaveLength(1);
    expect(draftIds()).toEqual(["draft-1"]);
    next();
  });

  it("drops the entry of a chat a settled sweep removes, so a relisting re-applies its cached head", async () => {
    const { client, reads } = requester();
    const first = acquire(client, {});
    reads[0].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    first();
    await flush();

    // A directory that no longer lists it, fenced at the ingest's own seq.
    const empty = acquire(client, {
      chats: [],
      settled: true,
      fenceSeq: cloudDraftIngestSeq(),
    });
    expect(draftIds()).toEqual([]);
    empty();

    const relisted = acquire(client, {});
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    expect(reads).toHaveLength(1);
    relisted();
  });
});

describe("acquireCloudDraftIngest - recovery and ordering", () => {
  it("does not let a failed apply's delayed retry overwrite a newer head that installed meanwhile", async () => {
    vi.useFakeTimers();
    const { client, reads } = requester();
    installGate.failing = true;
    const older = acquire(client, { chats: [summary(DIGEST_ONE, null)] });
    reads[0].resolve({ text: "alpha" });
    await vi.advanceTimersByTimeAsync(0);
    expect(installGate.attempts).toBe(1);

    installGate.failing = false;
    const newer = acquire(client, { chats: [summary(DIGEST_TWO, null)] });
    reads[1].resolve({ digest: DIGEST_TWO, revision: 2, text: "bravo" });
    await vi.advanceTimersByTimeAsync(0);
    expect(rowText()).toContain("bravo");

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 10);
    expect(rowText()).toContain("bravo");
    // The older head's retry gave way without trying to install again.
    expect(installGate.attempts).toBe(2);
    older();
    newer();
  });

  it("restores a head another serving host's sweep removed when it is acquired again", async () => {
    const { client, reads } = requester();
    const first = acquire(client, { hostId: "host-a" });
    reads[0].resolve(undefined);
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    first();
    await flush();

    // Another serving host's settled directory no longer lists the draft.
    const sweep = acquire(client, {
      hostId: "host-b",
      chats: [],
      settled: true,
      fenceSeq: cloudDraftIngestSeq(),
    });
    expect(draftIds()).toEqual([]);
    sweep();

    const again = acquire(client, { hostId: "host-a" });
    await vi.waitFor(() => {
      expect(draftIds()).toEqual(["draft-1"]);
    });
    expect(reads).toHaveLength(1);
    again();
  });

  it("lets a new consumer recover a head whose read gave up while the original mount is still held", async () => {
    vi.useFakeTimers();
    const { client, reads } = requester();
    const original = acquire(client, {});

    reads[0].reject(new Error("down"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    reads[1].reject(new Error("down"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    reads[2].reject(new Error("down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(draftIds()).toEqual([]);

    const recovering = acquire(client, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveLength(4);
    reads[3].resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(draftIds()).toEqual(["draft-1"]);
    original();
    recovering();
  });

  it("lets a later consumer recover a head whose apply failed after its mounts left and came back", async () => {
    vi.useFakeTimers();
    installGate.failing = true;
    const { client, reads } = requester();
    const first = acquire(client, {});
    reads[0].resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(installGate.attempts).toBe(1);

    // Every mount leaves while the apply waits to retry, then one returns.
    first();
    await vi.advanceTimersByTimeAsync(0);
    const returned = acquire(client, {});

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    expect(installGate.attempts).toBe(3);
    expect(draftIds()).toEqual([]);

    installGate.failing = false;
    const later = acquire(client, {});
    await vi.advanceTimersByTimeAsync(0);

    expect(draftIds()).toEqual(["draft-1"]);
    expect(reads).toHaveLength(1);
    returned();
    later();
  });
});

describe("acquireCloudDraftIngest - a stale head never rolls a newer one back", () => {
  it("refuses a cached older head that is re-acquired after a newer head installed through another serving host", async () => {
    vi.useFakeTimers();
    const { client, reads } = requester();
    // H1 is read on host-a but its apply fails, leaving H1 cached, uncommitted.
    installGate.failing = true;
    const firstMount = acquire(client, {
      hostId: "host-a",
      chats: [summary(DIGEST_ONE, null)],
    });
    reads[0].resolve({ text: "alpha" });
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 10);
    expect(installGate.attempts).toBe(3);
    firstMount();
    await vi.advanceTimersByTimeAsync(0);

    // H2 (the later revision) installs through host-b.
    installGate.failing = false;
    const otherHost = acquire(client, {
      hostId: "host-b",
      chats: [summary(DIGEST_TWO, null)],
    });
    reads[1].resolve({ digest: DIGEST_TWO, revision: 2, text: "bravo" });
    await vi.advanceTimersByTimeAsync(0);
    expect(rowText()).toContain("bravo");

    // Host-a's listing still names H1: the cached head is handed to the apply.
    const stale = acquire(client, {
      hostId: "host-a",
      chats: [summary(DIGEST_ONE, null)],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reads).toHaveLength(2);
    expect(rowText()).toContain("bravo");
    otherHost();
    stale();
  });

  it("lets a newer head parked on its images finish although an older head applied meanwhile", async () => {
    let openImages: () => void = () => undefined;
    blobGate.hold = new Promise<void>((resolve) => {
      openImages = resolve;
    });
    mountSession(OWNER_HOST_ID);
    const { client, reads } = requester();
    const newer = acquire(client, {
      hostId: "host-b",
      chats: [summary(DIGEST_TWO, null)],
    });
    reads[0].resolve({
      digest: DIGEST_TWO,
      revision: 2,
      text: "bravo",
      hashes: [IMAGE_HASH],
    });
    await vi.waitFor(() => {
      expect(blobGate.reads).toBe(1);
    });

    // The older head arrives and is applied while the newer one waits.
    const older = acquire(client, {
      hostId: "host-a",
      chats: [summary(DIGEST_ONE, null)],
    });
    reads[1].resolve({ text: "alpha" });
    await flush();

    openImages();
    await vi.waitFor(() => {
      expect(rowText()).toContain("bravo");
    });
    newer();
    older();
  });
});

describe("acquireCloudDraftIngest - recovery keeps the entry's other holders", () => {
  /** One head whose reads all failed while its first mount stays held. */
  async function exhaustedRead() {
    vi.useFakeTimers();
    const { client, reads } = requester();
    const holder = acquire(client, {});
    reads[0].reject(new Error("down"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    reads[1].reject(new Error("down"));
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    reads[2].reject(new Error("down"));
    await vi.advanceTimersByTimeAsync(0);
    return { client, reads, holder };
  }

  it("keeps a recovery read running after the consumer that started it unmounts, and installs its head", async () => {
    const { client, reads, holder } = await exhaustedRead();
    const recovery = acquire(client, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveLength(4);

    recovery();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads[3].signal.aborted).toBe(false);

    reads[3].resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(draftIds()).toEqual(["draft-1"]);
    holder();
  });

  it("cancels a still-running recovery read once the last holder releases", async () => {
    const { client, reads, holder } = await exhaustedRead();
    const recovery = acquire(client, {});
    await vi.advanceTimersByTimeAsync(0);
    recovery();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads[3].signal.aborted).toBe(false);

    holder();
    await vi.advanceTimersByTimeAsync(0);

    expect(reads[3].signal.aborted).toBe(true);
    expect(draftIds()).toEqual([]);
  });
});

describe("acquireCloudDraftIngest - a cancelled read on another serving host", () => {
  // Two serving hosts are two scopes: each makes its own read and its own
  // absence reservation for the same head. Same-scope holders would share one.
  it("does not stop the other host's read from installing when the second host's only lease releases", async () => {
    const { client, reads } = requester();
    const hostA = acquire(client, { hostId: "host-a" });
    const hostB = acquire(client, { hostId: "host-b" });
    expect(reads).toHaveLength(2);

    hostB();
    await flush();
    expect(reads[1].signal.aborted).toBe(true);
    expect(reads[0].signal.aborted).toBe(false);

    reads[0].resolve({ text: "alpha" });
    await vi.waitFor(() => {
      expect(rowText()).toContain("alpha");
    });
    hostA();
  });

  it("does not stop an install parked on its images when the other host starts and cancels a read of the same head", async () => {
    let openImages: () => void = () => undefined;
    blobGate.hold = new Promise<void>((resolve) => {
      openImages = resolve;
    });
    mountSession(OWNER_HOST_ID);
    const { client, reads } = requester();
    const hostA = acquire(client, { hostId: "host-a" });
    reads[0].resolve({ text: "alpha", hashes: [IMAGE_HASH] });
    await vi.waitFor(() => {
      expect(blobGate.reads).toBe(1);
    });

    const hostB = acquire(client, { hostId: "host-b" });
    expect(reads).toHaveLength(2);
    hostB();
    await flush();
    expect(reads[1].signal.aborted).toBe(true);

    openImages();
    await vi.waitFor(() => {
      expect(rowText()).toContain("alpha");
    });
    hostA();
  });
});

describe("acquireCloudDraftIngest - demand that outlives what it applied", () => {
  it.each([
    { relisted: true, outcome: "restores the row, without another read" },
    { relisted: false, outcome: "leaves the row absent" },
  ])(
    "when a settled sweep removed the row of an apply still recovering images and the head is relisted=$relisted, finishing recovery $outcome",
    async ({ relisted }) => {
      let finishRecovery: () => void = () => undefined;
      recoveryGate.hold = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      mountSession(HOST_ID);
      const { client, reads } = requester();
      const held = acquire(client, {});
      reads[0].resolve({ text: "alpha", hashes: [IMAGE_HASH] });
      // The row is installed; the apply itself is still parked in recovery.
      await vi.waitFor(() => {
        expect(recoveryGate.calls).toBe(1);
      });
      expect(rowText()).toContain("alpha");

      // A settled directory that no longer lists it removes the row.
      const sweep = acquire(client, {
        chats: [],
        settled: true,
        fenceSeq: cloudDraftIngestSeq(),
      });
      expect(draftIds()).toEqual([]);
      sweep();
      // Only a live acquisition after the removal asks for the head again; the
      // stale lease that was already held is not such a request.
      const again = relisted ? acquire(client, {}) : null;
      await flush();
      expect(draftIds()).toEqual([]);

      finishRecovery();
      if (relisted) {
        await vi.waitFor(() => {
          expect(rowText()).toContain("alpha");
        });
      } else {
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(draftIds()).toEqual([]);
      }
      expect(reads).toHaveLength(1);
      held();
      again?.();
    },
  );

  it("resolves a head again when the same digest is listed after a read that found nothing published", async () => {
    const { client, reads } = requester();
    const first = acquire(client, {});
    reads[0].resolve({ outcome: "unpublished" });
    await flush();
    expect(draftIds()).toEqual([]);

    // The directory drops it, then lists the same digest again.
    const sweep = acquire(client, {
      chats: [],
      settled: true,
      fenceSeq: cloudDraftIngestSeq(),
    });
    sweep();
    first();
    await flush();
    const relisted = acquire(client, {});

    expect(reads).toHaveLength(2);
    reads[1].resolve({ text: "alpha" });
    await vi.waitFor(() => {
      expect(rowText()).toContain("alpha");
    });
    relisted();
  });

  it("installs a head whose refetch after a cached negative paused while the app was hidden, once the app resumes", async () => {
    vi.useFakeTimers();
    // The app's query defaults, and a mounted client: focus reaches a paused
    // retry only through the client's focus subscription.
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { networkMode: "always", refetchOnWindowFocus: false },
      },
    });
    queryClient.mount();
    try {
      const { client, reads } = requester();
      const first = acquire(client, {});
      reads[0].resolve({ outcome: "unpublished" });
      await vi.advanceTimersByTimeAsync(0);
      expect(draftIds()).toEqual([]);

      // The same head is listed again: the negative is refetched, and that
      // read fails transiently.
      const relisted = acquire(client, {});
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveLength(2);
      reads[1].reject(new Error("transient"));
      await vi.advanceTimersByTimeAsync(0);

      // The app is hidden when the retry delay expires: the retry waits.
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
      expect(reads).toHaveLength(2);
      expect(draftIds()).toEqual([]);

      // Resuming runs the retry; its head installs with no further acquisition.
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveLength(3);
      reads[2].resolve({ text: "alpha" });
      await vi.advanceTimersByTimeAsync(0);

      expect(rowText()).toContain("alpha");
      first();
      relisted();
    } finally {
      queryClient.unmount();
    }
  });
});
