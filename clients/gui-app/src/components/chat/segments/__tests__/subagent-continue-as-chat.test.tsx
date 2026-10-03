import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ContinueSubagentResponse } from "@traycer/protocol/host/epic/unary-schemas";

const mutate = vi.hoisted(() => vi.fn());
const openTile = vi.hoisted(() => vi.fn());
const useHostSupportsMethod = vi.hoisted(() => vi.fn());
const mutationState = vi.hoisted(() => ({ isPending: false }));

vi.mock("@/hooks/epic/use-epic-continue-subagent-mutation", () => ({
  useEpicContinueSubagent: () => ({
    mutate,
    isPending: mutationState.isPending,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod,
}));

import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { useSubagentContinueAsChat } from "@/components/chat/segments/subagent-continue-as-chat";
import type { SubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import type {
  ChatMessage as ChatMessageModel,
  SubagentSegment,
} from "@/stores/composer/chat-store";

function settings(harnessId: ChatRunSettings["harnessId"]): ChatRunSettings {
  return {
    harnessId,
    model: "model-1",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };
}

function card(id: string, parentId: string | null): SubagentSegment {
  return {
    id,
    kind: "subagent",
    name: `${id}-agent`,
    agentType: null,
    task: `${id} task`,
    progressUpdates: [],
    result: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId,
    workflowMeta: null,
    children: [],
  };
}

function messagesOf(root: SubagentSegment): ReadonlyArray<ChatMessageModel> {
  return [{ ...makeMessage(1, "assistant"), segments: [root] }];
}

const close = vi.fn();

function drillIn(openId: string | null): SubagentDrillIn {
  return { openId, open: vi.fn(), close };
}

interface Overrides {
  readonly openId: string | null;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly settings: ChatRunSettings | null;
  readonly canAct: boolean;
  readonly isLiveSession: boolean;
}

function render(overrides: Partial<Overrides>) {
  const base: Overrides = {
    openId: "card-1",
    messages: messagesOf(card("card-1", null)),
    settings: settings("codex"),
    canAct: true,
    isLiveSession: true,
    ...overrides,
  };
  return renderHook(() =>
    useSubagentContinueAsChat({
      drillIn: drillIn(base.openId),
      messages: base.messages,
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: "host-1",
      viewTabId: "tab-1",
      settings: base.settings,
      canAct: base.canAct,
      isLiveSession: base.isLiveSession,
    }),
  );
}

/** Makes the next `mutate` answer with `response`, as the hook's call site sees it. */
function answerWith(response: ContinueSubagentResponse): void {
  mutate.mockImplementation(
    (
      _variables: unknown,
      options: { onSuccess: (r: ContinueSubagentResponse) => void },
    ) => {
      options.onSuccess(response);
    },
  );
}

describe("useSubagentContinueAsChat", () => {
  beforeEach(() => {
    mutate.mockReset();
    openTile.mockReset();
    close.mockReset();
    useHostSupportsMethod.mockReset();
    useHostSupportsMethod.mockReturnValue(true);
    mutationState.isPending = false;
  });

  describe("offered", () => {
    it.each(["codex", "claude"] as const)(
      "is offered for a finished %s card",
      (harness) => {
        const { result } = render({ settings: settings(harness) });
        expect(result.current).not.toBeNull();
      },
    );

    it("asks the host support check about the verb for the given host", () => {
      render({});
      expect(useHostSupportsMethod).toHaveBeenCalledWith(
        "host-1",
        "epic.continueSubagent",
      );
    });
  });

  describe("not offered", () => {
    it("with no card open", () => {
      expect(render({ openId: null }).result.current).toBeNull();
    });

    it("for a harness whose subagents cannot be continued", () => {
      expect(
        render({ settings: settings("opencode") }).result.current,
      ).toBeNull();
    });

    it("before the chat has run settings", () => {
      expect(render({ settings: null }).result.current).toBeNull();
    });

    it("to a reader who cannot act", () => {
      expect(render({ canAct: false }).result.current).toBeNull();
    });

    it("on a tile that is not the live session", () => {
      expect(render({ isLiveSession: false }).result.current).toBeNull();
    });

    it("on a host without the verb", () => {
      useHostSupportsMethod.mockReturnValue(false);
      expect(render({}).result.current).toBeNull();
    });

    it("for a workflow card", () => {
      const workflow: SubagentSegment = {
        ...card("card-1", null),
        workflowMeta: {
          name: "review",
          intent: "Review the changeset",
          activity: [],
          agentsStarted: 2,
          agentsFinished: 1,
          totalTokens: 1000,
        },
      };
      expect(
        render({ messages: messagesOf(workflow) }).result.current,
      ).toBeNull();
    });

    it("when the open id names a card that is no longer in the transcript", () => {
      expect(render({ openId: "gone" }).result.current).toBeNull();
    });
  });

  describe("run", () => {
    it("continues the open card by its own block id", () => {
      const { result } = render({});
      result.current?.run();
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]?.[0]).toEqual({
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: "card-1",
      });
    });

    it("sends a nested card's own id, not its ancestor's", () => {
      const root: SubagentSegment = {
        ...card("root", null),
        children: [card("leaf", "root")],
      };
      const { result } = render({
        openId: "leaf",
        messages: messagesOf(root),
      });
      result.current?.run();
      expect(mutate.mock.calls[0]?.[0]).toEqual({
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: "leaf",
      });
    });

    it.each(["created", "existing"] as const)(
      "opens the returned chat and closes the view on %s",
      (kind) => {
        answerWith({ kind, epicId: "epic-1", chatId: "chat-new" });
        const { result } = render({});
        result.current?.run();
        expect(openTile).toHaveBeenCalledTimes(1);
        expect(openTile).toHaveBeenCalledWith({
          node: {
            id: "chat-new",
            type: "chat",
            name: "card-1-agent",
            hostId: "host-1",
            instanceId: expect.any(String) as string,
          },
          target: { tabId: "tab-1" },
          gesture: "explicit",
          modifiers: null,
          placement: null,
          dedupe: true,
          source: "direct_ui",
        });
        expect(close).toHaveBeenCalledTimes(1);
      },
    );

    it("opens nothing and leaves the view open on a refusal", () => {
      answerWith({
        kind: "refused",
        reason: "still_running",
        detail: "",
      });
      const { result } = render({});
      result.current?.run();
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(openTile).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe("isPending", () => {
    it("is false for an idle request and a finished card", () => {
      expect(render({}).result.current?.isPending).toBe(false);
    });

    it("is true while the request is in flight", () => {
      mutationState.isPending = true;
      expect(render({}).result.current?.isPending).toBe(true);
    });

    it("is true while the card is still streaming, with no request in flight", () => {
      const streaming: SubagentSegment = {
        ...card("card-1", null),
        isStreaming: true,
      };
      expect(
        render({ messages: messagesOf(streaming) }).result.current?.isPending,
      ).toBe(true);
    });
  });
});
