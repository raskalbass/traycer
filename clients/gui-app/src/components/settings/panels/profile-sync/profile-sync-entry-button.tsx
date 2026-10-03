import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { profileCopyWireProvider } from "@/lib/profile-copy/profile-copy-model";

export function ProfileSyncEntryButton(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
}): ReactNode {
  return props.hostId === null ? null : (
    <ProfileSyncAvailableEntry
      hostId={props.hostId}
      providerId={props.providerId}
    />
  );
}
function ProfileSyncAvailableEntry(props: {
  readonly hostId: string;
  readonly providerId: ProviderId;
}): ReactNode {
  const supported = useHostMethodSupport(
    props.hostId,
    "providers.profileCopy.sync.preview",
  );
  const open = useProfileCopyFlowStore((s) => s.open);
  let label = "Update Traycer on this device to sync profiles.";
  if (supported === true)
    label = "Sync profiles from this device to your other devices.";
  if (supported === null) label = "Checking device support…";
  return (
    <TooltipWrapper label={label} side="top" sideOffset={4} align="center">
      <span className="inline-flex">
        <Button
          size="xs"
          variant="outline"
          disabled={supported !== true}
          onClick={() =>
            open({
              kind: "sync",
              sourceHostId: props.hostId,
              providerId: profileCopyWireProvider(props.providerId),
            })
          }
        >
          <RefreshCw data-icon="inline-start" />
          Sync profiles…
        </Button>
      </span>
    </TooltipWrapper>
  );
}
