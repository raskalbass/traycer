import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useSurfaceDemand } from "@/stores/tabs/surface-demand";
import { useAuthStore } from "@/stores/auth/auth-store";
import { acquireCloudDraftIngest } from "@/lib/drafts/draft-mirror-coordinator";
import { useCloudDraftsDirectory } from "./use-cloud-drafts-directory";

export function useCloudDraftsIngest(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): void {
  const demand = useSurfaceDemand();
  const queryClient = useQueryClient();
  const readOwner = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const { visible, settled, scopeId, chats, snapshotIngestSeq } =
    useCloudDraftsDirectory(client, hostId);
  useEffect(() => {
    if (
      demand !== "settled" ||
      !visible ||
      client === null ||
      hostId === null ||
      scopeId === null ||
      readOwner === null
    )
      return;
    return acquireCloudDraftIngest({
      queryClient,
      client,
      hostId,
      scopeId,
      readOwner,
      chats,
      settled,
      fenceSeq: snapshotIngestSeq(),
    });
  }, [
    demand,
    visible,
    client,
    hostId,
    scopeId,
    readOwner,
    queryClient,
    chats,
    settled,
    snapshotIngestSeq,
  ]);
}
