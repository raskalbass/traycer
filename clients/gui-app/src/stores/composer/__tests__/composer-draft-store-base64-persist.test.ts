import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { cancelDeferredJsonWrites } from "@/lib/persist/deferred-json-storage";

import { useComposerDraftStore } from "../composer-draft-store";

const STORAGE_KEY = "traycer-gui-app:composer-drafts";
const DEBOUNCE_MS = 100;

// Flush before reading disk - the write is queued, not synchronous.
function flushPendingWrite(): void {
  vi.advanceTimersByTime(DEBOUNCE_MS);
}

function pendingB64ImageDoc(): JsonContent {
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

function persistedDraftsFromLocalStorage(): Record<string, unknown> {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  if (raw === null) throw new Error("expected persisted drafts");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("state" in parsed) ||
    typeof parsed.state !== "object" ||
    parsed.state === null
  ) {
    throw new Error("unexpected persisted shape");
  }
  const state = (parsed as { state: { drafts?: unknown } }).state;
  const drafts = state.drafts;
  if (typeof drafts !== "object" || drafts === null) {
    throw new Error("expected drafts map");
  }
  return drafts as Record<string, unknown>;
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

beforeEach(() => {
  window.localStorage.clear();
  // Fake timers before the reset: `setState` below commits through the
  // persist middleware and schedules a deferred write, so it must happen
  // while the fake clock is already installed - otherwise it arms a REAL
  // 100ms timeout that `cancelDeferredJsonWrites` (called before it) never
  // reaches, and that stray timer fires mid a later test.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  cancelDeferredJsonWrites();
});

afterEach(() => {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  cancelDeferredJsonWrites();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("composer draft store: base64 strip at the persist boundary", () => {
  it("persists a hash-only shape while the in-memory draft keeps the pending b64 node", () => {
    const taskId = "chat-with-pending-image";
    const content = pendingB64ImageDoc();
    useComposerDraftStore.getState().setSnapshot(taskId, content, null);
    flushPendingWrite();

    // (a) What actually landed in localStorage carries no b64content anywhere.
    const fromStorage = persistedDraftsFromLocalStorage();
    expect(containsB64String(fromStorage[taskId])).toBe(false);
    const persistedContent = (
      fromStorage[taskId] as { content?: unknown } | undefined
    )?.content;
    expect(persistedContent).toBeDefined();
    expect(JSON.stringify(persistedContent)).not.toContain("b64content");

    // (b) The LIVE in-memory store still holds the original pending b64
    // node — it is the ingest job's work token, and stripping it in memory
    // would break the background ingest / remount re-entry.
    const live = useComposerDraftStore.getState().drafts[taskId];
    expect(live).toBeDefined();
    if (live === undefined) return;
    expect(containsB64String(live.content)).toBe(true);
    expect(live.content).toEqual(content);
  });

  it("drops the caret when the strip removes a node, and keeps it when it does not", () => {
    // A selection is a pair of ProseMirror positions, and positions count
    // nodes. The persisted document is one node shorter than the one these
    // positions were measured in, so carrying the caret across restores it
    // somewhere else in the text on the next launch - or out of range.
    //
    // Both halves matter. Dropping the caret unconditionally would be its own
    // regression (every ordinary draft would forget where the user was), so the
    // control below is the same assertion for a draft with nothing to strip.
    const pendingId = "chat-caret-after-pending-image";
    const caret = { from: 4, to: 4 };
    useComposerDraftStore
      .getState()
      .setSnapshot(pendingId, pendingB64ImageDoc(), caret);

    // The CONTROL, queued in the same coalesced window: nothing pending,
    // nothing removed, caret preserved.
    const cleanId = "chat-caret-with-nothing-to-strip";
    useComposerDraftStore.getState().setSnapshot(
      cleanId,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
      caret,
    );

    flushPendingWrite();
    const fromStorage = persistedDraftsFromLocalStorage();

    // Stripped: the caret cannot be trusted against the shorter document.
    expect(
      (fromStorage[pendingId] as { selection?: unknown } | undefined)
        ?.selection,
    ).toBeNull();
    // ...and the in-memory draft still has both the node and the caret, which
    // is what the live editor is actually pointing at.
    const live = useComposerDraftStore.getState().drafts[pendingId];
    expect(live?.selection).toEqual(caret);
    expect(containsB64String(live?.content)).toBe(true);

    expect(
      (fromStorage[cleanId] as { selection?: unknown } | undefined)?.selection,
    ).toEqual(caret);
  });

  it("carries a hash-only node through the persisted shape unchanged (nothing to strip)", () => {
    const taskId = "chat-with-hash-only-image";
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "node-1",
                fileName: "shot.png",
                mimeType: "image/png",
                size: 12,
                byHashEligible: true,
                hash: "hash-abc123",
              },
            },
          ],
        },
      ],
    };
    useComposerDraftStore.getState().setSnapshot(taskId, content, null);
    flushPendingWrite();

    const fromStorage = persistedDraftsFromLocalStorage();
    expect(
      (fromStorage[taskId] as { content?: unknown } | undefined)?.content,
    ).toEqual(content);
    expect(containsB64String(fromStorage[taskId])).toBe(false);
  });
});
