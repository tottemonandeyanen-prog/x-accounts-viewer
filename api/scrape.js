import { chromium } from "playwright";
import sharp from "sharp";
import { uploadToR2 } from "./r2.js";

// ---- tunables ----
const JPEG_QUALITY     = Number(process.env.JPEG_QUALITY ?? 70);
const TARGET_WIDTH     = Number(process.env.TARGET_WIDTH  ?? 900);
// 両方の名前を見て、どちらか入っていれば採用
const CAPTURE_TIMEOUT  = Number(process.env.CAPTURE_TIMEOUT_MS ?? process.env.PAGE_TIMEOUT_MS ?? 60000);
const VIEWPORT_W       = Number(process.env.VIEWPORT_W ?? 1400);
const VIEWPORT_H       = Number(process.env.VIEWPORT_H ?? 2200);

// ---- UI routing ----
const UI_BASE       = (process.env.UI_BASE || "").replace(/\/+$/, ""); // 例: http://localhost:5173
const UI_PATH_TMPL  = (process.env.UI_PATH_TMPL || "/accounts/@{handle}").trim();
const IS_UI_MODE    = !!UI_BASE;

// ---- selectors ----
const SELECTOR_PROFILE = (process.env.SELECTOR_PROFILE ?? "#profile-header").trim();
const SELECTOR_TWEET   = (process.env.SELECTOR_TWEET   ?? `article[data-testid="tweet"]`).trim();

// 自作UI or X本体の “何かしら見えたらOK” な待機用候補（ユニオンもこれを使う）
const ALT_WAIT_SELECTORS = [
  SELECTOR_PROFILE,
  "#capture-root",
  "#post-1",
  "[data-testid='profile-header']",
  "[data-capture-root]",
  // X本体の保険
  "article[data-testid='tweet']",
  "[data-testid='UserName']",
  "[data-testid='UserProfileHeader_Items']",
];

async function captureProfileUnion(page, handle) {
  // 1) 最初に「何かしら」見えるまで待つ
  await waitForAny(page, ALT_WAIT_SELECTORS, 12000);

  // 2) 候補セレクタ群の矩形を全部集めてユニオン
  const rects = await getRects(page, ALT_WAIT_SELECTORS);
  let clip = unionRect(rects, 10);

  // 3) 何も拾えなかったら全画面フォールバック
  if (!clip || clip.width <= 0 || clip.height <= 0) {
    clip = { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H };
  }

  const buf = await page.screenshot({ clip, type: "jpeg", quality: 100 });
  const resized = await sharp(buf).resize({ width: TARGET_WIDTH }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  await uploadToR2(`accounts/${handle}/profile.jpg`, resized, "image/jpeg");
}

// ===== helpers: wait & rect union =====
async function waitForAny(page, selectors = [], timeout = 8000) {
  const clean = selectors.filter(Boolean);
  if (!clean.length) return null;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of clean) {
      const ok = await page.$(sel);
      if (ok) return sel;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function getRects(page, selectors = []) {
  return await page.evaluate((sels) => {
    const rects = [];
    for (const s of sels) {
      if (!s) continue;
      const nodes = Array.from(document.querySelectorAll(s));
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          rects.push({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
        }
      }
    }
    return rects;
  }, selectors);
}

function unionRect(rects, padding = 8) {
  if (!rects.length) return null;
  const minX = Math.floor(Math.min(...rects.map(r => r.x)) - padding);
  const minY = Math.floor(Math.min(...rects.map(r => r.y)) - padding);
  const maxX = Math.ceil(Math.max(...rects.map(r => r.x + r.width)) + padding);
  const maxY = Math.ceil(Math.max(...rects.map(r => r.y + r.height)) + padding);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

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
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
  await el.waitFor({ state: "visible", timeout: CAPTURE_TIMEOUT });
  await el.scrollIntoViewIfNeeded();
  await page.waitForLoadState("domcontentloaded");
  // 直後のリフロー対策で少し長めに待つ
  await page.waitForTimeout(650);
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

  const storage = process.env.PLAYWRIGHT_STORAGE_STATE;
  if (!storage) throw new Error("X本体を撮る場合は PLAYWRIGHT_STORAGE_STATE が必要です（ログイン状態JSON）");

  // ✅ URLを x.com に変更
  await page.goto(`https://x.com/${user}`, { waitUntil: "networkidle", timeout: CAPTURE_TIMEOUT });

  // ✅ ビューポート・UA をデスクトップ固定
  await page.setViewportSize({ width: VIEWPORT_W, height: VIEWPORT_H });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
}

// ====== 撮影 ======
async function captureProfile(page, handle) {
  await gotoProfile(page, handle);

  if (IS_UI_MODE) {
    // ★ まずは #profile-header を厳密撮影
    const target = SELECTOR_PROFILE || "#profile-header";
    let buf;
    try {
      // 要素だけを切り抜く（全画面にしない）
      buf = await screenshotByLocator(page, target);
    } catch (e) {
      console.warn(`[profile:UI] ${target} が見つからない → フォールバック`, e?.message);
      // どうしても見つからない時だけ代替 → それでも無理なら全画面
      for (const alt of ["#capture-root","#post-1","[data-testid='profile-header']"]) {
        try { buf = await screenshotByLocator(page, alt); break; } catch {}
      }
      if (!buf) buf = await screenshotFull(page);
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

// posts 3枚撮って R2 に保存。足りなければフォールバックで必ず3枚埋める
async function captureLatestPosts(page, handle) {
  if (IS_UI_MODE) {
    const raw = (process.env.UI_POST_SELECTORS || "#post-1,#post-2,#post-3").trim();
    const results = [];

    // A) カンマ区切りなら、各セレクタを個別撮影
    if (raw.includes(",")) {
      const sels = raw.split(",").map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < sels.length; i++) {
        try {
          const jpg = await screenshotByLocator(page, sels[i]);
          results.push(jpg);
        } catch (e) {
          console.warn(`[posts] ${sels[i]} の撮影に失敗 → フォールバック全画面`, e?.message);
          results.push(await screenshotFull(page)); // 個別失敗は全画面で埋め
        }
      }
    } else {
      // B) 単一セレクタなら、上から最大3件を自動撮影
      const sel = raw;
      const loc = page.locator(sel);
      const count = await loc.count();
      const take = Math.min(3, count);
      for (let i = 0; i < take; i++) {
        try {
          const jpg = await screenshotByLocator(page, `${sel} >> nth=${i}`);
          results.push(jpg);
        } catch (e) {
          console.warn(`[posts] ${sel} nth=${i} 失敗 → その枠は全画面`, e?.message);
          results.push(await screenshotFull(page));
        }
      }
    }

    // 枠が3未満なら、最後は「プロフ or 全画面」で穴埋めして必ず3枚に
    while (results.length < 3) {
      try {
        results.push(await screenshotByLocator(page, SELECTOR_PROFILE || "#profile-header"));
      } catch {
        results.push(await screenshotFull(page));
      }
    }

    // R2 へ保存（1..3）
    for (let i = 0; i < 3; i++) {
      const key = `accounts/${handle}/posts/${i + 1}.jpg`;
      await uploadToR2(key, results[i]);
    }
    return;
  }

  // === ここからは X 本体モード（m.twitter） ===
  const sel = (process.env.SELECTOR_TWEET || 'article[data-testid="tweet"]').trim();
  const loc = page.locator(sel);
  const count = await loc.count();
  const take = Math.min(3, count);
  const shots = [];

  for (let i = 0; i < take; i++) {
    try {
      shots.push(await screenshotByLocator(page, `${sel} >> nth=${i}`));
    } catch (e) {
      console.warn(`[posts:x] ${sel} nth=${i} 失敗 → その枠は全画面`, e?.message);
      shots.push(await screenshotFull(page));
    }
  }
  while (shots.length < 3) shots.push(await screenshotFull(page));

  for (let i = 0; i < 3; i++) {
    const key = `accounts/${handle}/posts/${i + 1}.jpg`;
    await uploadToR2(key, shots[i]);
  }
}

export async function refreshHandle(handle) {
  // この関数は絶対にthrowしない
  const maxRetry = 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    let ctx;
    try {
      // ★ newContext() も try 内に入れて例外を捕まえる
      ctx = await newContext();
      const page = await ctx.newPage();
      await captureProfile(page, handle);
      await captureLatestPosts(page, handle);
      return { handle, ok: true };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const transient =
        /Target .* (closed|crashed)|Navigation failed|Execution context was destroyed/i.test(
          msg
        );
      if (!transient || attempt === maxRetry) {
        // ここで終わるが throw はしない
        return { handle, ok: false, error: msg };
      }
      await new Promise((r) => setTimeout(r, 1200)); // 短いリトライ待ち
    } finally {
      try { await ctx?.close(); } catch {}
      try { await ctx?.browser()?.close(); } catch {}
    }
  }
  // 念のため（来ない想定）
  return { handle, ok: false, error: String(lastErr || "refreshHandle failed") };
}
