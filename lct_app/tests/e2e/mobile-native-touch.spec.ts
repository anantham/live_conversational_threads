import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Test intent: use browser-dispatched touches, not synthetic DOM pointer events.
// - Horizontal swipes navigate both kinds of scroll-container card exactly once.
// - Vertical swipes navigate short cards, while long cards retain native scrolling.
// - Touch navigation controls still drill and restore the selected parent.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function swipe(page: Page, dx: number, dy: number, cancel = false) {
  const card = page.getByTestId("mobile-deck-card");
  // Let the existing card entrance settle before choosing physical coordinates.
  await card.evaluate(async element => {
    await Promise.all(element.parentElement!.getAnimations({ subtree: true }).map(a => a.finished));
  });
  const box = await card.boundingBox();
  if (!box) throw new Error("The conversation card has no touchable bounds");
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.55;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }],
      });
      await page.waitForTimeout(20);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

async function open(page: Page, longUtterance = false) {
  const bundle = JSON.parse(await readFile(new URL("./fixtures/provenance-navigation.threads", import.meta.url), "utf8"));
  // Keep two utterances inside the same moment: sibling navigation is parent-bound.
  const firstMoment = bundle.graph_data.find(node => node.id === "moment-1");
  firstMoment.utterance_ids = ["u1", "u2"];
  firstMoment.source_ref = { utterance_ids: ["u1", "u2"], start_seq: 1, end_seq: 2 };
  firstMoment.timestamp_end = 18;
  if (longUtterance) bundle.utterances[0].text = "A long source passage remains readable. ".repeat(120);
  await page.route("**/api/**", route => route.fulfill({ status: 404, body: "{}" }));
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles({
    name: "native-touch.threads", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(page.getByTestId("mobile-deck-card")).toContainText("Auditable process redesign");
}

test("horizontal native swipes navigate node and utterance cards", async ({ page }) => {
  await open(page);
  const card = page.getByTestId("mobile-deck-card");
  const down = page.getByRole("button", { name: "Drill into a finer level of detail", exact: true });
  await down.tap();
  await swipe(page, -120, 0);
  await expect(card).toContainText("Keep faster review auditable");
  await swipe(page, 120, 0);
  await expect(card).toContainText("Compare the workflows");
  for (let i = 0; i < 4; i++) await down.tap();
  await expect(card).toContainText("We should compare the current process");
  await swipe(page, -120, 0);
  await expect(card).toContainText("The earlier approach was slower");
  await swipe(page, 120, 0);
  await expect(card).toContainText("We should compare the current process");
  await page.getByRole("button", { name: "Move to a higher level of abstraction", exact: true }).tap();
  await expect(card).toContainText("Compare the current process");
});

test("vertical native swipes drill short cards and restore their parent", async ({ page }) => {
  await open(page);
  const card = page.getByTestId("mobile-deck-card");
  await swipe(page, 0, 120);
  await expect(card).toContainText("Compare the workflows");
  await swipe(page, 0, -120);
  await expect(card).toContainText("Auditable process redesign");
});

test("a cancelled touch does not navigate or poison the next gesture", async ({ page }) => {
  await open(page);
  const card = page.getByTestId("mobile-deck-card");
  await swipe(page, 0, 120, true);
  await expect(card).toContainText("Auditable process redesign");
  await swipe(page, 0, 120);
  await expect(card).toContainText("Compare the workflows");
});

test("long source text scrolls without changing abstraction or blocking horizontal navigation", async ({ page }) => {
  await open(page, true);
  const card = page.getByTestId("mobile-deck-card");
  for (let i = 0; i < 5; i++) {
    await page.getByRole("button", { name: "Drill into a finer level of detail", exact: true }).tap();
  }
  await expect(card).toContainText("A long source passage remains readable");
  await swipe(page, 0, -120);
  await expect.poll(() => card.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(card).toHaveAttribute("data-kind", "utterance");
  await expect(card).toContainText("A long source passage remains readable");
  await swipe(page, -120, 0);
  await expect(card).toContainText("The earlier approach was slower");
});
