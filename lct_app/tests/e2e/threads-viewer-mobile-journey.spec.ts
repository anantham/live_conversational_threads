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
 * - A recipient can complete the shared-map journey with gestures and touch-safe controls at 375px.
 * - Left/Right stays temporal inside one parent; Down drills and Up restores the exact branch.
 * - Exact utterances show speaker, timestamp, transcript text, and a recording deep link.
 * - Long utterances scroll natively instead of being mistaken for abstraction gestures.
 * - Secondary actions remain absent from primary chrome and available through the More sheet.
 * - More-sheet notices stay perceivable and do not click through to covered controls.
 * - The optional map returns to cards, and browser-local Drive reopening never contacts Google.
 * - Every exercised control is touch-safe, emits no unexpected errors, and causes no overflow.
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

async function swipeDeck(page: Page, deltaX: number, deltaY: number) {
  const stage = page.getByTestId("mobile-deck-stage");
  await expect(stage).toBeVisible();
  const box = await stage.boundingBox();
  if (!box) throw new Error("Mobile deck stage did not have a bounding box.");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (Math.abs(deltaY) > Math.abs(deltaX)) {
    await stage.evaluate((element, delta) => {
      const rect = element.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      const first = new Touch({
        clientX: startX,
        clientY: startY,
        identifier: 1,
        target: element,
      });
      const last = new Touch({
        clientX: startX + delta.x,
        clientY: startY + delta.y,
        identifier: 1,
        target: element,
      });
      element.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [first],
      }));
      element.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        changedTouches: [last],
      }));
    }, { x: deltaX, y: deltaY });
    return;
  }
  const pointerId = Date.now() % 100000;
  await stage.dispatchEvent("pointerdown", {
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: start.x,
    clientY: start.y,
  });
  await stage.dispatchEvent("pointerup", {
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: start.x + deltaX,
    clientY: start.y + deltaY,
  });
}

async function nativeTouchScroll(page: Page, card: Locator) {
  const box = await card.boundingBox();
  if (!box) throw new Error("Scrollable card did not have a bounding box.");
  const x = box.x + box.width / 2;
  const startY = box.y + box.height * 0.72;
  const endY = box.y + box.height * 0.28;
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY }],
  });
  for (let step = 1; step <= 6; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: startY + ((endY - startY) * step) / 6 }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

async function associateCachedArtifactWithDrive(page: Page) {
  await page.evaluate(async ({ driveFileId, title }) => {
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
    const record = records.find((candidate) => candidate.title === title);
    if (!record) throw new Error("Saved mobile fixture was not found in the Threads library.");
    record.driveFileId = driveFileId;
    store.put(record);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, { driveFileId: DRIVE_FILE_ID, title: TITLE });
}

test("a phone recipient can traverse a Drive-backed conversation from arc to utterance", async ({ page }, testInfo) => {
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
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Auditable process redesign");
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mobile-deck-arc.png"), fullPage: true });

  const pageWidth = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.body.scrollWidth,
  }));
  expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.viewport);
  expect(googleRequestUrls).toEqual([]);

  for (const name of [
    "Open conversation map",
    "More conversation options",
    "Move to a higher level of abstraction",
    "Previous arc",
    "Next arc",
    "Drill into a finer level of detail",
  ]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }), name);
  }

  await swipeDeck(page, 0, 90);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Compare the workflows");
  await swipeDeck(page, -90, 0);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Keep faster review auditable");
  await swipeDeck(page, 90, 0);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Compare the workflows");

  await swipeDeck(page, 0, 90);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Speed and exposed assumptions");
  await swipeDeck(page, 0, 90);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Compare before redesigning");
  await swipeDeck(page, 0, 90);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Compare the current process");
  await swipeDeck(page, -90, 0);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Earlier assumptions were visible");
  await swipeDeck(page, 0, 90);

  const utteranceCard = page.getByTestId("mobile-deck-card");
  await expect(utteranceCard).toHaveAttribute("data-kind", "utterance");
  await expect(utteranceCard).toContainText("Speaker B");
  await expect(utteranceCard).toContainText("The earlier approach was slower");
  const recordingLink = utteranceCard.getByRole("link", { name: /Open recording at this time/ });
  await expect(recordingLink).toContainText("0:08");
  await expect(recordingLink).toHaveAttribute(
    "href",
    "https://drive.google.com/file/d/mobile-fixture-recording/view?t=6",
  );
  await page.screenshot({ path: testInfo.outputPath("mobile-deck-utterance.png"), fullPage: true });

  await swipeDeck(page, 0, -90);
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Earlier assumptions were visible");
  await swipeDeck(page, 0, 90);
  await expect(page.getByTestId("mobile-deck-card")).toHaveAttribute("data-kind", "utterance");
  await expect(page.getByTestId("mobile-deck-stage")).toHaveCSS("touch-action", "pan-y");
  await page.getByTestId("mobile-deck-card").locator("blockquote").evaluate((element) => {
    element.textContent = Array.from({ length: 80 }, (_, index) => `Readable line ${index + 1}.`).join(" ");
  });
  await expect.poll(() => page.getByTestId("mobile-deck-card").evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await page.getByTestId("mobile-deck-card").focus();
  await expect(page.getByTestId("mobile-deck-card")).toBeFocused();
  await page.getByTestId("mobile-deck-card").evaluate((element) => { element.scrollTop = 0; });
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.getByTestId("mobile-deck-card").evaluate(
    (element) => element.scrollTop,
  )).toBeGreaterThan(0);
  await expect(page.getByTestId("mobile-deck-card")).toHaveAttribute("data-kind", "utterance");
  await page.getByTestId("mobile-deck-card").evaluate((element) => { element.scrollTop = 0; });
  await nativeTouchScroll(page, page.getByTestId("mobile-deck-card"));
  await expect.poll(() => page.getByTestId("mobile-deck-card").evaluate(
    (element) => element.scrollTop,
  )).toBeGreaterThan(0);
  await expect(page.getByTestId("mobile-deck-card")).toHaveAttribute("data-kind", "utterance");
  await page.getByRole("button", { name: "Move to a higher level of abstraction" }).click();
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Earlier assumptions were visible");

  const more = page.getByRole("button", { name: "More conversation options", exact: true });
  await more.click();
  const options = page.getByRole("dialog", { name: "Conversation options" });
  await expect(options).toBeVisible();
  await expect(options).toContainText("Download transcript");
  await expect(options).toContainText("Library");
  await expect(options).toContainText("Refresh from Drive");
  await expect(options).toContainText("Open another file");
  await expect(options).toHaveCSS("opacity", "1");
  const deckBackground = page.getByTestId("mobile-deck-background");
  await expect(deckBackground).toHaveAttribute("inert", "");
  const hiddenMapAction = page.locator('button[aria-label="Open conversation map"]');
  await hiddenMapAction.focus();
  await page.keyboard.press("Enter");
  await expect(options).toBeVisible();
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await expect(options).toContainText("Conversation options");
  await page.screenshot({ path: testInfo.outputPath("mobile-deck-options.png"), fullPage: true });
  await options.getByRole("button", { name: "Close" }).click();
  await expect(deckBackground).not.toHaveAttribute("inert", "");

  await page.getByRole("button", { name: "Open conversation map" }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  const returnToCards = page.getByRole("button", { name: "Return to conversation cards" });
  await expectTouchTarget(returnToCards, "Return-to-cards action");
  const readMapTopGap = () => page.locator(".react-flow__node").evaluateAll((nodes) => {
    const graph = nodes[0]?.closest(".react-flow");
    if (!graph || nodes.length === 0) throw new Error("ReactFlow viewport is missing");
    const graphTop = graph.getBoundingClientRect().top;
    return Math.min(...nodes.map((node) => node.getBoundingClientRect().top - graphTop));
  });
  await expect.poll(async () => {
    const first = await readMapTopGap();
    await page.waitForTimeout(350);
    const second = await readMapTopGap();
    const firstInBand = first >= 60 && first <= 100;
    const secondInBand = second >= 60 && second <= 100;
    return firstInBand && secondInBand && Math.abs(first - second) <= 2;
  }, { timeout: 5_000 }).toBe(true);
  const mapTopGap = await readMapTopGap();
  expect(mapTopGap).toBeGreaterThanOrEqual(60);
  expect(mapTopGap).toBeLessThanOrEqual(100);
  await returnToCards.click();
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Earlier assumptions were visible");

  await page.getByRole("button", { name: "More conversation options" }).click();
  await page.getByRole("dialog", { name: "Conversation options" })
    .getByRole("button", { name: /Library/ })
    .click();
  await expect(page.getByRole("heading", { name: /Library/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`^${TITLE} Opened`) }).click();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-deck-card")).toBeVisible({ timeout: 15_000 });
  expect(googleRequestUrls).toEqual([]);
  expect(serverErrors).toEqual([]);
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

test("More notices remain accessible and absorb taps above the modal", async ({ page }) => {
  const backendlessResponse = {
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Backend intentionally absent in mobile notice test" }),
  };
  await page.route("**/api/**", (route) => route.fulfill(backendlessResponse));
  await page.route("**/conversations/**", (route) => route.fulfill(backendlessResponse));

  await page.goto("/browse", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "More conversation options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Conversation options" });
  await expect(options).toBeVisible();
  await options.getByRole("button", { name: /themes/i }).click();

  const notice = page.getByTestId("mobile-deck-notice");
  await expect(notice).toContainText(/theme/);
  await expect(notice).toBeVisible();
  expect(await notice.evaluate((element) => Boolean(element.closest('[aria-hidden="true"], [inert]'))))
    .toBe(false);
  await notice.click();
  await expect(options).toBeVisible();
});
