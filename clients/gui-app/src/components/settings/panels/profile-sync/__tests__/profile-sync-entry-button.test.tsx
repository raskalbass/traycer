import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileSyncEntryButton } from "@/components/settings/panels/profile-sync/profile-sync-entry-button";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";

const SOURCE = "source-host";

const harness = vi.hoisted(
  (): { negotiated: ReadonlySet<string> | "unknown" } => ({
    negotiated: "unknown",
  }),
);

function answer(method: string): boolean | null {
  if (harness.negotiated === "unknown") return null;
  return harness.negotiated.has(method);
}

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    answer(method),
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    answer(method) === true,
}));

// The six sync verbs and the retry verb a started copy needs to recover.
const REQUIRED_METHODS = [
  "providers.profileCopy.sync.preview",
  "providers.profileCopy.sync.list",
  "providers.profileCopy.sync.start",
  "providers.profileCopy.sync.saveRule",
  "providers.profileCopy.sync.stopRule",
  "providers.profileCopy.sync.resolve",
  "providers.profileCopy.retry",
] as const;

function renderEntry(hostId: string | null, providerId: ProviderId): void {
  render(
    <TooltipProvider>
      <ProfileSyncEntryButton hostId={hostId} providerId={providerId} />
    </TooltipProvider>,
  );
}

function reset(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
}

describe("ProfileSyncEntryButton", () => {
  beforeEach(() => {
    reset();
    harness.negotiated = new Set(REQUIRED_METHODS);
  });
  afterEach(() => {
    cleanup();
    reset();
  });

  it("is enabled when the host negotiated every required verb, and opens the sync view for its provider", () => {
    renderEntry(SOURCE, "claude-code");
    const button = screen.getByRole("button", { name: /Sync profiles/ });
    expect(button.hasAttribute("disabled")).toBe(false);
    act(() => {
      button.click();
    });
    expect(useProfileCopyFlowStore.getState().view).toEqual({
      kind: "sync",
      sourceHostId: SOURCE,
      providerId: "claude",
    });
  });

  it.each(REQUIRED_METHODS)("is disabled when the host lacks %s", (missing) => {
    harness.negotiated = new Set(
      REQUIRED_METHODS.filter((method) => method !== missing),
    );
    renderEntry(SOURCE, "claude-code");
    const button = screen.getByRole("button", { name: /Sync profiles/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    act(() => {
      button.click();
    });
    expect(useProfileCopyFlowStore.getState().view).toBeNull();
  });

  it("is disabled while no handshake has answered yet", () => {
    harness.negotiated = "unknown";
    renderEntry(SOURCE, "claude-code");
    expect(
      screen
        .getByRole("button", { name: /Sync profiles/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("is disabled when the host negotiated nothing", () => {
    harness.negotiated = new Set();
    renderEntry(SOURCE, "codex");
    expect(
      screen
        .getByRole("button", { name: /Sync profiles/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each(["opencode", "cursor"] as const)(
    "is hidden for the %s provider, which profile copy cannot transfer",
    (providerId) => {
      renderEntry(SOURCE, providerId);
      expect(
        screen.queryByRole("button", { name: /Sync profiles/ }),
      ).toBeNull();
    },
  );

  it.each(["claude-code", "codex", "grok", "antigravity"] as const)(
    "is offered for the transferable %s provider",
    (providerId) => {
      renderEntry(SOURCE, providerId);
      expect(
        screen.getByRole("button", { name: /Sync profiles/ }),
      ).toBeTruthy();
    },
  );

  it("renders nothing without a host", () => {
    renderEntry(null, "claude-code");
    expect(screen.queryByRole("button", { name: /Sync profiles/ })).toBeNull();
  });
});
