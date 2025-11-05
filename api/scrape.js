import { chromium } from "playwright";
import sharp from "sharp";
import { uploadToR2 } from "./r2.js";

const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 70);
const TARGET_WIDTH  = Number(process.env.TARGET_WIDTH  ?? 900);
const CAPTURE_TIMEOUT = Number(process.env.CAPTURE_TIMEOUT_MS ?? 60000);

// 環境変数
const UI_BASE = process.env.UI_BASE?.replace(/\/+$/, ""); // 例: http://localhost:5173
const SELECTOR_PROFILE = (process.env.SELECTOR_PROFILE ?? "").trim(); // 自作UIの #profile-header 等
const SELECTOR_TWEET   = (process.env.SELECTOR_TWEET ?? 'article[data-testid="tweet"]').trim();

// UIモードか判定
const IS_UI_MODE = !!UI_BASE;

async function screenshotUnion(page, selectors, { pad = 12 } = {}) {
  const boxes = [];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: 1500 });
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      if (box && box.width > 2 && box.height > 2) boxes.push(box);
    } catch { /* optional selector → スキップ */ }
  }
  if (!boxes.length) throw new Error("no visible boxes for union");

  const minX = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad);
  const minY = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad);
  const maxX = Math.max(...boxes.map(b => b.x + b.width)) + pad;
  const maxY = Math.max(...boxes.map(b => b.y + b.height)) + pad;

  const clip = {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY),
  };
  const png = await page.screenshot({ type: "png", clip });
  return await toJpeg(png);
}

async function newContext() {
  const storage = process.env.PLAYWRIGHT_STORAGE_STATE;
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const viewport = {
    width:  Number(process.env.VIEWPORT_W ?? 1400),
    height: Number(process.env.VIEWPORT_H ?? 2200),
  };
  // Context 作成時に viewport を指定する（正しいやり方）
  const ctx = await browser.newContext({
    viewport,
    ...(storage ? { storageState: JSON.parse(storage) } : {})
  });
  ctx.setDefaultTimeout(CAPTURE_TIMEOUT);
  return ctx;
}

async function toJpeg(pngBuf) {
  return await sharp(pngBuf)
    .resize({ width: TARGET_WIDTH })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

async function screenshotFull(page) {
  const png = await page.screenshot({ fullPage: true, type: "png" });
  return await toJpeg(png);
}

async function screenshotByLocator(page, locator) {
  const el = page.locator(locator).first();
  // DOM に付くだけでなく可視になるまで待つ
  await el.waitFor({ state: "visible" });
  // 画面内に入れてからレイアウト安定を少しだけ待つ
  await el.scrollIntoViewIfNeeded();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(400);
  // サイズ 0 の誤撮影防止
  const box = await el.boundingBox();
  if (!box || box.width < 2 || box.height < 2) {
    throw new Error(`locator(${locator}) has invalid size: ${JSON.stringify(box)}`);
  }
  const png = await el.screenshot({ type: "png" });
  return await toJpeg(png);
}

// ====== ナビゲーション ======
async function gotoProfile(page, handle) {
  const user = handle.replace(/^@/, "");
  if (IS_UI_MODE) {
    await page.setViewportSize({ width: 1400, height: 2200 });

    const candidates = [
      UI_PATH_TMPL.replace("{handle}", user).replace("@{handle}", `@${user}`),
      `/accounts/${user}`,
      `/accounts/@${user}`,
      `/index.html#/accounts/@${user}`,
      `/#/accounts/@${user}`,
      `/index.html`
    ].map(p => `${UI_BASE}${p}`);

    let ok = false;
    for (const url of candidates) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT });
        // どれか一つでも“見えたら”OKにする（厳密縛りをやめる）
        for (const sel of ALT_WAIT_SELECTORS) {
          try {
            await page.locator(sel).first().waitFor({ state: "visible", timeout: 4000 });
            ok = true;
            break;
          } catch {}
        }
        if (ok) break;
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(()=>{});
      } catch {}
    }
    // 見つからなくても続行（後段でフルページ撮影フォールバックあり）
    await page.waitForTimeout(500);
    return;
  }

  // X本体モード（既存のまま）
  const storage = process.env.PLAYWRIGHT_STORAGE_STATE;
  if (!storage) throw new Error("X本体を撮る場合は PLAYWRIGHT_STORAGE_STATE が必要です（ログイン状態JSON）");
  await page.goto(`https://m.twitter.com/${user}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
}

// ====== 撮影 ======
async function captureProfile(page, handle) {
  await gotoProfile(page, handle);

  // UIモード: 自作UIのセレクタで要素撮影
  if (IS_UI_MODE) {
    const target = SELECTOR_PROFILE || "#profile-header";
    let buf;
    try {
      buf = await screenshotByLocator(page, target);
    } catch {
      // 代替セレクタを順に試す
      for (const alt of ALT_WAIT_SELECTORS) {
        try { buf = await screenshotByLocator(page, alt); break; } catch {}
      }
      if (!buf) buf = await screenshotFull(page); // 最後の保険
    }
    const key = `accounts/${handle}/profile.jpg`;
    return uploadToR2(key, buf);
  }

  // 旧モード（X本体）
  let buf;
  try {
    await page.waitForLoadState("domcontentloaded");
    // プロフの核になる要素たち（存在しないものは無視）
    const unionTargets = [
      'main [data-testid="UserName"]',
      'main [data-testid^="UserAvatar-Container-"]',
      'main [data-testid="UserDescription"]',
      'main [data-testid="UserProfileHeader_Items"]',
      'main a[href$="/header_photo"]', // バナー（あれば）
      'main a[href$="/following"]',
      'main a[href$="/followers"]',
      'main a[href$="/verified_followers"]',
    ];
    buf = await screenshotUnion(page, unionTargets, { pad: 16 });
  } catch (e) {
    console.warn("[captureProfile] union failed -> fallback:", e?.message);
    // 最後の保険：単一セレクタがセットされていればそれを試す
    if (SELECTOR_PROFILE) {
      try { buf = await screenshotByLocator(page, SELECTOR_PROFILE); }
      catch { buf = await screenshotFull(page); }
    } else {
      buf = await screenshotFull(page);
    }
  }
  const key = `accounts/${handle}/profile.jpg`;
  return uploadToR2(key, buf);
}

async function captureLatestPosts(page, handle) {
  // UIモードなら自作UI側の #post-1, #post-2... などを推奨
  if (IS_UI_MODE) {
    const ids = (process.env.UI_POST_SELECTORS || "#post-1,#post-2,#post-3")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];
    for (let i = 0; i < ids.length; i++) {
      let jpg;
      try {
        jpg = await screenshotByLocator(page, ids[i]);
      } catch (e) {
        console.warn(`[captureLatestPosts] selector ${ids[i]} failed → fullpage fallback. reason=${e?.message}`);
        jpg = await screenshotFull(page);
      }
      const key = `accounts/${handle}/posts/${i + 1}.jpg`;
      results.push(await uploadToR2(key, jpg));
    }
    return results;
  }

  // 旧モード（X本体）
  await page.waitForSelector(SELECTOR_TWEET, { state: "attached", timeout: CAPTURE_TIMEOUT });
  const items = page.locator(SELECTOR_TWEET);
  const count = await items.count();
  const take = Math.min(3, count);
  const results = [];

  for (let i = 0; i < take; i++) {
    const el = items.nth(i);
    await el.waitFor({ state: "visible" });
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250); // レイアウト落ち着き待ち
    const png = await el.screenshot({ type: "png" });
    const jpg = await toJpeg(png);
    const key = `accounts/${handle}/posts/${i + 1}.jpg`;
    results.push(await uploadToR2(key, jpg));
  }
  for (let i = take; i < 3; i++) {
    const jpg = await screenshotFull(page);
    const key = `accounts/${handle}/posts/${i + 1}.jpg`;
    results.push(await uploadToR2(key, jpg));
  }
  return results;
}

export async function refreshHandle(handle) {
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    const profile = await captureProfile(page, handle);
    const posts = await captureLatestPosts(page, handle);
    return { handle, profile, posts };
  } finally {
    try { await ctx.close(); } catch {}
    try { await ctx.browser()?.close(); } catch {}
  }
}
