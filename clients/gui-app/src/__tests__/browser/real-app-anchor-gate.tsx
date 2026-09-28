// Real AppHeader controls and providers; only the unrelated TabStrip is stubbed.
import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { AppHeader } from "@/components/layout/header/app-header";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import { WorkspaceFolderSummaryControl } from "@/components/home/host-workspace-selector/workspace-folder-summary-control";
import { ComposerNarrowContext } from "@/components/home/composer/composer-narrow-context-internal";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { chordMatchesEvent } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import "@/lib/theme-applier";
import "@/index.css";

interface PlacementSnapshot {
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
  };
  readonly opacity: string;
  readonly visibility: string;
  readonly display: string;
  readonly popupOpacity: string;
  readonly popupVisibility: string;
  readonly popupDisplay: string;
  readonly left: string;
  readonly top: string;
  readonly anchorX: string;
  readonly anchorY: string;
  readonly anchorWidth: string;
  readonly anchorHeight: string;
  readonly availableWidth: string;
  readonly availableHeight: string;
}

declare global {
  interface Window {
    anchorGate: {
      rect: (selector: string) => DOMRect | null;
      start: (selector: string) => void;
      finish: () => Promise<{
        first: PlacementSnapshot;
        final: PlacementSnapshot;
      }>;
      // A selector matching the DOM is not "open" - it can be mid-exit.
      isPresented: (selector: string) => boolean;
      // Set only in "permissions-picker" fixture mode - flips
      // `ComposerNarrowContext`'s value without remounting anything else.
      setComposerNarrow?: (narrow: boolean) => void;
    };
  }
}

function snapshot(el: Element): PlacementSnapshot {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  // The positioner's own opacity stays 1; the popup child is what actually
  // fades/hides during placement and open/close transitions.
  const popup = el.querySelector('[data-slot$="-content"]');
  const popupStyle = popup === null ? null : getComputedStyle(popup);
  return {
    rect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
    opacity: style.opacity,
    visibility: style.visibility,
    display: style.display,
    popupOpacity: popupStyle?.opacity ?? "1",
    popupVisibility: popupStyle?.visibility ?? "visible",
    popupDisplay: popupStyle?.display ?? "block",
    left: style.left,
    top: style.top,
    anchorX: style.getPropertyValue("--anchor-x"),
    anchorY: style.getPropertyValue("--anchor-y"),
    anchorWidth: style.getPropertyValue("--anchor-width"),
    anchorHeight: style.getPropertyValue("--anchor-height"),
    availableWidth: style.getPropertyValue("--available-width"),
    availableHeight: style.getPropertyValue("--available-height"),
  };
}

function isPlaced(snap: PlacementSnapshot): boolean {
  return (
    snap.rect.width > 0 &&
    snap.opacity !== "0" &&
    snap.popupOpacity !== "0" &&
    snap.visibility !== "hidden" &&
    snap.display !== "none" &&
    snap.popupVisibility !== "hidden" &&
    snap.popupDisplay !== "none"
  );
}

function sameGeometry(a: PlacementSnapshot, b: PlacementSnapshot): boolean {
  return (
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height &&
    a.opacity === b.opacity &&
    a.popupOpacity === b.popupOpacity &&
    a.visibility === b.visibility &&
    a.popupVisibility === b.popupVisibility
  );
}

let placement: Promise<{
  first: PlacementSnapshot;
  final: PlacementSnapshot;
}> | null = null;

function observeFirstAndFinal(
  selector: string,
): Promise<{ first: PlacementSnapshot; final: PlacementSnapshot }> {
  return new Promise((resolve, reject) => {
    let first: PlacementSnapshot | null = null;
    let last: PlacementSnapshot | null = null;
    let stableCount = 0;
    let frame = 0;
    const read = (): PlacementSnapshot | null => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const snap = snapshot(el);
      if (!isPlaced(snap)) return null;
      first ??= snap;
      return snap;
    };
    const observer = new MutationObserver(() => {
      read();
    });
    const cleanup = () => {
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    const tick = () => {
      const snap = read();
      if (snap !== null) {
        stableCount =
          last !== null && sameGeometry(last, snap) ? stableCount + 1 : 0;
        last = snap;
        if (stableCount >= 6 && first !== null) {
          cleanup();
          resolve({ first, final: snap });
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Placement did not settle: ${selector}`));
    }, 5000);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
      childList: true,
    });
    frame = requestAnimationFrame(tick);
  });
}

window.anchorGate = {
  rect: (selector) =>
    document.querySelector(selector)?.getBoundingClientRect() ?? null,
  start: (selector) => {
    placement = observeFirstAndFinal(selector);
  },
  finish: () => {
    if (placement === null)
      throw new Error("Start placement observation before opening");
    return placement;
  },
  isPresented: (selector) => {
    const el = document.querySelector(selector);
    return el !== null && isPlaced(snapshot(el));
  },
};

useAuthStore
  .getState()
  .setSignedIn(
    { userId: "gate-user", userName: "Ada Lovelace", email: "ada@example.com" },
    { userId: "gate-user", username: "Ada Lovelace" },
    [],
  );

// Hoisted, not created inside `FixtureBody`: a fresh instance per render
// would remount everything under it, the same bug this gate tests for.
const gateQueryClient = new QueryClient();
const gateRunnerHost = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://localhost:5005",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

// Matches notifications-bell.test.tsx / user-menu.test.tsx's own
// `makeMessengerFactory` exactly - an empty `host.status` handler leaves
// `HostRuntimeProvider`'s binding stuck on `fallback` forever.
function messengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            updateOperation: null,
            updateTransaction: null,
            storeFormats: null,
            install: null,
          }),
      },
    });
}

const GATE_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

// Real dispatch seam for the bell's keybinding case - avoids mounting the
// full `KeybindingProvider`, which has nothing to do with anchoring.
function NotificationsKeybindingSeam() {
  const chord = useBindingForAction("app.notifications.open");
  useEffect(() => {
    if (chord === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!chordMatchesEvent(chord, event)) return;
      event.preventDefault();
      dispatchAction("app.notifications.open", GATE_ROUTER);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [chord]);
  return null;
}

// Shared local `ComposerNarrowContext` toggle, driven by
// `window.anchorGate.setComposerNarrow` - reused by every composer-width-
// toggle fixture mode. Fixed position for a stable screen location.
function NarrowContextFixture(props: { children: ReactNode }) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    window.anchorGate.setComposerNarrow = setNarrow;
    return () => {
      window.anchorGate.setComposerNarrow = undefined;
    };
  }, []);
  return (
    <ComposerNarrowContext.Provider value={narrow}>
      <div style={{ position: "fixed", top: 40, right: 40 }}>
        {props.children}
      </div>
    </ComposerNarrowContext.Provider>
  );
}

function PermissionsPickerFixture() {
  return (
    <NarrowContextFixture>
      <PermissionsPicker
        value="full_access"
        disabled={false}
        onChange={() => undefined}
        supportedPermissionModes={null}
        harnessLabel="Claude Code"
        catalogSupportedModes={null}
        hostKnowsAutoMode
        turnActive={false}
        judgeBilling={null}
        closeFocus="trigger"
        onOpenPermissionSettings={null}
        interactive
      />
    </NarrowContextFixture>
  );
}

// Reaches `EmptyRecentFolderTrigger` (private, no production export) through
// its real parent: `items=[]` + `bindingResolved` gives an empty-recent
// trigger, `recentWorkspaceCount=1` skips the plain `AddFolderButton` early
// return so it renders the Popover-wrapped trigger instead.
function WorkspaceFolderSummaryControlFixture() {
  return (
    <NarrowContextFixture>
      <WorkspaceFolderSummaryControl
        items={[]}
        readOnly={false}
        bindingResolved
        addFolderPending={false}
        addFolderDisabled={false}
        addFolderDisabledReason={null}
        onAddFolder={() => Promise.resolve(false)}
        onUpdate={null}
        updateEnabled={false}
        updatePending={false}
        onDiscardStaged={null}
        discardDisabled={false}
        onEditEnvironment={() => undefined}
        refresh={null}
        popoverTestId="folder-popup"
        popoverSide="bottom"
        recentWorkspaces={<span>Recent folder</span>}
        recentWorkspaceCount={1}
        moveToRecent={false}
      />
    </NarrowContextFixture>
  );
}

const fixtureMode = new URLSearchParams(location.search).get("fixture");

export function FixtureBody() {
  let control = <AppHeader variant="app" />;
  if (fixtureMode === "permissions-picker")
    control = <PermissionsPickerFixture />;
  else if (fixtureMode === "workspace-folder")
    control = <WorkspaceFolderSummaryControlFixture />;
  return (
    <QueryClientProvider client={gateQueryClient}>
      <RunnerHostProvider runnerHost={gateRunnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">…</div>}
        >
          <TooltipProvider>
            <NotificationsKeybindingSeam />
            {control}
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const gateRootRoute = createRootRoute({ component: FixtureBody });
const gateRouter = createRouter({
  routeTree: gateRootRoute,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root === null) throw new Error("Anchor gate root missing");
createRoot(root).render(<RouterProvider router={gateRouter} />);
