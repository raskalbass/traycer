import { useId, useState, type ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileSyncRule,
  ProfileSyncScope,
} from "@traycer/protocol/host/profile-sync-schemas";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  useProfileSyncSaveRule,
  useProfileSyncStopRule,
} from "@/hooks/providers/use-profile-sync";
import {
  PROFILE_COPY_PROVIDERS,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  type ProfileCopyHosts,
} from "../profile-copy/profile-copy-shared";
import { ProfileSyncProviderPicker } from "./profile-sync-provider-picker";

export function ProfileSyncRules(props: {
  readonly hostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly providers: readonly ProviderCliState[];
  readonly rules: readonly ProfileSyncRule[];
  readonly onViewRun: (batchId: string) => void;
}): ReactNode {
  const [editor, setEditor] = useState<ProfileSyncRule | "new" | null>(null);
  const [stop, setStop] = useState<ProfileSyncRule | null>(null);
  const save = useProfileSyncSaveRule(props.hostId),
    remove = useProfileSyncStopRule(props.hostId);
  const destinations = props.hosts.options.filter(
    (h) =>
      h.hostId !== props.hostId &&
      !props.rules.some((r) => r.destinationHostId === h.hostId),
  );
  if (editor !== null)
    return (
      <ProfileSyncRuleEditor
        key={editor === "new" ? "new" : editor.ruleId}
        hostId={props.hostId}
        rule={editor === "new" ? null : editor}
        hosts={props.hosts}
        candidates={destinations.map((h) => h.hostId)}
        providers={props.providers}
        close={() => setEditor(null)}
      />
    );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-ui-sm font-medium">Keep profiles in sync</h3>
          <p className="text-ui-xs text-muted-foreground">
            One-way rules from {props.hosts.nameFor(props.hostId)}.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={destinations.length === 0}
          onClick={() => setEditor("new")}
        >
          Add device
        </Button>
      </div>
      {props.rules.length === 0 ? (
        <p className="py-5 text-ui-sm text-muted-foreground">
          No automatic rules yet. Add a device and choose which providers to
          keep in sync.
        </p>
      ) : (
        props.rules.map((rule) => (
          <article
            key={rule.ruleId}
            className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-sm font-medium">
                {props.hosts.nameFor(rule.destinationHostId)}
              </h3>
              <span className="text-ui-xs text-muted-foreground">
                {ruleStatus(rule)}
              </span>
            </div>
            <p className="text-ui-xs text-muted-foreground">
              {rule.scope.kind === "all"
                ? "All supported providers, including future providers"
                : `${rule.scope.providers.map(profileCopyProviderLabel).join(", ")} · includes future profiles`}
            </p>
            <p className="text-ui-xs text-muted-foreground">
              {rule.lastCheckedAt === null
                ? "First sync pending"
                : `Last checked ${new Date(rule.lastCheckedAt).toLocaleString()}`}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => setEditor(rule)}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    ruleId: rule.ruleId,
                    sourceHostId: props.hostId,
                    destinationHostId: rule.destinationHostId,
                    scope: rule.scope,
                    paused: !rule.paused,
                    expectedRevision: rule.revision,
                  })
                }
              >
                {save.isPending ? <MutedAgentSpinner /> : null}
                {rule.paused ? "Resume" : "Pause"}
              </Button>
              {rule.batchId !== null ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (rule.batchId !== null) props.onViewRun(rule.batchId);
                  }}
                >
                  View results
                </Button>
              ) : null}
              <Button size="xs" variant="ghost" onClick={() => setStop(rule)}>
                Stop…
              </Button>
            </div>
            {stop?.ruleId === rule.ruleId ? (
              <div className="flex flex-col gap-2 rounded-md bg-foreground/5 p-3">
                <p className="text-ui-xs">
                  Stop future updates? Profiles already on this device will
                  remain.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setStop(null)}
                  >
                    Keep rule
                  </Button>
                  <Button
                    size="xs"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(
                        {
                          sourceHostId: props.hostId,
                          ruleId: rule.ruleId,
                          expectedRevision: rule.revision,
                        },
                        { onSuccess: () => setStop(null) },
                      )
                    }
                  >
                    {remove.isPending ? <MutedAgentSpinner /> : null}Stop
                    automatic sync
                  </Button>
                </div>
              </div>
            ) : null}
          </article>
        ))
      )}
      {save.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(
            save.error,
            props.hosts.nameFor(props.hostId),
          )}
        </p>
      ) : null}
      {remove.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(
            remove.error,
            props.hosts.nameFor(props.hostId),
          )}
        </p>
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        Destination edits need review. Pausing or stopping a rule keeps the
        profiles on that device.
      </p>
    </section>
  );
}
function ProfileSyncRuleEditor(props: {
  readonly hostId: string;
  readonly rule: ProfileSyncRule | null;
  readonly hosts: ProfileCopyHosts;
  readonly candidates: readonly string[];
  readonly providers: readonly ProviderCliState[];
  readonly close: () => void;
}): ReactNode {
  const id = useId();
  const [ruleId] = useState(() => props.rule?.ruleId ?? crypto.randomUUID());
  const [destination, setDestination] = useState(
    props.rule?.destinationHostId ?? "",
  );
  const [all, setAll] = useState(props.rule?.scope.kind === "all");
  const [selected, setSelected] = useState<ProfileCopyWireProvider[]>(
    props.rule?.scope.kind === "selected"
      ? [...props.rule.scope.providers]
      : [...PROFILE_COPY_PROVIDERS],
  );
  const save = useProfileSyncSaveRule(props.hostId);
  const scope: ProfileSyncScope = all
    ? { kind: "all" }
    : { kind: "selected", providers: selected };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button size="xs" variant="ghost" onClick={props.close}>
          ← Automatic sync
        </Button>
        <h3 className="mt-2 text-ui-sm font-medium">
          {props.rule === null ? "Add automatic sync" : "Edit automatic sync"}
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-ui-xs text-muted-foreground">
          Destination device
        </span>
        <Select
          value={destination}
          onValueChange={setDestination}
          disabled={props.rule !== null}
        >
          <SelectTrigger className="w-full" aria-label="Destination device">
            <SelectValue placeholder="Choose a device" />
          </SelectTrigger>
          <SelectContent>
            {(props.rule !== null
              ? [props.rule.destinationHostId]
              : props.candidates
            ).map((id) => (
              <SelectItem key={id} value={id}>
                {props.hosts.nameFor(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label htmlFor={id} className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={all}
          onCheckedChange={(v) => setAll(v === true)}
        />
        <span>
          <span className="text-ui-sm">
            All supported providers, including future providers
          </span>
          <p className="text-ui-xs text-muted-foreground">
            Otherwise choose providers below. Future profiles within your
            selection are included.
          </p>
        </span>
      </label>
      {!all ? (
        <ProfileSyncProviderPicker
          providers={props.providers}
          selected={selected}
          onChange={setSelected}
        />
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        Offline devices wait until both devices are connected. Profiles removed
        from the source or this rule stay on the destination.
      </p>
      {save.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(
            save.error,
            props.hosts.nameFor(props.hostId),
          )}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={props.close}>
          Cancel
        </Button>
        <Button
          disabled={
            destination.length === 0 ||
            (!all && selected.length === 0) ||
            save.isPending
          }
          onClick={() =>
            save.mutate(
              {
                sourceHostId: props.hostId,
                ruleId,
                destinationHostId: destination,
                scope,
                paused: props.rule?.paused ?? false,
                expectedRevision: props.rule?.revision ?? 0,
              },
              { onSuccess: props.close },
            )
          }
        >
          {save.isPending ? <MutedAgentSpinner /> : null}
          {props.rule === null ? "Enable automatic sync" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function ruleStatus(rule: ProfileSyncRule): string {
  if (rule.paused) return "Paused";
  if (rule.status === "waiting") return "Waiting for device";
  if (rule.status === "needs-action") return "Needs attention";
  return "Active";
}
