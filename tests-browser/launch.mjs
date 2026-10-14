/**
 * Playwright Chromium launcher. Browsers are cached; nothing is downloaded.
 * `executablePath` is passed explicitly: newer playwright-core may expect a
 * different bundled build than the cached ones, so the chain below prefers
 * the cached builds, then system Chrome.
 */
import fs from "node:fs";

const CANDIDATES = [
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  "/usr/bin/google-chrome",
];

export function executableCandidates() {
  return CANDIDATES.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

export async function launchChromium({ headless = true } = {}) {
  const { chromium } = await import("playwright-core");
  const tried = [];
  for (const exe of executableCandidates()) {
    try {
      const browser = await chromium.launch({
        executablePath: exe, headless, args: ["--no-sandbox"],
      });
      return { browser, executablePath: exe };
    } catch (err) {
      tried.push(`${exe}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`no usable Chromium (tried: ${tried.join(" | ") || "no candidates found"})`);
}
