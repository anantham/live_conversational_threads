import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "provenance-navigation.threads");
const DRIVE_FILE_ID = "mobile_drive_fixture_123";
const TITLE = "Provenance and navigation fixture";
const GOOGLE_OWNED_URL = /^https:\/\/(?:[^/]+\.)?(?:google\.com|googleapis\.com|googleusercontent\.com|gstatic\.com)(?:\/|$)/i;

type BrowserProblem = {
  type: string;
  text: string;
  url: string;
};

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

async function expectNodeBelowGraphHud(page: Page, node: Locator) {
  await expect.poll(async () => {
    const focusStatus = page.getByTestId("neighborhood-focus-status");
    const [nodeBox, tierBox, focusBox] = await Promise.all([
      node.boundingBox(),
      page.getByTitle("Locked to themes — click to unlock").boundingBox(),
      focusStatus.isVisible().then((visible) => visible ? focusStatus.boundingBox() : null),
    ]);
    if (!nodeBox || !tierBox) return Number.NEGATIVE_INFINITY;
    const hudBottom = Math.max(
      tierBox.y + tierBox.height,
      focusBox ? focusBox.y + focusBox.height : 0,
    );
    return nodeBox.y - hudBottom;
  }, { message: "First graph card should clear every visible graph HUD row" }).toBeGreaterThanOrEqual(8);
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
  const consoleProblems: BrowserProblem[] = [];
  const serverErrors: string[] = [];
  const googleRequestUrls: string[] = [];

  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleProblems.push({
        type: message.type(),
        text: message.text(),
        url: message.location().url || "",
      });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  await page.route(GOOGLE_OWNED_URL, (route) => {
    googleRequestUrls.push(route.request().url());
    return route.abort();
  });
  const backendlessResponse = {
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Backend intentionally absent in mobile cache test" }),
  };
  await page.route("**/api/**", (route) => route.fulfill(backendlessResponse));
  await page.route("**/conversations/**", (route) => route.fulfill(backendlessResponse));

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
  expect(googleRequestUrls).toEqual([]);

  const firstTheme = page.locator(".react-flow__node").filter({ hasText: "Compare the workflows" });
  await expect(firstTheme).toBeVisible();
  const sourceButton = firstTheme.getByRole("button", { name: "Open exact source utterances" });
  await expectTouchTarget(sourceButton, "Exact-source action");
  await expectNodeBelowGraphHud(page, firstTheme);
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
  const center = page.getByRole("button", { name: "Center", exact: true });
  await expectTouchTarget(center, "Center action");
  await center.tap();
  await expectNodeBelowGraphHud(page, connectedTheme);
  const showAll = page.getByRole("button", { name: "Show all", exact: true });
  await expectTouchTarget(showAll, "Show-all action");
  await showAll.tap();
  await center.tap();
  await expectNodeBelowGraphHud(page, firstTheme);

  const library = page.getByRole("button", { name: "Library", exact: true });
  await expectTouchTarget(library, "Library action");
  await library.tap();
  await expect(page.getByRole("heading", { name: /Library/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`^${TITLE} Opened`) }).tap();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });
  expect(googleRequestUrls).toEqual([]);
  expect(serverErrors).toEqual([]);
  // This deterministic backendless run returns an explicit 404 for Browse's
  // optional history probe. This worktree also resolves shared Fontsource
  // assets outside Vite's serve allow-list (tracked in ISSUES.md). Match both
  // by their exact message/source instead of muting generic load failures.
  const unexpectedConsoleProblems = consoleProblems.filter((problem) => {
    const problemPath = (() => {
      try {
        return new URL(problem.url).pathname;
      } catch {
        return "";
      }
    })();
    const expectedBackendlessHistory =
      problem.text.startsWith("[Browse] Server history unavailable:")
      && problem.text.includes("HTTP 404");
    const expectedBackendlessResource404 =
      problem.text === "Failed to load resource: the server responded with a status of 404 (Not Found)"
      && (/^\/api\//.test(problemPath) || /^\/conversations\/?$/.test(problemPath));
    const expectedWorktreeFont403 =
      problem.text === "Failed to load resource: the server responded with a status of 403 (Forbidden)"
      && /@fontsource[\\/]inter[\\/]files[\\/]/i.test(problem.url);
    return !expectedBackendlessHistory
      && !expectedBackendlessResource404
      && !expectedWorktreeFont403;
  });
  expect(unexpectedConsoleProblems).toEqual([]);
});
