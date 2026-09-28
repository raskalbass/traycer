import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { cancelDeferredJsonWrites } from "@/lib/persist/deferred-json-storage";
import * as stripModule from "@/lib/composer/strip-base64-image-nodes";
import { useComposerDraftStore } from "../composer-draft-store";

const STORAGE_KEY = "traycer-gui-app:composer-drafts";
const DEBOUNCE_MS = 100;

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function pendingB64Doc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "pending-node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 12,
              byHashEligible: true,
              b64content: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        ],
      },
    ],
  };
}

function containsB64String(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsB64String);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, v]) => {
      if (key === "b64content" && typeof v === "string" && v.length > 0) {
        return true;
      }
      return containsB64String(v);
    });
  }
  return false;
}

interface PersistedComposerShape {
  readonly state: {
    readonly drafts: Record<
      string,
      { readonly content: JsonContent; readonly selection: unknown }
    >;
  };
}

function readPersisted(): PersistedComposerShape | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as PersistedComposerShape);
}

// Some environments run the jsdom setup's `installMockLocalStorage()`
// fallback (own-property methods on the `window.localStorage` instance
// itself, not inherited from `Storage.prototype` - see
// `__tests__/test-browser-apis.ts`), so a spy must target whichever one is
// actually live rather than assuming the prototype.
function storageSpyTarget(): Storage {
  return Object.hasOwn(window.localStorage, "setItem")
    ? window.localStorage
    : Storage.prototype;
}

describe("composer draft store: deferred, coalesced localStorage persistence", () => {
  let setItemSpy: MockInstance<typeof Storage.prototype.setItem>;
  let stringifySpy: MockInstance<typeof JSON.stringify>;
  let stripSpy: MockInstance<
    typeof stripModule.stripBase64ImageNodesWithSelection
  >;

  function storeWrites(): number {
    return setItemSpy.mock.calls.filter(([key]) => key === STORAGE_KEY).length;
  }

  function resetStore(): void {
    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
  }

  beforeEach(() => {
    window.localStorage.clear();
    // Fake timers FIRST: `resetStore()` below commits through the real
    // persist middleware, which schedules a deferred write. Installing fake
    // timers before that commit keeps that scheduling on the fake clock, so
    // the `cancelDeferredJsonWrites()` right after actually reaches it -
    // otherwise it arms a real 100ms timeout that fires mid a LATER test.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetStore();
    cancelDeferredJsonWrites();
    // `getOptions().name` may have been left retargeted by a prior test in
    // this file; every assertion here keys off the well-known STORAGE_KEY.
    useComposerDraftStore.persist.setOptions({ name: STORAGE_KEY });
    setItemSpy = vi.spyOn(storageSpyTarget(), "setItem");
    stringifySpy = vi.spyOn(JSON, "stringify");
    stripSpy = vi.spyOn(stripModule, "stripBase64ImageNodesWithSelection");
  });

  afterEach(() => {
    // Reset (which schedules) BEFORE cancel (which wipes it), and both while
    // still on fake timers - only then is it safe to switch back to real
    // ones with nothing left armed. See the `beforeEach` note above.
    resetStore();
    cancelDeferredJsonWrites();
    vi.useRealTimers();
    setItemSpy.mockRestore();
    stringifySpy.mockRestore();
    stripSpy.mockRestore();
    window.localStorage.clear();
  });

  it("N typed snapshots touch localStorage zero times synchronously - no stringify, no base64 strip - and coalesce into exactly one flush with the latest content", () => {
    const chatId = "chat-typing";
    for (let i = 0; i < 5; i += 1) {
      useComposerDraftStore
        .getState()
        .setSnapshot(chatId, textDoc(`draft v${i}`), null);
    }
    // Every keystroke landed in the in-memory store immediately...
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      textDoc("draft v4"),
    );
    // ...but none of them did any of the persistence-boundary work yet.
    expect(storeWrites()).toBe(0);
    expect(stringifySpy).not.toHaveBeenCalled();
    expect(stripSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(storeWrites()).toBe(1);
    expect(stringifySpy).toHaveBeenCalledTimes(1);
    expect(stripSpy).toHaveBeenCalledTimes(1);
    expect(readPersisted()?.state.drafts[chatId]?.content).toEqual(
      textDoc("draft v4"),
    );
  });

  it("an unchanged caret is a genuine no-op: it never schedules a write", () => {
    const chatId = "chat-caret-noop";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, textDoc("hello"), { from: 2, to: 2 });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(1);
    setItemSpy.mockClear();

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 2, to: 2 }, "host-a");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(0);
  });

  it("replaceDraft is durable the instant it returns - a crash with no lifecycle event right after loses nothing", () => {
    const chatId = "chat-restore-crash";
    useComposerDraftStore
      .getState()
      .replaceDraft(chatId, textDoc("restored prompt"), null);

    // No pagehide, no timer advance, no explicit flush - `replaceDraft` runs
    // `persistNowOrThrow` before it returns, so a restorer's caller (which
    // acknowledges the source right after) never races a still-queued write.
    expect(storeWrites()).toBe(1);
    expect(readPersisted()?.state.drafts[chatId]?.content).toEqual(
      textDoc("restored prompt"),
    );
  });

  it("a changed caret alone still schedules a deferred write, not silently dropped", () => {
    const chatId = "chat-caret-change";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, textDoc("hello"), { from: 2, to: 2 });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 4, to: 4 }, "host-a");
    expect(storeWrites()).toBe(0);

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(1);
    expect(readPersisted()?.state.drafts[chatId]?.selection).toEqual({
      from: 4,
      to: 4,
    });
  });

  it("pagehide flushes the pending write immediately, stripped of the pending base64 node", () => {
    const chatId = "chat-pagehide";
    useComposerDraftStore.getState().setSnapshot(chatId, pendingB64Doc(), null);
    expect(storeWrites()).toBe(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(storeWrites()).toBe(1);
    const persisted = readPersisted();
    expect(containsB64String(persisted?.state.drafts[chatId])).toBe(false);
    // The live in-memory draft still carries the pending node: it is the
    // background ingest job's work token, not something the flush may drop.
    expect(
      containsB64String(
        useComposerDraftStore.getState().drafts[chatId]?.content,
      ),
    ).toBe(true);
  });

  it("an external, newer disk write followed by persist.rehydrate is never clobbered by the older queued local write", async () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("local-chat", textDoc("STALE-LOCAL"), null);

    const externalPayload = JSON.stringify({
      version: 1,
      state: {
        drafts: {
          "ext-chat": { content: textDoc("EXTERNAL-NEWER"), selection: null },
        },
        pendingSubmittedDraftDeletes: {},
      },
    });
    window.localStorage.setItem(STORAGE_KEY, externalPayload);

    await useComposerDraftStore.persist.rehydrate();

    // This store's `merge` replaces `drafts` wholesale from disk, so the
    // stale local edit is gone from memory too - the read that authorized
    // this trusted the disk over the still-queued edit.
    expect(
      useComposerDraftStore.getState().drafts["local-chat"],
    ).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts["ext-chat"]).toBeDefined();

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    const onDisk = window.localStorage.getItem(STORAGE_KEY);
    expect(onDisk).not.toBeNull();
    expect(onDisk).not.toContain("STALE-LOCAL");
  });

  it("retargeting the persist key cancels a pending write on the outgoing key", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-retarget", textDoc("about to move"), null);

    useComposerDraftStore.persist.setOptions({
      name: "traycer-gui-app:composer-drafts:other-account",
    });

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clearStorage cancels a pending write through the same removeItem cancellation path", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-clear", textDoc("about to be cleared"), null);

    useComposerDraftStore.persist.clearStorage();

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
