import { chromium, Browser, Page } from "playwright";
import { uploadToR2 } from "./r2.js";
import { fileURLToPath } from "node:url";
import path from "node:path";


type CaptureRes = { key: string; url: string };

async function launch(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/** 任意の selector を撮影して R2 へ */
export async function captureElementToR2(opts: {
  url: string;
  selector: string;
  r2Key: string;
  wait?: number; // 追加の待機ms
}): Promise<CaptureRes> {
  const browser = await launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 2000 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: "networkidle" });
    if (opts.wait) await page.waitForTimeout(opts.wait);

    const el = await page.waitForSelector(opts.selector, { timeout: 15000 });
    const png = await el.screenshot({ type: "png" });

    const { url } = await uploadToR2(opts.r2Key, png, "image/png");
    return { key: opts.r2Key, url };
  } finally {
    await browser.close();
  }
}

/** プロフィール撮影（例：#profile-header を撮る） */
export async function captureProfile(handle: string): Promise<CaptureRes> {
  const base = process.env.UI_ORIGIN || "http://localhost:3000";
  const url = `${base}/accounts/@${handle}`;
  const r2Key = `screenshots/${handle}/${new Date().toISOString().slice(0,10)}/profile.png`;
  return captureElementToR2({
    url,
    selector: "#profile-header",
    r2Key,
    wait: Number(process.env.EXTRA_WAIT_MS ?? 0),
  });
}

/** 直近ポスト群（例） */
export async function captureLatestPosts(handle: string): Promise<CaptureRes> {
  const base = process.env.UI_ORIGIN || "http://localhost:3000";
  const url = `${base}/accounts/@${handle}`;
  const r2Key = `screenshots/${handle}/${new Date().toISOString().slice(0,10)}/posts.png`;
  return captureElementToR2({
    url,
    selector: "#latest-posts",
    r2Key,
    wait: Number(process.env.EXTRA_WAIT_MS ?? 0),
  });
}

/** ハンドル1件をまとめて更新 */
export async function refreshHandle(handle: string): Promise<{
  handle: string;
  profile: CaptureRes;
  posts: CaptureRes;
}> {
  const profile = await captureProfile(handle);
  const posts = await captureLatestPosts(handle);
  return { handle, profile, posts };
}

// ESM-safe main check
const __filename = fileURLToPath(import.meta.url);
const isMain =
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const [, , h] = process.argv;
  if (!h) {
    console.error("Usage: node dist/scrape.js <handle>");
    process.exit(1);
  }
  refreshHandle(h)
    .then((r) => console.log(JSON.stringify({ ok: true, ...r }, null, 2)))
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: String(e) }, null, 2));
      process.exit(1);
    });
}