import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { PROVIDER_LOGIN_PACK_POLL_MS } from "@/components/providers/provider-login-start";
import {
  useProviderProfileLoginFlow,
  type AwaitLoginMutation,
  type CancelLoginMutation,
  type EnsurePackMutation,
  type ProviderProfileLoginFlowMode,
  type StartLoginMutation,
  type SubmitLoginCodeMutation,
  type TouchLoginMutation,
} from "@/components/settings/panels/use-provider-profile-login-flow";

// This suite is the fix's central claim: whoever stops asking (a Cancel
// press, or the flow's own hook unmounting) releases a login child the host
// is still holding open, and a newer attempt's own answer is never mistaken
// for a stale one's. It drives the REAL hook against real `useMutation`
// instances (per `host-overview-notices.test.tsx`'s fixture pattern) rather
// than a hand-cast `UseMutationResult` - the type is a large TanStack shape
// this file has no business re-typing - with `mutationFn`s this file fully
// controls, so every race below is driven by the test, not by chance timing.

type StartLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type StartLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type CancelLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.cancelLogin"
>;
type CancelLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.cancelLogin"
>;
type AwaitLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type AwaitLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type SubmitLoginCodeRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.submitLoginCode"
>;
type SubmitLoginCodeResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.submitLoginCode"
>;
type TouchLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.touchLogin"
>;
type TouchLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.touchLogin"
>;
type EnsurePackRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.ensurePack"
>;
type EnsurePackResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.ensurePack"
>;

const PROVIDER_ID = "codex";

/** A still-pending answer this test resolves on its own schedule, instead of
 *  the flow racing ahead of the assertions that inspect it mid-flight. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function startLoginAnswer(
  overrides: Partial<StartLoginResponse>,
): StartLoginResponse {
  return {
    url: null,
    started: false,
    profileId: null,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    ...overrides,
  };
}

const PACK_PREPARING_ANSWER: StartLoginResponse = startLoginAnswer({
  pending: "pack_preparing",
  pack: { percent: 10, reason: null, retryAtMs: null },
});

function loginCapability(
  selfOpensBrowser: Record<string, never> | null,
): NonNullable<ProviderCliState["loginCapability"]> {
  return {
    oauthArgs: ["login"],
    token: null,
    codePaste: null,
    terminalLogin: null,
    remoteSafe: null,
    selfOpensBrowser,
  };
}
/** Nobody but the GUI would have opened this login's page. */
const GUI_OPENS_BROWSER = loginCapability(null);
/** The provider's own child opens its browser - its page may already be open
 *  and the user can still finish there, so an unmounted-and-started login for
 *  this capability is left alone. */
const SELF_OPENS_BROWSER = loginCapability({});

function queryClientWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

/**
 * Exercises `useProviderProfileLoginFlow` directly. `startLoginImpl` is the
 * one seam every test in this file drives (each call captured, resolved on
 * its own schedule via a queue the harness never reads from); every other
 * mutation is a real `useMutation` too, wired to a fake this suite either
 * never expects to fire (`awaitLogin` never resolves - none of these cases
 * reach past `waiting`) or records for its own assertion (`cancelLogin`).
 */
function LoginFlowHarness(props: {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly existingProfileId: string | null;
  readonly loginCapability: ProviderCliState["loginCapability"];
  readonly startLoginImpl: (
    request: StartLoginRequest,
  ) => Promise<StartLoginResponse>;
  readonly cancelLoginImpl: (request: CancelLoginRequest) => void;
}): ReactNode {
  const startLogin: StartLoginMutation = useMutation<
    StartLoginResponse,
    HostRpcError,
    StartLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: props.startLoginImpl,
    onMutate: () => ({ hostId: null }),
  });
  const awaitLogin: AwaitLoginMutation = useMutation<
    AwaitLoginResponse,
    HostRpcError,
    AwaitLoginRequest,
    { readonly hostId: string | null }
  >({
    // Never resolves: no case in this file drives the flow past `waiting`,
    // so nothing here is ever meant to settle.
    mutationFn: () => new Promise<AwaitLoginResponse>(() => undefined),
    onMutate: () => ({ hostId: null }),
  });
  const cancelLoginMutation: CancelLoginMutation = useMutation<
    CancelLoginResponse,
    HostRpcError,
    CancelLoginRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: () => Promise.resolve({ cancelled: true }),
    onMutate: () => ({ hostId: null }),
  });
  // Recorded when the flow sends the cancel, not when TanStack gets round to
  // running `mutationFn` a few microtasks later: an assertion made right
  // after a press has to see a cancel that press sent.
  const cancelLogin: CancelLoginMutation = {
    ...cancelLoginMutation,
    mutate: (request, options) => {
      props.cancelLoginImpl(request);
      cancelLoginMutation.mutate(request, options);
    },
  };
  const submitLoginCode: SubmitLoginCodeMutation = useMutation<
    SubmitLoginCodeResponse,
    HostRpcError,
    SubmitLoginCodeRequest
  >({
    mutationFn: () => Promise.resolve({ outcome: "accepted" }),
  });
  const touchLogin: TouchLoginMutation = useMutation<
    TouchLoginResponse,
    HostRpcError,
    TouchLoginRequest
  >({
    mutationFn: () => Promise.resolve({ extended: true }),
  });
  const ensurePack: EnsurePackMutation = useMutation<
    EnsurePackResponse,
    HostRpcError,
    EnsurePackRequest,
    { readonly hostId: string | null }
  >({
    mutationFn: () => Promise.resolve({ managedInstallState: null }),
    onMutate: () => ({ hostId: null }),
  });

  const flow = useProviderProfileLoginFlow({
    mode: props.mode,
    providerId: PROVIDER_ID,
    existingProfileId: props.existingProfileId,
    loginCapability: props.loginCapability,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    ensurePack,
    failureMessages: {
      notStarted: "Sign-in did not start.",
      notFinished: "Sign-in did not finish.",
    },
    onFailed: () => undefined,
  });

  return (
    <div>
      <div data-testid="flow-state">{flow.state.kind}</div>
      <button
        type="button"
        onClick={() =>
          flow.start({ label: "Test profile", shareSkillsAndPlugins: false })
        }
      >
        start
      </button>
      <button type="button" onClick={() => flow.cancel()}>
        cancel
      </button>
    </div>
  );
}

/** Records every `startLoginImpl` call as its own deferred answer, so a test
 *  resolves calls in whatever order it is exercising rather than the order
 *  they were dispatched in. */
interface StartLoginRecorder {
  readonly impl: (request: StartLoginRequest) => Promise<StartLoginResponse>;
  readonly calls: Deferred<StartLoginResponse>[];
}
function startLoginRecorder(): StartLoginRecorder {
  const calls: Deferred<StartLoginResponse>[] = [];
  return {
    calls,
    impl: () => {
      const call = deferred<StartLoginResponse>();
      calls.push(call);
      return call.promise;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useProviderProfileLoginFlow - releasing a login the host is still holding (create mode)", () => {
  it("cancelling while the pack is still downloading releases the login the in-flight call started, while still mounted", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    expect(recorder.calls).toHaveLength(1);

    // First answer: the pack is downloading. The flow asks again after its
    // 2-second poll gap.
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);
    expect(screen.getByTestId("flow-state").textContent).toBe("starting");

    // Cancel while that second call is still in flight - the UI is showing
    // the download state, so the press ends the flow at once even though
    // nothing has answered yet.
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    // The call already on its way answers with a login the host actually
    // started, and a profile it minted - only this press releases it.
    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({ pending: "starting", profileId: "p-new" }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
    });
  });

  it("cancelling while the pack is still downloading releases the login even after the dialog unmounts first", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    view.unmount();

    // A started answer, this time - the release still has to run for it, not
    // only for a still-starting one.
    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test/oauth",
        }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
    });
  });

  it("releases a login that was still starting when the hook unmounted with no Cancel press", async () => {
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    expect(recorder.calls).toHaveLength(1);

    view.unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({ pending: "starting", profileId: "p-new" }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
    });
  });

  it("releases a login that had already started by the time the hook unmounted, when only the GUI would have opened its page", async () => {
    // A started answer this time, not a still-starting one - but with no
    // capability (or `selfOpensBrowser: null`), this provider never opens its
    // own browser, so a login nobody asks for again is a login nobody ever
    // opens.
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={GUI_OPENS_BROWSER}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    view.unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test/oauth",
        }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p-new",
    });
  });

  it("leaves a login alone when it had already started by the time the hook unmounted, when the provider opens its own browser", async () => {
    // The complement of the case above: proves the positive path would have
    // been observable (same setup, same unmount, same answer) had the
    // capability actually been one only the GUI opens - so this negative is
    // not vacuous.
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    const view = render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={SELF_OPENS_BROWSER}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    view.unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-new",
          url: "https://example.test/oauth",
        }),
      );
      await Promise.resolve();
    });

    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });

  it("never releases a superseded attempt's own stale answer, and still proceeds on the attempt that replaced it", async () => {
    vi.useFakeTimers();
    const recorder = startLoginRecorder();
    const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
    render(
      <LoginFlowHarness
        mode="create"
        existingProfileId={null}
        loginCapability={null}
        startLoginImpl={recorder.impl}
        cancelLoginImpl={cancelLoginImpl}
      />,
      { wrapper: queryClientWrapper() },
    );

    // Attempt 1: presses start, gets a downloading answer, and asks again -
    // that second call is the one that will go stale.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    await act(async () => {
      recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
      await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
    });
    expect(recorder.calls).toHaveLength(2);

    // Cancelling while that second call is in flight ends attempt 1 at once
    // (matching the first test above) and returns the flow to a state a
    // fresh press is allowed from.
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByTestId("flow-state").textContent).toBe("cancelled");

    // Attempt 2 begins before attempt 1's own stale call has answered.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await Promise.resolve();
    });
    expect(recorder.calls).toHaveLength(3);
    expect(screen.getByTestId("flow-state").textContent).toBe("starting");

    // Attempt 1's stale call finally answers - a login it genuinely started,
    // for a profile it minted. It must not be attempt 2's to release.
    await act(async () => {
      recorder.calls[1].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-stale",
          url: "https://example.test/oauth-stale",
        }),
      );
      await Promise.resolve();
    });
    expect(cancelLoginImpl).not.toHaveBeenCalled();

    // Attempt 2's own call still settles normally - the guard against the
    // stale answer did not also break the attempt that replaced it.
    await act(async () => {
      recorder.calls[2].resolve(
        startLoginAnswer({
          started: true,
          profileId: "p-fresh",
          url: "https://example.test/oauth-fresh",
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("flow-state").textContent).toBe("waiting");
    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });
});

/**
 * Reauth of a target the flow names before the host has answered: the ambient
 * login (`existingProfileId` null, the in-chat banner's OAuth reconnect) or a
 * managed profile (the Settings reauth panel). `providers.cancelLogin` is
 * keyed by that target alone, so a cancel sent for a login this press never
 * started can end one another surface started for the same target.
 */
const REAUTH_TARGETS = [
  { target: "an ambient reauth", existingProfileId: null },
  { target: "a profile reauth", existingProfileId: "p1" },
] as const;

interface ReauthHarness {
  readonly recorder: StartLoginRecorder;
  readonly cancelLoginImpl: Mock<(request: CancelLoginRequest) => void>;
  readonly unmount: () => void;
}

function renderReauth(existingProfileId: string | null): ReauthHarness {
  const recorder = startLoginRecorder();
  const cancelLoginImpl = vi.fn<(request: CancelLoginRequest) => void>();
  const view = render(
    <LoginFlowHarness
      mode="reauth"
      existingProfileId={existingProfileId}
      loginCapability={GUI_OPENS_BROWSER}
      startLoginImpl={recorder.impl}
      cancelLoginImpl={cancelLoginImpl}
    />,
    { wrapper: queryClientWrapper() },
  );
  return { recorder, cancelLoginImpl, unmount: view.unmount };
}

async function pressStart(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await Promise.resolve();
  });
}

function pressCancel(): void {
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
}

function flowState(): string | null {
  return screen.getByTestId("flow-state").textContent;
}

describe.each(REAUTH_TARGETS)(
  "useProviderProfileLoginFlow - cancelling $target before the host holds a login",
  ({ existingProfileId }) => {
    const heldLogin: CancelLoginRequest = {
      providerId: PROVIDER_ID,
      profileId: existingProfileId,
    };

    /** Cancel while the pack downloads - the second question still on its
     *  way - then let that question answer. */
    async function cancelDuringDownload(
      inFlightAnswer: StartLoginResponse,
    ): Promise<Mock<(request: CancelLoginRequest) => void>> {
      vi.useFakeTimers();
      const { recorder, cancelLoginImpl } = renderReauth(existingProfileId);
      await pressStart();
      await act(async () => {
        recorder.calls[0].resolve(PACK_PREPARING_ANSWER);
        await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_PACK_POLL_MS);
      });
      expect(recorder.calls).toHaveLength(2);

      // Nothing runs on the host while the pack downloads, so the press ends
      // the flow without a host call - knowing the target up front does not
      // mean anything is running for it.
      pressCancel();
      expect(flowState()).toBe("cancelled");
      expect(cancelLoginImpl).not.toHaveBeenCalled();

      await act(async () => {
        recorder.calls[1].resolve(inFlightAnswer);
        await Promise.resolve();
      });
      expect(flowState()).toBe("cancelled");
      return cancelLoginImpl;
    }

    /** Cancel before the first question has answered at all. */
    async function cancelBeforeFirstAnswer(
      firstAnswer: StartLoginResponse,
    ): Promise<Mock<(request: CancelLoginRequest) => void>> {
      const { recorder, cancelLoginImpl } = renderReauth(existingProfileId);
      await pressStart();
      expect(recorder.calls).toHaveLength(1);

      // Nothing has said yet what this press started, so the answer decides.
      pressCancel();
      expect(flowState()).toBe("starting");
      expect(cancelLoginImpl).not.toHaveBeenCalled();

      await act(async () => {
        recorder.calls[0].resolve(firstAnswer);
        await Promise.resolve();
      });
      expect(flowState()).toBe("cancelled");
      expect(recorder.calls).toHaveLength(1);
      return cancelLoginImpl;
    }

    it("sends no cancel when the call already on its way answers that the pack is still preparing", async () => {
      const cancelLoginImpl = await cancelDuringDownload(PACK_PREPARING_ANSWER);
      expect(cancelLoginImpl).not.toHaveBeenCalled();
    });

    it("sends no cancel when the call already on its way answers that the host did not start a login", async () => {
      const cancelLoginImpl = await cancelDuringDownload(startLoginAnswer({}));
      expect(cancelLoginImpl).not.toHaveBeenCalled();
    });

    it("releases a login the call already on its way left still starting", async () => {
      const cancelLoginImpl = await cancelDuringDownload(
        startLoginAnswer({ pending: "starting" }),
      );
      expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
      expect(cancelLoginImpl).toHaveBeenCalledWith(heldLogin);
    });

    it("releases a login the call already on its way started", async () => {
      const cancelLoginImpl = await cancelDuringDownload(
        startLoginAnswer({ started: true, url: "https://example.test/oauth" }),
      );
      expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
      expect(cancelLoginImpl).toHaveBeenCalledWith(heldLogin);
    });

    it("sends no cancel when the first answer, landing after the press, is that the pack is still preparing", async () => {
      const cancelLoginImpl = await cancelBeforeFirstAnswer(
        PACK_PREPARING_ANSWER,
      );
      expect(cancelLoginImpl).not.toHaveBeenCalled();
    });

    it("releases the login the first answer, landing after the press, started", async () => {
      const cancelLoginImpl = await cancelBeforeFirstAnswer(
        startLoginAnswer({ started: true, url: "https://example.test/oauth" }),
      );
      expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
      expect(cancelLoginImpl).toHaveBeenCalledWith(heldLogin);
    });

    it("sends no cancel when the start call fails after the press", async () => {
      const { recorder, cancelLoginImpl } = renderReauth(existingProfileId);
      await pressStart();
      pressCancel();

      await act(async () => {
        recorder.calls[0].reject(new Error("host went away"));
        await Promise.resolve();
      });
      expect(flowState()).toBe("cancelled");
      expect(cancelLoginImpl).not.toHaveBeenCalled();
    });

    it("releases at once a login the host has already said it is still starting", async () => {
      const { recorder, cancelLoginImpl } = renderReauth(existingProfileId);
      await pressStart();
      await act(async () => {
        recorder.calls[0].resolve(startLoginAnswer({ pending: "starting" }));
        await Promise.resolve();
      });
      expect(recorder.calls).toHaveLength(2);

      pressCancel();
      expect(flowState()).toBe("cancelled");
      expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
      expect(cancelLoginImpl).toHaveBeenCalledWith(heldLogin);
    });
  },
);

/**
 * The Settings reauth panel shows Cancel from the moment it mounts, and
 * unmounts on the press - so whatever the answer holds is settled by a hook
 * nobody renders any more.
 */
describe("useProviderProfileLoginFlow - Cancel on a profile reauth panel", () => {
  function cancelledEvents(
    track: Mock<Analytics["track"]>,
  ): readonly unknown[][] {
    return track.mock.calls.filter(
      ([event]) => event === AnalyticsEvent.ProviderProfileLinkCancelled,
    );
  }

  it("ends the flow before its first start without cancelling a login it never asked for", () => {
    const { recorder, cancelLoginImpl } = renderReauth("p1");

    pressCancel();
    expect(recorder.calls).toHaveLength(0);
    expect(flowState()).toBe("cancelled");
    expect(cancelLoginImpl).not.toHaveBeenCalled();
  });

  it("releases the login the start call reports after the panel is gone, and reports the press once", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { recorder, cancelLoginImpl, unmount } = renderReauth("p1");
    await pressStart();
    pressCancel();
    unmount();

    await act(async () => {
      recorder.calls[0].resolve(
        startLoginAnswer({ started: true, url: "https://example.test/oauth" }),
      );
      await Promise.resolve();
    });
    expect(cancelLoginImpl).toHaveBeenCalledTimes(1);
    expect(cancelLoginImpl).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: "p1",
    });
    expect(cancelledEvents(track)).toEqual([
      [
        AnalyticsEvent.ProviderProfileLinkCancelled,
        { provider: PROVIDER_ID, mode: "reauth" },
      ],
    ]);
  });

  it("still reports the press when the start call fails after the panel is gone", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { recorder, cancelLoginImpl, unmount } = renderReauth("p1");
    await pressStart();
    pressCancel();
    unmount();

    await act(async () => {
      recorder.calls[0].reject(new Error("host went away"));
      await Promise.resolve();
    });
    expect(cancelLoginImpl).not.toHaveBeenCalled();
    expect(cancelledEvents(track)).toEqual([
      [
        AnalyticsEvent.ProviderProfileLinkCancelled,
        { provider: PROVIDER_ID, mode: "reauth" },
      ],
    ]);
  });
});
