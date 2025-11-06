// scrape_hybrid.js
import { chromium } from "playwright";
import sharp from "sharp";
import { uploadToR2 } from "./r2.js";

// ==== tunables ====
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 60);
const TARGET_WIDTH = Number(process.env.TARGET_WIDTH ?? 900);
const CAPTURE_TIMEOUT = Number(process.env.CAPTURE_TIMEOUT_MS ?? 45000);
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1200);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 1800);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);

const SELECTOR_TWEET = (process.env.SELECTOR_TWEET ?? 'article[data-testid="tweet"]').trim();
const SELECTOR_PROFILE = (process.env.SELECTOR_PROFILE ?? 'main [data-testid="UserName"]').trim();

// ==== shared browser/context ====
let _browserPromise = null;
let _ctxPromise = null;

async function getSharedContext() {
  if (!_ctxPromise) {
    _ctxPromise = (async () => {
      if (!_browserPromise) {
        _browserPromise = chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"]
        });
      }
      const browser = await _browserPromise;
      const storage = process.env.PLAYWRIGHT_STORAGE_STATE;
      const ctx = await browser.newContext({
        viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        ...(storage ? { storageState: JSON.parse(storage) } : {}),
      });

      // 不要リソース遮断
      await ctx.route("**/*", (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        if (
          ["media", "font", "websocket", "eventsource"].includes(type) ||
          /\b(analytics|doubleclick|adsystem|advertising|scribe|metrics)\b/i.test(url)
        ) return route.abort();
        return route.continue();
      });

      ctx.setDefaultTimeout(CAPTURE_TIMEOUT);
      return ctx;
    })();
  }
  return _ctxPromise;
}

// ==== screenshot helpers ====
async function toJpeg(buf) {
  return await sharp(buf).resize({ width: TARGET_WIDTH }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

async function screenshotByLocator(page, sel) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "visible", timeout: 8000 }).catch(()=>{});
  await el.scrollIntoViewIfNeeded().catch(()=>{});
  await page.waitForTimeout(250);
  const box = await el.boundingBox();
  if (!box || box.width < 2 || box.height < 2) throw new Error(`no valid box for ${sel}`);
  const png = await el.screenshot({ type: "png" });
  return toJpeg(png);
}

async function screenshotFull(page) {
  const png = await page.screenshot({ fullPage: true, type: "png" });
  return toJpeg(png);
}

// ==== main capture routines ====
async function gotoProfile(page, handle) {
  const user = handle.replace(/^@/, "");
  const urls = [
    `https://m.x.com/${user}`,
    `https://m.twitter.com/${user}`,
    `https://x.com/${user}`,
  ];
  let ok = false;
  for (const url of urls) {
    try {
      console.log("[capture:url]", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT });
      await waitForAny(page, [
        'article[data-testid="tweet"]',
        'main [data-testid="UserName"]',
      ], 8000);
      ok = true;
      break;
    } catch {
      // retry next
    }
  }
  if (!ok) throw new Error("all URLs failed");
  await page.waitForTimeout(300);
}

async function waitForAny(page, selectors, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const s of selectors) {
      const el = await page.$(s);
      if (el) return s;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function captureProfile(page, handle) {
  await gotoProfile(page, handle);
  let buf;
  try {
    buf = await screenshotByLocator(page, SELECTOR_PROFILE);
  } catch {
    buf = await screenshotFull(page);
  }
  await uploadToR2(`accounts/${handle}/profile.jpg`, buf, "image/jpeg");
}

async function captureLatestPosts(page, handle) {
  const loc = page.locator(SELECTOR_TWEET);
  const count = await loc.count().catch(()=>0);
  const take = Math.min(3, count || 3);
  for (let i = 0; i < take; i++) {
    let jpg;
    try {
      jpg = await screenshotByLocator(page, `${SELECTOR_TWEET} >> nth=${i}`);
    } catch {
      jpg = await screenshotFull(page);
    }
    await uploadToR2(`accounts/${handle}/posts/${i + 1}.jpg`, jpg, "image/jpeg");
  }
}

// ==== high-level handlers ====
export async function refreshHandle(handle) {
  const ctx = await getSharedContext();
  const page = await ctx.newPage();
  try {
    await captureProfile(page, handle);
    await captureLatestPosts(page, handle);
    return { handle, ok: true };
  } catch (e) {
    return { handle, ok: false, error: String(e?.message || e) };
  } finally {
    await page.close().catch(()=>{});
  }
}

export async function refreshMany(handles = []) {
  const list = handles.filter(Boolean);
  const max = Math.max(1, CONCURRENCY);
  const results = [];
  let i = 0;
  const run = async () => {
    while (i < list.length) {
      const idx = i++;
      const h = list[idx];
      results.push(await refreshHandle(h));
    }
  };
  await Promise.all(Array.from({ length: max }, run));
  return results;
}
