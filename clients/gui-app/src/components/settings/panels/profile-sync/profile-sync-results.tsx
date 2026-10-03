import { SYNC_STATE_LABELS } from "./profile-sync-state";
import { useRef, useState, type ReactNode } from "react";
import type {
  ProfileSyncBatch,
  ProfileSyncItem,
} from "@traycer/protocol/host/profile-sync-schemas";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProfileSyncResolve } from "@/hooks/providers/use-profile-sync";
import { useProfileCopyRetryMutation } from "@/hooks/providers/profile-copy/use-profile-copy-operation-mutations";
import {
  profileCopySourceRecovery,
  profileCopyPreviewRecord,
  knownRouteFromRecord,
} from "@/lib/profile-copy/profile-copy-model";
import { ProfileCopyDraftPanel } from "../profile-copy/profile-copy-draft-panel";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  type ProfileCopyHosts,
} from "../profile-copy/profile-copy-shared";

export function ProfileSyncResults(props: {
  readonly batch: ProfileSyncBatch;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const destinations = [
    ...new Set(props.batch.items.map((i) => i.destinationHostId)),
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui-xs text-muted-foreground">
        Completed profiles stay completed. Closing this dialog does not cancel
        the run.
      </p>
      {destinations.map((id) => (
        <section key={id} className="rounded-lg border border-border/60 p-3">
          <h3 className="text-ui-sm font-medium">{props.hosts.nameFor(id)}</h3>
          <div className="flex flex-col divide-y divide-border/50">
            {props.batch.items
              .filter((i) => i.destinationHostId === id)
              .map((item) => (
                <ProfileSyncResultItem
                  key={item.operationId}
                  item={item}
                  batch={props.batch}
                  hosts={props.hosts}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
function ProfileSyncResultItem(props: {
  readonly batch: ProfileSyncBatch;
  readonly item: ProfileSyncItem;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { item, batch, hosts } = props;
  const [expanded, setExpanded] = useState(false);
  const resolve = useProfileSyncResolve(batch.sourceHostId);
  const retry = useProfileCopyRetryMutation(
    batch.sourceHostId,
    item.operationId,
  );
  const retryIds = useRef(new Map<string, string>());
  const sourceName = hosts.nameFor(batch.sourceHostId);
  const outcome = item.outcome;
  const canRetry =
    outcome !== null && profileCopySourceRecovery(outcome, false) === "retry";
  const doResolve = (
    action: "check" | "keep-destination" | "use-source",
  ): void =>
    resolve.mutate({
      sourceHostId: batch.sourceHostId,
      batchId: batch.batchId,
      operationId: item.operationId,
      action,
      expectedDestination: item.destinationSettings,
    });
  const error = resolve.error ?? retry.error;
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-ui-sm">
            {profileCopyProviderLabel(item.providerId)} / {item.name}
          </p>
          <p className="text-ui-xs text-muted-foreground">
            {SYNC_STATE_LABELS[item.state]}
          </p>
        </div>
        <div className="flex gap-1">
          {[
            "unconfirmed",
            "unavailable",
            "copying",
            "update-required",
          ].includes(item.state) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={resolve.isPending}
              onClick={() => doResolve("check")}
            >
              {resolve.isPending ? <MutedAgentSpinner /> : null}Check status
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              size="xs"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => {
                const key = `${outcome.attempt.attemptId}:${outcome.revision}`;
                let id = retryIds.current.get(key);
                if (id === undefined) {
                  id = crypto.randomUUID();
                  retryIds.current.set(key, id);
                }
                retry.mutate({
                  attempt: outcome.attempt,
                  expectedRevision: outcome.revision,
                  retryRequestId: id,
                });
              }}
            >
              {retry.isPending ? <MutedAgentSpinner /> : null}Retry
            </Button>
          ) : null}
          {outcome !== null || item.state === "conflict" ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide details" : "Review…"}
            </Button>
          ) : null}
        </div>
      </div>
      {item.identityChanged ? (
        <p className="text-ui-xs text-warning-foreground">
          The source account changed. This relationship is paused; sign in to
          the original account or create a new profile to copy the new account.
        </p>
      ) : null}
      {item.state === "unconfirmed" ? (
        <p className="text-ui-xs text-muted-foreground">
          The destination may have received this profile. Check status before
          starting another transfer.
        </p>
      ) : null}
      {expanded ? (
        <ProfileSyncResultDetails
          item={item}
          hosts={hosts}
          sourceName={sourceName}
          pending={resolve.isPending}
          doResolve={doResolve}
        />
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(error, sourceName)}
        </p>
      ) : null}
    </div>
  );
}

function ProfileSyncResultDetails({
  item,
  hosts,
  sourceName,
  pending,
  doResolve,
}: {
  readonly item: ProfileSyncItem;
  readonly hosts: ProfileCopyHosts;
  readonly sourceName: string;
  readonly pending: boolean;
  readonly doResolve: (
    action: "check" | "keep-destination" | "use-source",
  ) => void;
}): ReactNode {
  const outcome = item.outcome;
  const preview = item.preview?.destinations.find(
    (d) => d.destinationHostId === item.destinationHostId,
  );
  return (
    <>
      {item.state === "conflict" ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
          <p className="text-ui-xs text-warning-foreground">
            This profile was edited on the destination. Other profiles can
            continue syncing.
          </p>
          <p className="text-ui-xs">
            Source: {item.sourceSettings.name} ·{" "}
            {item.sourceSettings.enabled
              ? "Available to agents"
              : "Unavailable to agents"}{" "}
            · {item.sourceSettings.color}
          </p>
          <p className="text-ui-xs">
            Destination: {item.destinationSettings?.name} ·{" "}
            {item.destinationSettings?.enabled
              ? "Available to agents"
              : "Unavailable to agents"}{" "}
            · {item.destinationSettings?.color}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => doResolve("keep-destination")}
            >
              Keep destination & pause
            </Button>
            <Button
              size="xs"
              disabled={pending}
              onClick={() => doResolve("use-source")}
            >
              Use source settings
            </Button>
          </div>
        </div>
      ) : null}
      {item.state !== "conflict" && outcome !== null ? (
        <ProfileCopyDraftPanel
          outcome={outcome}
          names={{
            source: sourceName,
            destination: hosts.nameFor(item.destinationHostId),
            provider: profileCopyProviderLabel(item.providerId),
            profile: item.name,
          }}
          route={knownRouteFromRecord(
            preview === undefined
              ? undefined
              : profileCopyPreviewRecord(preview),
          )}
          cancelRequested={false}
          destinationIsLocal={hosts.isLocalMachine(item.destinationHostId)}
          extraActions={null}
        />
      ) : null}
    </>
  );
}
