import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinueSubagentResponse } from "@traycer/protocol/host/epic/unary-schemas";

const toastError = vi.hoisted(() => vi.fn());
const toastFromHostError = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError }));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ request }),
}));

import { useEpicContinueSubagent } from "@/hooks/epic/use-epic-continue-subagent-mutation";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";

const VARIABLES = { epicId: "epic-1", chatId: "chat-1", blockId: "block-1" };

type RefusalReason = Extract<
  ContinueSubagentResponse,
  { kind: "refused" }
>["reason"];

const REASONS: ReadonlyArray<RefusalReason> = [
  "unsupported_harness",
  "block_not_subagent",
  "still_running",
  "session_unreadable",
  "creation_failed",
];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useEpicContinueSubagent(), { wrapper });
  return { ...hook, queryClient };
}

async function run(response: ContinueSubagentResponse): Promise<void> {
  request.mockResolvedValue(response);
  const { result } = setup();
  await act(async () => {
    await result.current.mutateAsync(VARIABLES);
  });
}

describe("useEpicContinueSubagent", () => {
  beforeEach(() => {
    toastError.mockReset();
    toastFromHostError.mockReset();
    request.mockReset();
  });

  it("sends epic.continueSubagent with exactly the three ids to the tab host client", async () => {
    request.mockResolvedValue({
      kind: "created",
      epicId: "epic-1",
      chatId: "chat-2",
    });
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync(VARIABLES);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("epic.continueSubagent", {
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "block-1",
    });
  });

  it("registers the mutation under its key", async () => {
    request.mockResolvedValue({
      kind: "created",
      epicId: "epic-1",
      chatId: "chat-2",
    });
    const { result, queryClient } = setup();
    await act(async () => {
      await result.current.mutateAsync(VARIABLES);
    });
    const keys = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.options.mutationKey);
    expect(keys).toEqual([epicMutationKeys.continueSubagent()]);
  });

  it("words each refusal with its own copy and the host's detail", async () => {
    const copies: string[] = [];
    for (const reason of REASONS) {
      toastError.mockReset();
      await run({ kind: "refused", reason, detail: `detail for ${reason}` });
      expect(toastError).toHaveBeenCalledTimes(1);
      const [copy, options] = toastError.mock.calls[0] as [
        string,
        { description: string | undefined },
      ];
      expect(copy.length).toBeGreaterThan(0);
      expect(options).toEqual({ description: `detail for ${reason}` });
      copies.push(copy);
    }
    expect(new Set(copies).size).toBe(REASONS.length);
    expect(copies[REASONS.indexOf("session_unreadable")]).toBe(
      "Couldn't read this subagent's conversation.",
    );
    // `session_unreadable` also covers a truncated record and a provider
    // refusal, so no copy may assert the conversation is gone.
    for (const copy of copies) expect(copy).not.toContain("no longer");
    expect(toastFromHostError).not.toHaveBeenCalled();
  });

  it("gives an empty detail no description", async () => {
    await run({ kind: "refused", reason: "still_running", detail: "" });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[1]).toEqual({ description: undefined });
  });

  it.each(["created", "existing"] as const)(
    "toasts nothing for %s",
    async (kind) => {
      await run({ kind, epicId: "epic-1", chatId: "chat-2" });
      expect(toastError).not.toHaveBeenCalled();
      expect(toastFromHostError).not.toHaveBeenCalled();
    },
  );

  it("reports a rejected request with the fallback copy", async () => {
    request.mockRejectedValue(new Error("boom"));
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync(VARIABLES).catch(() => undefined);
    });
    await waitFor(() => {
      expect(toastFromHostError).toHaveBeenCalledTimes(1);
    });
    expect(toastFromHostError.mock.calls[0]?.[1]).toBe(
      "Couldn't continue this subagent as a chat.",
    );
    expect(toastError).not.toHaveBeenCalled();
  });
});
