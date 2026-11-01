/** Regression coverage for fractional rates, readable labels, and overflow within cards. */
import { test, expect, type Page } from "@playwright/test";

async function apply(page: Page, updates: number, interval: number) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Instrument count", { exact: true }).fill("50");
  await page
    .getByLabel("Updates per batch", { exact: true })
    .fill(String(updates));
  await page
    .getByLabel("Batch interval", { exact: true })
    .fill(String(interval));
  await page.getByRole("button", { name: "Apply settings" }).click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
}

test("target throughput preserves fractions through the actual template", async ({
  page,
}) => {
  await page.goto("");
  const rate = page
    .locator(".run-summary__card")
    .filter({ hasText: "TARGET THROUGHPUT" })
    .locator(".run-summary__value");
  for (const [updates, interval, expected] of [
    [1, 2000, "0.5"],
    [1, 1500, "0.67"],
    [100, 500, "200"],
    [1000, 50, "20,000"],
  ] as const) {
    await apply(page, updates, interval);
    await expect(rate).toHaveText(`${expected} trades / s`);
  }
});

test("maximum throughput fits every summary card at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("");
  await apply(page, 1000, 50);
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page
    .locator(".run-summary__card")
    .evaluateAll((nodes) =>
      nodes
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent),
    );
  expect(overflow).toEqual([]);
});

// Use a UI fixture for long counters without generating billions of trades or changing the production API.
async function useLargeTotals(page: Page) {
  await page.addInitScript(() => {
    window.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(command: {
        type: string;
        runId: number;
        settings?: { instrumentCount: number };
      }) {
        if (command.type !== "START_RUN") return;
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: { type: "STATUS", runId: command.runId, status: "Running" },
            }),
          );
          const volume = 123456789012345678901234567890n;
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                type: "SNAPSHOT",
                runId: command.runId,
                sequence: 1,
                trades: volume,
                batches: Number.MAX_SAFE_INTEGER,
                rows: Array.from(
                  { length: command.settings!.instrumentCount },
                  (_, i) => ({
                    symbol: `SIM${i + 1}`,
                    lastPriceCents: 10001,
                    spreadCents: 2,
                    volume,
                    notionalCents: volume * 10001n,
                    imbalance: -1 / 1999,
                  }),
                ),
              },
            }),
          );
        });
      }
      terminate() {}
    } as unknown as typeof Worker;
  });
}

for (const width of [320, 390, 1440]) {
  test(`long exact counters fit cards at ${width}px`, async ({ page }) => {
    await useLargeTotals(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("");
    await apply(page, 1000, 50);
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.locator(".run-summary__card").nth(1).locator(".run-summary__value"),
    ).toHaveText("123,456,789,012,345,678,901,234,567,890");
    await expect(
      page.locator(".instrument-table__imbalance > span:first-child").first(),
    ).toHaveText("0.00");
    const dimensions = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      cards: Array.from(document.querySelectorAll(".run-summary__card")).map(
        (e) => ({
          text: e.textContent,
          overflow: e.scrollWidth > e.clientWidth + 1,
        }),
      ),
    }));
    expect(dimensions.pageOverflow).toBe(false);
    expect(dimensions.cards.filter((c) => c.overflow)).toEqual([]);
    // The table intentionally scrolls within its own container.
    expect(
      await page
        .locator(".instrument-table__scroll")
        .evaluate((e) => getComputedStyle(e).overflowX),
    ).toBe("auto");
  });
}

test("secondary text remains readable on actual backgrounds", async ({
  page,
}) => {
  await useLargeTotals(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("");
  await expect(page.locator(".instrument-table__unit").first()).toBeVisible();
  const check = async (selectors: string[]) => {
    for (const selector of selectors)
      await expect(page.locator(selector).first()).toBeVisible();
    const measurements = await page.evaluate((selectors) => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
      const luminance = (channels: number[]) =>
        channels
          .slice(0, 3)
          .map((v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      return selectors.map((selector) => {
        const e = document.querySelector(selector);
        if (!e) throw new Error(`Missing contrast target: ${selector}`);
        const style = getComputedStyle(e);
        const foreground = luminance(rgb(style.color));
        const backgrounds: number[][] = [];
        for (
          let ancestor: Element | null = e;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const background = getComputedStyle(ancestor);
          // Theme gradients use opaque RGB colors; check both endpoints.
          const stops = background.backgroundImage.match(/rgb\([^)]*\)/g);
          if (stops) {
            backgrounds.push(...stops.map(rgb));
            break;
          }
          const color = rgb(background.backgroundColor);
          if (color.length === 3 || color[3] === 1) {
            backgrounds.push(color);
            break;
          }
        }
        if (!backgrounds.length)
          throw new Error(`Unknown background for ${selector}`);
        const ratios = backgrounds.map((c) => {
          const bg = luminance(c);
          return (
            (Math.max(foreground, bg) + 0.05) /
            (Math.min(foreground, bg) + 0.05)
          );
        });
        return {
          selector,
          ratio: Math.min(...ratios),
          fontSize: parseFloat(style.fontSize),
        };
      });
    }, selectors);
    for (const m of measurements) {
      expect(m.ratio, `${m.selector} contrast`).toBeGreaterThanOrEqual(4.5);
      expect(m.fontSize, `${m.selector} size`).toBeGreaterThanOrEqual(11);
    }
  };
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await check([
      ".dashboard__caption span:first-child",
      ".instrument-table__unit",
      ".instrument-table__symbol small",
      ".run-summary__label",
      ".run-summary__note",
      ".run-summary__unit",
      ".app-shell__footer > div:first-child",
      ".page-heading__eyebrow",
    ]);
  }
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.locator(".active-configuration__footnote")).toBeVisible();
  await check([
    ".settings-field__meta",
    ".settings-field__input span",
    ".active-configuration__footnote",
  ]);
});
