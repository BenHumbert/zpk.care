/**
 * Which Chromium the demo runs on (adapted from SwapStreet's site-e2e/lib/metamask.mjs chromiumPath()).
 *
 * Playwright 1.63.0 expects chromium-1243, which this machine does not have, and `npx playwright install` must
 * never be run (it would download it). The SwapStreet takes ran on chromium-1200 (Chrome 143), so that build is
 * the default here. PW_CHROMIUM_PATH overrides it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PW_ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || '', '.cache'), 'ms-playwright');
export const PINNED_CHROMIUM = path.join(PW_ROOT, 'chromium-1200', 'chrome-win64', 'chrome.exe');

export function chromiumPath() {
  if (process.env.PW_CHROMIUM_PATH) {
    if (!fs.existsSync(process.env.PW_CHROMIUM_PATH)) throw new Error(`PW_CHROMIUM_PATH does not exist: ${process.env.PW_CHROMIUM_PATH}`);
    return process.env.PW_CHROMIUM_PATH;
  }
  if (fs.existsSync(PINNED_CHROMIUM)) return PINNED_CHROMIUM;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // fall through to the installed builds
  }
  const dirs = fs.existsSync(PW_ROOT)
    ? fs.readdirSync(PW_ROOT).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(PW_ROOT, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`no Playwright Chromium under ${PW_ROOT}. Set PW_CHROMIUM_PATH (do not run npx playwright install).`);
}

/** One headless Chromium for the whole take. */
export function launchBrowser({ headless = true, args = [] } = {}) {
  return chromium.launch({
    executablePath: chromiumPath(),
    headless,
    // keep hidden pages painting and their timers running: every person's page records the whole take
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...args]
  });
}
