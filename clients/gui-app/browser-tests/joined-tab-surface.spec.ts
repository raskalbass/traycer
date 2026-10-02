import { expect, test, type Page } from "@playwright/test";

import { THEME_PRESETS } from "../src/lib/theme-presets.ts";
import { fixture, nextFrames } from "./support/fixtures.ts";

// The joined active tab - the top strip's tab or split pair, or a side strip's
// row - reads as one surface with the sheet it runs into. That holds only if
// the tab's fill (the join's `--join-fill`, `index.css`) is the colour the
// task's own surface paints right under it. The task surface here is the REAL
// `EpicShell` (`&shell=1`), whose root paints the band under the strip: a
// stand-in that mirrors only the canvas frame cannot see that band, which is
// how a `--background` band came to sit under a `--canvas` tab in every
// preset whose two tokens differ. Every preset is read in both modes, then a
// custom theme whose surface tokens are pulled far apart.
//
// Colours are compared as painted sRGB bytes, not as computed strings, so
// one colour spelled two ways (hex palette vs oklch fallback) still matches.

test.describe.configure({ mode: "default" });

const WINDOW = { width: 1400, height: 860 } as const;

type JoinSide = "top" | "left" | "right";

interface SurfaceRead {
  readonly tab: string;
  readonly under: string;
  readonly underElement: string;
}

async function openShellCanvas(page: Page, query: string): Promise<void> {
  await page.setViewportSize(WINDOW);
  await page.goto(`${fixture("layout-editor-canvas")}?${query}&shell=1`);
  await page.waitForFunction("window.__layoutCanvasProbe?.ready === true");
  await nextFrames(page, 2);
}

async function setTheme(
  page: Page,
  preset: string,
  mode: "light" | "dark",
): Promise<void> {
  await page.evaluate(
    `import('/src/stores/settings/settings-store.ts').then(({ useSettingsStore }) => {
       useSettingsStore.getState().setTheme(${JSON.stringify(mode)});
       useSettingsStore.getState().setThemePreset(${JSON.stringify(preset)});
     })`,
  );
  await nextFrames(page, 2);
}

/**
 * The joined element's fill and the fill painted 4px inside the task surface,
 * straight across from the joined element's middle: under a top tab, beside a
 * side row. The point is a hit test, so whatever the product stacks there is
 * what is read; walking up skips transparent boxes to the one that paints.
 */
async function readSurfaces(page: Page, side: JoinSide): Promise<SurfaceRead> {
  return page.evaluate((joinSide) => {
    const toBytes = (color: string): string => {
      const ctx = new OffscreenCanvas(1, 1).getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",");
    };
    const joined = document.querySelector(`[data-sheet-joined="${joinSide}"]`);
    const frame = document.querySelector("[data-tab-edge]");
    if (joined === null) throw new Error(`no joined ${joinSide} element`);
    if (frame === null) throw new Error("no task surface frame");
    const j = joined.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    let x = j.left + j.width / 2;
    let y = f.top + 4;
    if (joinSide !== "top") {
      x = joinSide === "left" ? f.left + 4 : f.right - 4;
      y = j.top + j.height / 2;
    }
    // The topmost box OF THE SURFACE there: the strip's resize handle
    // overhangs the seam and paints nothing.
    let painter =
      document.elementsFromPoint(x, y).find((el) => frame.contains(el)) ?? null;
    while (
      painter !== null &&
      toBytes(getComputedStyle(painter).backgroundColor).endsWith(",0")
    ) {
      painter = painter.parentElement;
    }
    if (painter === null) throw new Error("nothing paints under the tab");
    const attrs = Array.from(painter.attributes)
      .filter((a) => a.name.startsWith("data-") || a.name === "class")
      .map((a) => `${a.name}="${a.value.slice(0, 60)}"`)
      .join(" ");
    return {
      tab: toBytes(getComputedStyle(joined).backgroundColor),
      under: toBytes(getComputedStyle(painter).backgroundColor),
      underElement: `<${painter.tagName.toLowerCase()} ${attrs}>`,
    };
  }, side);
}

const MODES = ["light", "dark"] as const;

/** Every preset in both modes: a mismatch lists each theme it shows in. */
async function expectJoinedAcrossThemes(
  page: Page,
  side: JoinSide,
  label: string,
): Promise<void> {
  const mismatches: string[] = [];
  for (const preset of THEME_PRESETS) {
    for (const mode of MODES) {
      await setTheme(page, preset.id, mode);
      const read = await readSurfaces(page, side);
      if (read.tab !== read.under) {
        mismatches.push(
          `${preset.id}/${mode}: tab rgba(${read.tab}) vs under rgba(${read.under}) on ${read.underElement}`,
        );
      }
    }
  }
  // A custom theme: the surface tokens pulled far apart, written where the
  // theme applier writes them, so no preset's near-equal pair can hide a
  // fill that reads the wrong one.
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty("--canvas", "#204060");
    root.setProperty("--background", "#602040");
    root.setProperty("--sidebar", "#406020");
  });
  await nextFrames(page, 2);
  const custom = await readSurfaces(page, side);
  if (custom.tab !== custom.under) {
    mismatches.push(
      `custom tokens: tab rgba(${custom.tab}) vs under rgba(${custom.under}) on ${custom.underElement}`,
    );
  }
  expect(
    mismatches,
    `${label}: the joined tab and the surface under it`,
  ).toEqual([]);
}

/** The themes the report named, photographed for the record. */
async function shoot(page: Page, side: JoinSide, name: string): Promise<void> {
  const shots: ReadonlyArray<readonly [string, "light" | "dark"]> = [
    ["traycer-green", "dark"],
    ["catppuccin", "dark"],
    ["neutral", "light"],
    ["neutral", "dark"],
  ];
  const box = await page
    .locator(`[data-sheet-joined="${side}"]`)
    .first()
    .boundingBox();
  if (box === null) throw new Error("joined element has no box");
  const clip =
    side === "top"
      ? { x: box.x - 60, y: box.y - 8, width: box.width + 120, height: 110 }
      : {
          x: box.x - 8,
          y: box.y - 40,
          width: box.width + 160,
          height: box.height + 80,
        };
  for (const [preset, mode] of shots) {
    await setTheme(page, preset, mode);
    await page.screenshot({
      path: test.info().outputPath(`${name}-${preset}-${mode}.png`),
      clip,
    });
  }
}

test("top: the active tab is the surface under it, in every theme", async ({
  page,
}) => {
  await openShellCanvas(page, "tabs=top&sidebar=left&header=app&surface=epic");
  await page.evaluate(
    "window.__layoutCanvasProbe.activateEpicTab('fixture-epsilon')",
  );
  await nextFrames(page, 2);
  await shoot(page, "top", "top-tab");
  await expectJoinedAcrossThemes(page, "top", "top tab");
});

test("top: the active split pair is the surface under it, in every theme", async ({
  page,
}) => {
  await openShellCanvas(page, "tabs=top&sidebar=left&header=app&surface=epic");
  await page.evaluate(
    "window.__layoutCanvasProbe.activateStripItem('fixture-split')",
  );
  await nextFrames(page, 2);
  await shoot(page, "top", "top-split");
  await expectJoinedAcrossThemes(page, "top", "top split pair");
});

test("side: the active row is the surface beside it, in every theme", async ({
  page,
}) => {
  // The panel on the far side, so the row meets the content sheet.
  await openShellCanvas(
    page,
    "tabs=left&sidebar=right&header=app&surface=epic",
  );
  await page.evaluate(
    "window.__layoutCanvasProbe.activateEpicTab('fixture-epsilon')",
  );
  await nextFrames(page, 2);
  await shoot(page, "left", "side-row");
  await expectJoinedAcrossThemes(page, "left", "side row");
});

test("side: a row meeting the panel is the panel beside it, in every theme", async ({
  page,
}) => {
  // The panel on the strip's side: the join takes the panel's fill instead.
  await openShellCanvas(page, "tabs=left&sidebar=left&header=app&surface=epic");
  await page.evaluate(
    "window.__layoutCanvasProbe.activateEpicTab('fixture-epsilon')",
  );
  await nextFrames(page, 2);
  await expectJoinedAcrossThemes(page, "left", "side row on the panel");
});
