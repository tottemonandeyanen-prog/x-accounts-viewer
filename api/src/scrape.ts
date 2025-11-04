import { chromium, BrowserContext, Page } from "playwright";
import sharp from "sharp";
import { uploadToR2 } from "./r2.js";

const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 70);
const TARGET_WIDTH = Number(process.env.TARGET_WIDTH ?? 900);

// ストレージステート（ログイン済みCookie）を使って m.twitter.com にアクセス
async function newContext(): Promise<BrowserContext> {
  const storage = process.env.PLAYWRIGHT_STORAGE_STATE!;
  return chromium.launchPersistentContext("", {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    storageState: JSON.parse(storage) // Secret Managerから渡されたJSON文字列
  } as any);
}

// 汎用：ページを撮影して圧縮
async function screenshotCompressed(page: Page): Promise<Buffer> {
  const png = await page.screenshot({ fullPage: true, type: "png" });
  const img = sharp(png).resize({ width: TARGET_WIDTH }).jpeg({ quality: JPEG_QUALITY });
  return await img.toBuffer();
}

// プロフィール撮影（モバイル版は軽量で崩れにくい）
async function captureProfile(page: Page, handle: string) {
  await page.goto(`https://m.twitter.com/${handle.replace(/^@/,"")}`, { waitUntil: "domcontentloaded" });
  // プロフィールヘッダを中心に（なければ全体）
  const buf = await screenshotCompressed(page);
  const key = `accounts/${handle}/profile.jpg`;
  return uploadToR2(key, buf);
}

// 直近3投稿URLを抽出して各ツイート詳細を撮影
async function captureLatestPosts(page: Page, handle: string) {
  // タイムラインからtweetへのリンクを収集
  await page.waitForTimeout(800); // 軽めの待機
  const links = await page.$$eval('a[href*="/status/"]', as =>
    Array.from(new Set(as.map(a => (a as HTMLAnchorElement).href))).slice(0, 3)
  );
  const urls = links as string[];

  const results: string[] = [];
  for (let i = 0; i < Math.min(3, urls.length); i++) {
    const url = urls[i];
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const buf = await screenshotCompressed(page);
    const key = `accounts/${handle}/posts/${i+1}.jpg`;
    const publicUrl = await uploadToR2(key, buf);
    results.push(publicUrl);
  }
  // 足りない枚数は前ページのタイムライン全体を代替で埋める（常に3枚維持）
  while (results.length < 3) {
    const buf = await screenshotCompressed(page);
    const key = `accounts/${handle}/posts/${results.length+1}.jpg`;
    results.push(await uploadToR2(key, buf));
  }
  return results;
}

export async function refreshHandle(handle: string) {
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    const profile = await captureProfile(page, handle);
    const posts = await captureLatestPosts(page, handle);
    return { handle, profile, posts };
  } finally {
    await ctx.close();
  }
}
