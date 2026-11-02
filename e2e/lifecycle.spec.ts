import { expect, test } from "@playwright/test";

test("rapid Apply during Wasm loading activates only the latest run", async ({
  page,
  context,
}) => {
  let createdWorkers = 0;
  page.on("worker", () => createdWorkers++);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requested = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/wasm/*.wasm", async (route) => {
    requested = true;
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto("");
    await expect.poll(() => requested).toBe(true);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByLabel("Instrument count", { exact: true }).fill("50");
    await page.getByLabel("Updates per batch", { exact: true }).fill("1000");
    await page.getByLabel("Batch interval", { exact: true }).fill("50");
    // Dispatch in one task so all resets race with the unresolved Wasm initialization.
    await page.locator("form").evaluate((form) => {
      for (let i = 0; i < 100; i++) (form as HTMLFormElement).requestSubmit();
    });
    release();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator(".instrument-table__run")).toContainText(
      "RUN 101",
    );
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("tbody tr")).toHaveCount(50);
    await expect(
      page.locator(".instrument-table__price").first(),
    ).not.toHaveText("N/A");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Resume", exact: true }),
    ).toBeEnabled();
    const paused = await page.locator("tbody").innerText();
    await page.waitForTimeout(300);
    expect(await page.locator("tbody").innerText()).toBe(paused);
    expect(createdWorkers).toBe(1);
    expect(page.workers()).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    release();
    await context.unroute("**/wasm/*.wasm");
  }
});

test("repeated load failures and runtime crashes release Workers before Retry", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  let createdWorkers = 0;
  let closedWorkers = 0;
  page.on("worker", (worker) => {
    createdWorkers++;
    worker.on("close", () => closedWorkers++);
  });
  const retry = page.getByRole("button", {
    name: "Retry with current settings",
  });
  await context.route("**/wasm/*.wasm", (route) => route.abort());
  await page.goto("");
  for (let i = 0; i < 10; i++) {
    await expect(page.getByRole("alert")).toContainText(
      "Market engine unavailable",
    );
    await expect.poll(() => page.workers().length).toBe(0);
    expect(closedWorkers).toBe(createdWorkers);
    if (i < 9) await retry.click();
  }
  await context.unroute("**/wasm/*.wasm");
  await retry.click();
  await expect(page.locator(".instrument-table__price").first()).not.toHaveText(
    "N/A",
  );
  const cdp = await context.newCDPSession(page);
  const retained = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return {
      heap: await cdp.send("Runtime.getHeapUsage"),
      dom: await cdp.send("Memory.getDOMCounters"),
    };
  };
  const beforeRetries = await retained();
  for (let i = 0; i < 10; i++) {
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeEnabled();
    await expect.poll(() => page.workers().length).toBe(1);
    // Exercise the browser's real Worker error event, not a forged protocol message.
    await page.workers()[0].evaluate(() => {
      setTimeout(() => {
        throw new Error("Lifecycle test crash");
      }, 0);
    });
    await expect(page.getByRole("alert")).toContainText("Lifecycle test crash");
    await expect.poll(() => page.workers().length).toBe(0);
    expect(closedWorkers).toBe(createdWorkers);
    await retry.click();
  }
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".instrument-table__price").first()).not.toHaveText(
    "N/A",
  );
  const afterRetries = await retained();
  expect(afterRetries.heap.usedSize - beforeRetries.heap.usedSize).toBeLessThan(
    2 * 1048576,
  );
  expect(afterRetries.dom.nodes - beforeRetries.dom.nodes).toBeLessThanOrEqual(
    20,
  );
  expect(
    afterRetries.dom.jsEventListeners - beforeRetries.dom.jsEventListeners,
  ).toBeLessThanOrEqual(5);
  await test.info().attach("retry-retained-memory", {
    body: JSON.stringify({ beforeRetries, afterRetries }),
    contentType: "application/json",
  });
  await cdp.detach();
  expect(createdWorkers).toBe(21);
  expect(closedWorkers).toBe(20);
  await page.close();
  await expect.poll(() => closedWorkers).toBe(createdWorkers);
});

test("reloading and closing the page releases its previous Worker", async ({
  page,
}) => {
  let created = 0;
  let closed = 0;
  page.on("worker", (worker) => {
    created++;
    worker.on("close", () => closed++);
  });
  await page.goto("");
  for (let i = 0; i < 10; i++) {
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeEnabled();
    await expect.poll(() => page.workers().length).toBe(1);
    await expect.poll(() => closed).toBe(created - 1);
    await page.reload();
  }
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect.poll(() => closed).toBe(10);
  expect(created).toBe(11);
  await page.close();
  await expect.poll(() => closed).toBe(11);
});
