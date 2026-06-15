import { test, expect, type Page } from "@playwright/test";
import { FIXTURE, FIXTURE_BUCKETS, TOKYO_STATION } from "./fixtures";

// Inject custom data before the harness module runs.
async function seed(
  page: Page,
  places: unknown = FIXTURE,
  buckets: unknown = FIXTURE_BUCKETS,
  home?: { home: { lat: number; lng: number }; radiusKm: number },
) {
  await page.addInitScript(
    ([p, b, h]) => {
      (window as any).__PLACES__ = p;
      (window as any).__BUCKETS__ = b;
      if (h) localStorage.setItem("someday-home", JSON.stringify(h));
    },
    [places, buckets, home] as const,
  );
}

const visibleMarkers = (page: Page) =>
  page.locator(".leaflet-marker-pane .dot").count();

async function gotoReady(page: Page) {
  await page.goto("/harness.html");
  await page.waitForFunction(() => (window as any).__ready__ === true);
  await expect(page.locator("#count")).toBeVisible();
}

test.describe("map base render", () => {
  test("renders one pin per place and a count", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    expect(await visibleMarkers(page)).toBe(FIXTURE.length);
    await expect(page.locator("#count")).toHaveText(`${FIXTURE.length}/${FIXTURE.length}`);
  });

  test("shows a chip per non-empty bucket with counts", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    // 5 fixture buckets are represented; "other" has none → no chip.
    await expect(page.locator(".chip")).toHaveCount(5);
    await expect(page.locator('.chip[data-bucket="food"]')).toHaveText("Food 1");
    await expect(page.locator('.chip[data-bucket="shopping"]')).toHaveText("Shopping 1");
  });

  test("popup shows name, quote and chain/verify flags", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    await page.locator(".leaflet-marker-pane .dot").first().click();
    const popup = page.locator(".leaflet-popup-content");
    await expect(popup).toContainText("Ramen Ichi");
    await expect(popup).toContainText("best tonkotsu");
  });
});

test.describe("category filter", () => {
  test("toggling a chip off hides that bucket", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    await page.locator('.chip[data-bucket="food"]').click();
    await expect(page.locator('.chip[data-bucket="food"]')).toHaveClass(/off/);
    expect(await visibleMarkers(page)).toBe(FIXTURE.length - 1);
  });

  test("clicking a lone-active chip restores all", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    // turn everything off except food by clicking food twice (off→solo? )
    // Simpler: turn off 4 of 5 buckets, leaving food solo, then click food.
    for (const b of ["cafe", "shopping", "sights", "area"]) {
      await page.locator(`.chip[data-bucket="${b}"]`).click();
    }
    expect(await visibleMarkers(page)).toBe(1);
    await page.locator('.chip[data-bucket="food"]').click(); // solo → all
    expect(await visibleMarkers(page)).toBe(FIXTURE.length);
  });
});

test.describe("search", () => {
  test("filters by name/category substring", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    await page.fill("#q", "ramen");
    expect(await visibleMarkers(page)).toBe(1);
    await page.fill("#q", "tokyo"); // city substring matches several
    expect(await visibleMarkers(page)).toBeGreaterThan(1);
    await page.fill("#q", "");
    expect(await visibleMarkers(page)).toBe(FIXTURE.length);
  });
});

test.describe("home + radius", () => {
  test("Set home reveals radius control and filters by distance", async ({ page }) => {
    await seed(page);
    await gotoReady(page);
    await expect(page.locator("#radius-wrap")).toBeHidden();

    // enter placing mode and click on Tokyo Station via the map API
    await page.locator("#set-home").click();
    await page.evaluate((ll) => {
      (window as any).__map.fire("click", { latlng: ll });
    }, TOKYO_STATION);

    await expect(page.locator("#radius-wrap")).toBeVisible();
    await expect(page.locator(".home-pin")).toBeVisible();
    await expect(page.locator(".leaflet-overlay-pane path")).toBeVisible(); // radius circle

    // default radius 2 km → Ramen Ichi + Coffee Two
    await expect(page.locator("#count")).toHaveText("2 within 2.0 km");

    // widen to 8 km → adds Tower Three + Ward Five (Osaka still out)
    await page.locator("#radius").fill("8");
    await expect(page.locator("#count")).toHaveText("4 within 8.0 km");
  });

  test("persists home across reload and Clear removes it", async ({ page }) => {
    await seed(page, FIXTURE, FIXTURE_BUCKETS, { home: TOKYO_STATION, radiusKm: 3 });
    await gotoReady(page);
    await expect(page.locator("#count")).toHaveText("2 within 3.0 km");
    await expect(page.locator(".home-pin")).toBeVisible();

    await page.locator("#clear-home").click();
    await expect(page.locator("#radius-wrap")).toBeHidden();
    await expect(page.locator("#count")).toHaveText(`${FIXTURE.length}/${FIXTURE.length}`);
  });
});
