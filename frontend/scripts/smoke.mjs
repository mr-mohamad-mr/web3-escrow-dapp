// Headless end-to-end smoke test for the frontend.
//
// Prerequisites (all local):
//   1. `npm run node` in the project root (Hardhat node on :8545)
//   2. `npm run seed:local` in the project root (8 seeded escrows)
//   3. The frontend served: `npm run dev` (:5173) or `npm run preview`
//      (:4173) in this folder — set BASE_URL to match.
//
// It drives the real UI with puppeteer-core against the locally cached
// Chrome: connect, check the seeded escrows render, open the milestone
// showcase ("Dashboard build"), then — as the freelancer — deliver its
// last milestone and — as the client — release it, asserting the
// on-screen state after each confirmed transaction.
//
//   BASE_URL=http://127.0.0.1:4173 node scripts/smoke.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:4173";
const TIMEOUT = 30_000;

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const cacheRoot = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  for (const version of fs.readdirSync(cacheRoot).sort().reverse()) {
    const candidate = path.join(cacheRoot, version, "chrome-linux64", "chrome");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No cached Chrome found under ${cacheRoot}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function waitForText(page, selector, text) {
  await page.waitForFunction(
    (sel, t) => {
      const el = document.querySelector(sel);
      return el && el.textContent.includes(t);
    },
    { timeout: TIMEOUT },
    selector,
    text
  );
}

async function selectAccountByLabel(page, label) {
  await page.waitForSelector('[data-testid="account-select"]', { timeout: TIMEOUT });
  const value = await page.$eval(
    '[data-testid="account-select"]',
    (select, wanted) => {
      const option = [...select.options].find((o) => o.textContent.startsWith(wanted));
      return option ? option.value : null;
    },
    label
  );
  assert(value, `account option "${label}" exists`);
  await page.select('[data-testid="account-select"]', value);
}

async function waitTxConfirmed(page, labelPart) {
  await page.waitForFunction(
    (part) => {
      const banner = document.querySelector('[data-testid="tx-banner"]');
      return (
        banner &&
        banner.dataset.status === "confirmed" &&
        banner.textContent.includes(part)
      );
    },
    { timeout: TIMEOUT },
    labelPart
  );
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

  try {
    console.log(`Opening ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: "networkidle0", timeout: TIMEOUT });

    console.log("Connecting the local wallet…");
    await page.click('[data-testid="connect-btn"]');
    await page.waitForSelector('[data-testid="escrow-card"]', { timeout: TIMEOUT });

    const cards = await page.$$('[data-testid="escrow-card"]');
    assert(cards.length === 8, `escrow list shows the 8 seeded escrows (got ${cards.length})`);

    const listText = await page.$eval(".escrow-list", (el) => el.textContent);
    for (const status of ["Created", "Funded", "Delivered", "Released", "Disputed", "Resolved", "Refunded"]) {
      assert(listText.includes(status), `list includes a ${status} escrow`);
    }

    console.log("Opening the milestone showcase (Dashboard build)…");
    const showcase = await page.$$eval('[data-testid="escrow-card"]', (els) => {
      const el = els.find((e) => e.textContent.includes("Dashboard build"));
      return el ? el.dataset.address : null;
    });
    assert(showcase, "showcase escrow card found");
    await page.$$eval('[data-testid="escrow-card"]', (els) => {
      els.find((e) => e.textContent.includes("Dashboard build")).click();
    });
    await page.waitForSelector('[data-testid="escrow-detail"]', { timeout: TIMEOUT });
    await waitForText(page, '[data-testid="escrow-detail"]', "Milestones");

    const milestoneCards = await page.$$('[data-testid="milestone-card"]');
    assert(milestoneCards.length === 3, `showcase has 3 milestone cards (got ${milestoneCards.length})`);
    const timelineItems = await page.$$('[data-testid="timeline"] .timeline-item');
    assert(timelineItems.length >= 5, `timeline renders the escrow's history (${timelineItems.length} entries)`);

    const lastCard = '[data-testid="milestone-card"][data-index="2"]';
    await waitForText(page, lastCard, "Pending");

    console.log("Delivering milestone 3 as the freelancer…");
    await selectAccountByLabel(page, "Freelancer");
    await page.click(`${lastCard} [data-testid="deliver-btn"]`);
    await waitTxConfirmed(page, "Deliver milestone 3");
    await waitForText(page, lastCard, "Delivered");
    assert(true, "milestone 3 shows Delivered after the confirmed tx");

    console.log("Releasing milestone 3 as the client…");
    await selectAccountByLabel(page, "Client");
    await page.click(`${lastCard} [data-testid="release-btn"]`);
    await waitTxConfirmed(page, "Release milestone 3");
    await waitForText(page, lastCard, "Released");
    assert(true, "milestone 3 shows Released after the confirmed tx");

    await waitForText(page, '[data-testid="escrow-detail"]', "0.975");
    assert(true, "freelancer pending withdrawal is 0.975 ETH (1 ETH − 2.5% fee)");

    const screenshot = process.env.SMOKE_SCREENSHOT || "/tmp/escrow-frontend-smoke.png";
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`Screenshot: ${screenshot}`);
    console.log("\nSMOKE OK — frontend loaded the seeded escrows and completed deliver + release live.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\nSMOKE FAILED: ${error.message}`);
  process.exit(1);
});
