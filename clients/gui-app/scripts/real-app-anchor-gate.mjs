// AppHeader placement + stay-open regression. Run: bun scripts/real-app-anchor-gate.mjs --out DIR
//
// Negative controls (each must FAIL the gate; they are not gate modes):
//  - pre-fix source, run against the unmodified fixture:
//      ANCHOR_GATE_USER_MENU_SOURCE=<saved user-menu.tsx>
//      ANCHOR_GATE_TOOLTIP_SOURCE=<saved tooltip-wrapper.tsx>
//      ANCHOR_GATE_TOOLTIP_PRIMITIVE_SOURCE=<saved ui/tooltip.tsx>
//  - assertion sensitivity, fault injection in the driver:
//      --fault close-after-placement   presses Escape once the popup is placed,
//      so EVERY case's stay-open assertions must fail. It proves the
//      assertions can fail; it says nothing about which cases the pre-fix
//      source breaks.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  connect,
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./gate-browser-support.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = "/src/__tests__/browser/real-app-anchor-gate.html";
const CHROME_LAUNCH_FLAGS = ["--force-device-scale-factor=1"];

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
const caseIndex = args.indexOf("--case");
const caseFilter = caseIndex >= 0 ? args[caseIndex + 1] : "";
assert(outIndex < 0 || outDir, "--out requires a directory");
const faultIndex = args.indexOf("--fault");
const fault = faultIndex >= 0 ? args[faultIndex + 1] : null;
assert(
  fault === null || fault === "close-after-placement",
  "--fault only supports close-after-placement",
);
const controls = {
  fault,
  tooltipSource: process.env.ANCHOR_GATE_TOOLTIP_SOURCE ?? null,
  tooltipPrimitiveSource:
    process.env.ANCHOR_GATE_TOOLTIP_PRIMITIVE_SOURCE ?? null,
  userMenuSource: process.env.ANCHOR_GATE_USER_MENU_SOURCE ?? null,
};

// Real users hold a click ~100-200ms. Base opens on mousedown, so a handler
// that toggles on the release closes the menu it just opened - a zero-length
// press/release hides it.
const CLICK_HOLD_MS = 150;
// TooltipProvider's default delay is 500ms.
const TOOLTIP_DELAY_MS = 500;
const SETTLE_MS = 350;

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const s = createTcpServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });
}

async function startViteServer() {
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const require = createRequire(import.meta.url);
  const vitePkg = require.resolve("vite/package.json");
  const vite = resolve(dirname(vitePkg), require(vitePkg).bin.vite);
  const server = spawn(
    "node",
    [
      vite,
      "--config",
      "scripts/real-app-anchor-gate.vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: project, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let serverError = "";
  server.stderr.on("data", (chunk) => (serverError += String(chunk)));
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      if ((await fetch(origin + FIXTURE_PATH)).ok) break;
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null) {
      await terminateProcessTree(server);
      throw new Error("Vite failed to start: " + serverError);
    }
    await delay(100);
  }
  return { origin, server };
}

async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  return r.result.value;
}

/** A case's own waits, once the app has booted. */
const CASE_TIMEOUT_MS = 15_000;

/**
 * The first load of a run compiles the whole app (the gate starts its own
 * Vite), which on a fresh CI runner no longer fits a case's wait. Boot the
 * fixture once, give it the long deadline, and let the dependency optimizer's
 * reload settle before any case measures anything.
 */
async function warmUp(client, origin) {
  await client.send("Page.navigate", {
    url: new URL(FIXTURE_PATH, origin).href,
  });
  await waitForSelector(client, '[data-testid="user-menu-trigger"]', 90_000);
  await delay(3_000);
}

async function waitForSelector(client, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await evaluate(
        client,
        `!!document.querySelector(${JSON.stringify(selector)})`,
      )
    )
      return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function rectOf(client, selector) {
  return evaluate(
    client,
    `window.anchorGate.rect(${JSON.stringify(selector)})?.toJSON() ?? null`,
  );
}

async function clickSelector(client, selector) {
  const rect = await rectOf(client, selector);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await delay(CLICK_HOLD_MS);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

// `app.notifications.open`'s default chord (see `pressNotificationsChord` in
// notifications-bell.test.tsx). CDP modifier bits: Ctrl=2, Shift=8.
async function pressNotificationsChord(client) {
  const CTRL_SHIFT = 2 | 8;
  for (const type of ["keyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key: "B",
      code: "KeyB",
      windowsVirtualKeyCode: 66,
      modifiers: CTRL_SHIFT,
    });
  }
}

// Real focus + a real key, the native open path for any DropdownMenuTrigger/
// PopoverTrigger - no synthetic dispatch.
async function focusAndPressKey(client, selector, key) {
  await evaluate(
    client,
    `document.querySelector(${JSON.stringify(selector)}).focus()`,
  );
  const codes = { Enter: 13, ArrowDown: 40 };
  for (const type of ["keyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: codes[key],
      text: type === "keyDown" && key === "Enter" ? "\r" : "",
    });
  }
}

async function screenshot(client, path) {
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(path, Buffer.from(data, "base64"));
}

function awaitRafs(client, count) {
  return evaluate(
    client,
    `new Promise((resolve) => { let n = ${count}; const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`,
  );
}

async function moveMouse(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function pressEscape(client) {
  for (const type of ["keyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  }
}

function sampleOpen(client, triggerSelector, popupSelector) {
  return evaluate(
    client,
    `({ same: window.anchorTrigger === document.querySelector(${JSON.stringify(triggerSelector)}), expanded: window.anchorTrigger.getAttribute("aria-expanded"), presented: window.anchorGate.isPresented(${JSON.stringify(popupSelector)}), tooltipShown: document.querySelector('[data-slot="tooltip-content"]') !== null })`,
  );
}

// The popup must survive what happens right after opening: the click release,
// time, animation frames, and the pointer resting on (or returning to) the
// trigger past the tooltip delay - while no tooltip shows over it.
async function sampleStayOpen(client, triggerSelector, popupSelector) {
  if (fault === "close-after-placement") await pressEscape(client);
  const sample = () => sampleOpen(client, triggerSelector, popupSelector);
  const stayOpen = {};
  await awaitRafs(client, 5);
  await delay(SETTLE_MS);
  stayOpen.settled = await sample();
  const rect = await rectOf(client, triggerSelector);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await moveMouse(client, x, y);
  await delay(TOOLTIP_DELAY_MS + 200);
  await awaitRafs(client, 3);
  stayOpen.pointerRest = await sample();
  await moveMouse(client, 10, 700);
  await delay(100);
  await moveMouse(client, x, y);
  await delay(TOOLTIP_DELAY_MS + 200);
  await awaitRafs(client, 3);
  stayOpen.pointerReturn = await sample();
  return stayOpen;
}

function assertStaysOpen(name, stayOpen) {
  for (const [phase, snap] of Object.entries(stayOpen)) {
    assert(
      snap.same && snap.expanded === "true" && snap.presented,
      `${name} stay-open ${phase}: popup closed or trigger replaced: ${JSON.stringify(snap)}`,
    );
    assert(
      !snap.tooltipShown,
      `${name} stay-open ${phase}: tooltip is showing over the open popup`,
    );
  }
}

async function runCase(
  client,
  origin,
  { name, trigger, popupSelector, gesture },
  exceptions,
) {
  console.log(`--- ${name} ---`);
  exceptions.length = 0;
  await client.send("Page.navigate", {
    url: new URL(FIXTURE_PATH, origin).href,
  });
  const triggerSelector =
    trigger === "avatar"
      ? '[data-testid="user-menu-trigger"]'
      : '[data-testid="notifications-bell"]';
  await waitForSelector(client, triggerSelector, CASE_TIMEOUT_MS);
  await evaluate(client, "document.fonts.ready");
  await evaluate(
    client,
    `window.anchorTrigger = document.querySelector(${JSON.stringify(triggerSelector)}); window.anchorGate.start(${JSON.stringify(popupSelector)}); undefined`,
  );

  const before = await rectOf(client, triggerSelector);
  assert(before !== null, `${name}: trigger did not render`);
  assert(
    before.left > 200,
    `${name}: trigger not at the title bar's right edge (left=${before.left})`,
  );

  if (gesture === "click") await clickSelector(client, triggerSelector);
  else if (gesture === "keybinding") await pressNotificationsChord(client);
  else if (gesture === "keyboard-enter")
    await focusAndPressKey(client, triggerSelector, "Enter");
  else if (gesture === "keyboard-arrowdown")
    await focusAndPressKey(client, triggerSelector, "ArrowDown");
  else throw new Error(`Unknown gesture: ${gesture}`);

  // Evidence first: a popup that closes itself can make `finish()` reject, and
  // the record must still carry the stay-open samples.
  let placement = null;
  let placementError = null;
  try {
    placement = await evaluate(client, `window.anchorGate.finish()`);
  } catch (error) {
    placementError = String(error);
  }
  const stayOpen = await sampleStayOpen(client, triggerSelector, popupSelector);
  const identity = await evaluate(
    client,
    `({ same: window.anchorTrigger === document.querySelector(${JSON.stringify(triggerSelector)}), connected: window.anchorTrigger.isConnected, originalRect: window.anchorTrigger.getBoundingClientRect().toJSON(), activeElement: document.activeElement?.outerHTML.slice(0,200) })`,
  );
  const record = {
    name,
    controls,
    before,
    placement,
    placementError,
    stayOpen,
    identity,
    exceptions: [...exceptions],
  };
  if (outDir !== null) {
    await writeFile(
      resolve(outDir, `${name.replaceAll("/", "-")}.json`),
      JSON.stringify(record, null, 2),
    );
    await screenshot(
      client,
      resolve(outDir, `${name.replaceAll("/", "-")}.png`),
    );
  }
  assert(
    exceptions.length === 0,
    `${name}: page threw: ${exceptions.join("\n")}`,
  );

  console.log(`  stay-open=${JSON.stringify(stayOpen)}`);
  assertStaysOpen(name, stayOpen);
  assert(placement !== null, `${name}: ${placementError}`);

  console.log(`  trigger before=${JSON.stringify(before)}`);
  console.log(`  first placement=${JSON.stringify(placement.first)}`);
  console.log(`  final placement=${JSON.stringify(placement.final)}`);

  const triggerRight = before.right;
  for (const [phase, snap] of Object.entries(placement)) {
    assert(
      Math.abs(snap.rect.right - triggerRight) <= 2,
      `${name} ${phase}: popup right=${snap.rect.right}, trigger right=${triggerRight}`,
    );
    const offset = trigger === "avatar" ? 6 : 4;
    assert(
      Math.abs(snap.rect.top - (before.bottom + offset)) <= 2,
      `${name} ${phase}: popup top=${snap.rect.top}, expected ${before.bottom + offset}`,
    );
    assert(
      Math.abs(parseFloat(snap.anchorWidth) - before.width) <= 1,
      `${name} ${phase}: anchor width=${snap.anchorWidth}, trigger width=${before.width}`,
    );
  }
  assert(
    identity.same && identity.connected,
    `${name}: opening replaced the trigger node`,
  );
  console.log("  PASS");
}

// Not `align="end"`/fixed-offset like the title-bar cases, so no exact-
// geometry assertions - just that toggling narrow while open doesn't remount
// the trigger or close the menu, either direction. One function per `kind`
// (fixture query value + its trigger/popup selectors), not a duplicate per
// component.
const NARROW_TOGGLE_KINDS = {
  "permissions-picker": {
    triggerSelector: 'button[aria-haspopup="menu"]',
    popupSelector: '[data-slot="dropdown-menu-positioner"]',
  },
  "workspace-folder": {
    triggerSelector: '[data-testid="folder-add"]',
    popupSelector: '[data-slot="popover-positioner"]',
  },
};

async function runNarrowToggleCase(client, origin, kind, gesture, exceptions) {
  const name = `${kind}/${gesture}/toggle-while-open`;
  console.log(`--- ${name} ---`);
  exceptions.length = 0;
  const { triggerSelector, popupSelector } = NARROW_TOGGLE_KINDS[kind];
  const url = new URL(FIXTURE_PATH, origin);
  url.searchParams.set("fixture", kind);
  await client.send("Page.navigate", { url: url.href });
  await waitForSelector(client, triggerSelector, CASE_TIMEOUT_MS);
  await evaluate(client, "document.fonts.ready");
  await evaluate(
    client,
    `window.anchorTrigger = document.querySelector(${JSON.stringify(triggerSelector)}); undefined`,
  );

  if (gesture === "click") await clickSelector(client, triggerSelector);
  else await focusAndPressKey(client, triggerSelector, "Enter");
  await waitForSelector(client, popupSelector, CASE_TIMEOUT_MS);

  const stayOpen = await sampleStayOpen(client, triggerSelector, popupSelector);
  const identity = () =>
    evaluate(
      client,
      `({ same: window.anchorTrigger === document.querySelector(${JSON.stringify(triggerSelector)}), connected: window.anchorTrigger.isConnected, expanded: window.anchorTrigger.getAttribute("aria-expanded"), menuOpen: window.anchorGate.isPresented(${JSON.stringify(popupSelector)}) })`,
    );

  await evaluate(
    client,
    "window.anchorGate.setComposerNarrow(true); undefined",
  );
  await awaitRafs(client, 2);
  const afterNarrow = await identity();
  // The narrow context can flip trigger labels while the popup is open, so the
  // stay-open checks must also run in that state, not only before the toggle.
  const narrowStayOpen = await sampleStayOpen(
    client,
    triggerSelector,
    popupSelector,
  );
  await evaluate(
    client,
    "window.anchorGate.setComposerNarrow(false); undefined",
  );
  await awaitRafs(client, 2);
  const afterWide = await identity();

  const record = {
    name,
    controls,
    stayOpen,
    narrowStayOpen,
    afterNarrow,
    afterWide,
    exceptions: [...exceptions],
  };
  if (outDir !== null) {
    await writeFile(
      resolve(outDir, `${name.replaceAll("/", "-")}.json`),
      JSON.stringify(record, null, 2),
    );
  }
  assert(
    exceptions.length === 0,
    `${name}: page threw: ${exceptions.join("\n")}`,
  );
  assertStaysOpen(name, stayOpen);
  assertStaysOpen(`${name} (narrow)`, narrowStayOpen);
  for (const [phase, snap] of [
    ["narrow", afterNarrow],
    ["wide", afterWide],
  ]) {
    assert(
      snap.same && snap.connected && snap.expanded === "true" && snap.menuOpen,
      `${name} ${phase}: remounted the trigger or the menu is not presented: ${JSON.stringify(snap)}`,
    );
  }
  console.log("  PASS");
}

async function main() {
  if (outDir !== null) await mkdir(outDir, { recursive: true });
  let server, chrome, client;
  const results = [];
  async function cleanup() {
    client?.close();
    if (chrome) {
      await terminateProcessTree(chrome.chrome);
      await rm(chrome.profilePath, {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
    }
    if (server) await terminateProcessTree(server);
  }
  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });
  try {
    const started = await startViteServer();
    server = started.server;
    chrome = await launchChromeWithDevTools(
      await findChrome("real-app-anchor-gate"),
      "traycer-real-app-anchor-gate-",
      CHROME_LAUNCH_FLAGS,
    );
    const response = await fetch(
      new URL("/json/new?about:blank", chrome.devtoolsHttpUrl),
      { method: "PUT" },
    );
    assert(response.ok);
    const target = await response.json();
    const exceptions = [];
    client = await connect(target.webSocketDebuggerUrl, exceptions, 30000);
    await client.send("Page.enable", {});
    await client.send("Runtime.enable", {});
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const cases = [
      {
        name: "bell/click",
        trigger: "bell",
        popupSelector: '[data-slot="popover-positioner"]',
        gesture: "click",
      },
      {
        name: "bell/keybinding",
        trigger: "bell",
        popupSelector: '[data-slot="popover-positioner"]',
        gesture: "keybinding",
      },
      {
        name: "avatar/click",
        trigger: "avatar",
        popupSelector: '[data-slot="dropdown-menu-positioner"]',
        gesture: "click",
      },
      {
        name: "avatar/keyboard",
        trigger: "avatar",
        popupSelector: '[data-slot="dropdown-menu-positioner"]',
        gesture: "keyboard-enter",
      },
      {
        name: "avatar/keyboard-arrowdown",
        trigger: "avatar",
        popupSelector: '[data-slot="dropdown-menu-positioner"]',
        gesture: "keyboard-arrowdown",
      },
    ].filter((c) => c.name.includes(caseFilter));
    const toggleCases = Object.keys(NARROW_TOGGLE_KINDS)
      .flatMap((kind) =>
        ["click", "keyboard"].map((gesture) => ({ kind, gesture })),
      )
      .filter(({ kind, gesture }) => `${kind}/${gesture}`.includes(caseFilter));
    assert(cases.length > 0 || toggleCases.length > 0, "No matching cases");
    await warmUp(client, started.origin);
    for (const testCase of cases) {
      try {
        await runCase(client, started.origin, testCase, exceptions);
        results.push({ name: testCase.name, pass: true });
      } catch (error) {
        console.error(error);
        results.push({
          name: testCase.name,
          pass: false,
          error: String(error),
          exceptions: [...exceptions],
        });
      }
    }
    for (const { kind, gesture } of toggleCases) {
      const name = `${kind}/${gesture}/toggle-while-open`;
      try {
        await runNarrowToggleCase(
          client,
          started.origin,
          kind,
          gesture,
          exceptions,
        );
        results.push({ name, pass: true });
      } catch (error) {
        console.error(error);
        results.push({
          name,
          pass: false,
          error: String(error),
          exceptions: [...exceptions],
        });
      }
    }
    if (outDir !== null)
      await writeFile(
        resolve(outDir, "results.json"),
        JSON.stringify(results, null, 2),
      );
    assert(
      results.every((r) => r.pass),
      "Anchoring regressions failed",
    );
    console.log(`PASS ${results.length} anchoring cases`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
