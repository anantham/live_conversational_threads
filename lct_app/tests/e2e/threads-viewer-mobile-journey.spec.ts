import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "provenance-navigation.threads");
const DRIVE_FILE_ID = "mobile_drive_fixture_123";
const TITLE = "Provenance and navigation fixture";

/*
 * Test intent:
 * - A recipient can complete the core shared-map journey using touch only at 375px.
 * - The map reopens from its browser-local Drive association without contacting Google.
 * - Primary controls in that journey expose a 48px physical touch target on coarse pointers.
 * - A tapped aggregate reveals its exact source utterances and returns to the graph cleanly.
 * - Library navigation, reopening, and refresh preserve the artifact without horizontal overflow.
 * - The exercised route emits no browser-console warnings/errors or network 5xx responses.
 *
 * This deliberately uses a synthetic artifact. Real Google OAuth remains a post-deploy device
 * check; this test owns the local, deterministic persistence and interaction contract.
 */

test.use({
  viewport: { width: 375, height: 812 },
  screen: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

async function expectTouchTarget(locator: Locator, label: string) {
  await expect(locator, `${label} should be visible`).toBeVisible();
  await expect.poll(async () => (await locator.boundingBox())?.width || 0, {
    message: `${label} should settle at least 48px wide`,
  }).toBeGreaterThanOrEqual(48);
  await expect.poll(async () => (await locator.boundingBox())?.height || 0, {
    message: `${label} should settle at least 48px high`,
  }).toBeGreaterThanOrEqual(48);
}

async function expectNodeBelowTierHud(page: Page, node: Locator) {
  await expect.poll(async () => {
    const [nodeBox, tierBox] = await Promise.all([
      node.boundingBox(),
      page.getByTitle("Locked to themes — click to unlock").boundingBox(),
    ]);
    if (!nodeBox || !tierBox) return Number.NEGATIVE_INFINITY;
    return nodeBox.y - (tierBox.y + tierBox.height);
  }, { message: "First graph card should clear the tier HUD" }).toBeGreaterThanOrEqual(8);
}

async function associateCachedArtifactWithDrive(page) {
  await page.evaluate(async (driveFileId) => {
    const request = indexedDB.open("lct_threads_library", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("artifacts", "readwrite");
    const store = transaction.objectStore("artifacts");
    const getRequest = store.getAll();
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    });
    const record = records.find((candidate) => candidate.title === "Provenance and navigation fixture");
    if (!record) throw new Error("Saved mobile fixture was not found in the Threads library.");
    record.driveFileId = driveFileId;
    store.put(record);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, DRIVE_FILE_ID);
}

test("a phone recipient can reopen, understand, inspect, and return to a Drive-backed map", async ({ page }, testInfo) => {
  const consoleProblems: string[] = [];
  const serverErrors: string[] = [];
  let googleRequests = 0;

  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  await page.route("https://accounts.google.com/**", (route) => {
    googleRequests += 1;
    return route.abort();
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/conversations/**", (route) => route.abort());

  await page.goto("/browse", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Saved on this device")).toBeVisible({ timeout: 15_000 });
  await associateCachedArtifactWithDrive(page);

  await page.goto(`/view?driveFile=${DRIVE_FILE_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("mobile-map-before.png"), fullPage: true });

  const pageWidth = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.body.scrollWidth,
  }));
  expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.viewport);
  expect(googleRequests).toBe(0);

  const firstTheme = page.locator(".react-flow__node").filter({ hasText: "Compare the workflows" });
  await expect(firstTheme).toBeVisible();
  const sourceButton = firstTheme.getByRole("button", { name: "Open exact source utterances" });
  await expectTouchTarget(sourceButton, "Exact-source action");
  await expectNodeBelowTierHud(page, firstTheme);
  await page.screenshot({ path: testInfo.outputPath("mobile-map-settled.png"), fullPage: true });
  await sourceButton.tap();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("We should compare the current process");
  await expect(dialog).toContainText("The earlier approach was slower");
  const exactTurn = dialog.getByText(/We should compare the current process/);
  await exactTurn.scrollIntoViewIfNeeded();
  await expect(exactTurn).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-source-sheet.png"), fullPage: true });
  const closeButton = dialog.getByRole("button", { name: "Close" });
  await expectTouchTarget(closeButton, "Source-sheet Close action");
  await closeButton.tap();
  await expect(dialog).toBeHidden();

  const connectedTheme = page.locator(".react-flow__node")
    .filter({ hasText: "Keep faster review auditable" });
  await expect(connectedTheme).toBeInViewport();
  await connectedTheme.tap();
  await expect(page.getByTestId("neighborhood-focus-status"))
    .toContainText("Related to: Keep faster review auditable");
  const showAll = page.getByRole("button", { name: "Show all", exact: true });
  await expectTouchTarget(showAll, "Show-all action");
  await showAll.tap();
  const center = page.getByRole("button", { name: "Center", exact: true });
  await expectTouchTarget(center, "Center action");
  await center.tap();
  await expectNodeBelowTierHud(page, firstTheme);

  const library = page.getByRole("button", { name: "Library", exact: true });
  await expectTouchTarget(library, "Library action");
  await library.tap();
  await expect(page.getByRole("heading", { name: /Library/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`^${TITLE} Opened`) }).tap();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
  expect(googleRequests).toBe(0);
  expect(serverErrors).toEqual([]);
  // This deterministic backendless run aborts Browse's optional history probe,
  // and this worktree resolves shared Fontsource assets outside Vite's serve
  // allow-list (tracked in ISSUES.md). Keep those explicit and reject every
  // other browser warning/error instead of muting the console wholesale.
  const unexpectedConsoleProblems = consoleProblems.filter((problem) => ![
    /Failed to load resource: net::ERR_FAILED/,
    /\[Browse\] Server history unavailable: TypeError: Failed to fetch/,
    /Failed to load resource: the server responded with a status of 403 \(Forbidden\)/,
  ].some((expected) => expected.test(problem)));
  expect(unexpectedConsoleProblems).toEqual([]);
});
