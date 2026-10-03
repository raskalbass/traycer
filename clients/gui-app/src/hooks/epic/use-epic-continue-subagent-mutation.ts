import { toast } from "sonner";
import type { ContinueSubagentRefusalReason } from "@traycer/protocol/host/epic/unary-schemas";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";

/**
 * What each refusal says. The host's `detail` rides under it: the reason is
 * what happened, the detail is which record it happened to.
 */
const REFUSAL_COPY: Record<ContinueSubagentRefusalReason, string> = {
  unsupported_harness:
    "Only Codex and Claude subagents can be continued as a chat.",
  block_not_subagent: "This subagent can't be continued as a chat.",
  still_running: "This subagent is still running. Try again when it finishes.",
  session_unreadable: "Couldn't read this subagent's conversation.",
  creation_failed: "Couldn't create the chat.",
};

/**
 * Mutation hook for `epic.continueSubagent`: one native subagent's
 * conversation carried on as a chat of its own.
 *
 * Sent to the TAB's host, never the app-wide one: the subagent ran where its
 * parent chat runs, and only that host holds its session.
 *
 * A refusal is a successful response, so it is worded here, in `onSuccess`;
 * the caller's own `onSuccess` opens the chat for the other two kinds.
 */
export function useEpicContinueSubagent() {
  const client = useTabHostClient();
  return useHostMutation({
    client,
    method: "epic.continueSubagent",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.continueSubagent(),
      onSuccess: (response) => {
        if (response.kind !== "refused") return;
        toast.error(REFUSAL_COPY[response.reason], {
          description: response.detail.length > 0 ? response.detail : undefined,
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't continue this subagent as a chat.");
      },
    },
  });
}
