// test_capture.mjs
import { chromium } from "playwright";

const HANDLE = process.argv[2] || "@akiko_lawson";
const OUTDIR = "./local_out";
const STATE = process.env.PLAYWRIGHT_STORAGE_STATE || "./storage_state.json";

// ▼便利関数：複数要素の外接矩形（パディング付き）を作る
async function clipOf(page, locators, pad = 16) {
  const rects = [];
  for (const loc of locators) {
    const box = await page.locator(loc).first().boundingBox();
    if (box) rects.push(box);
  }
  if (!rects.length) throw new Error("clip targets not found");
  const left   = Math.min(...rects.map(r => r.x));
  const top    = Math.min(...rects.map(r => r.y));
  const right  = Math.max(...rects.map(r => r.x + r.width));
  const bottom = Math.max(...rects.map(r => r.y + r.height));
  return {
    x: Math.max(0, left - pad),
    y: Math.max(0, top - pad),
    width:  right - left + pad * 2,
    height: bottom - top + pad * 2,
  };
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(CAPTURE_TIMEOUT);
  page.setDefaultNavigationTimeout(CAPTURE_TIMEOUT);
  const user = HANDLE.startsWith("@") ? HANDLE.slice(1) : HANDLE;

  await page.goto(`https://x.com/${user}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  // ===== プロフィール =====
  // ・ヘッダー写真リンク
  // ・アバター
  // ・UserName 行（表示名＆認証バッジ）
  // の3つの外接矩形をまとめて切り抜く → ちょうど添付のような領域になります
  const profileClip = await clipOf(page, [
    'a[href$="/header_photo"]',
    '[data-testid^="UserAvatar-Container-"]',
    '[data-testid="UserName"]',
  ], 24);

  await page.screenshot({ path: `${OUTDIR}/profile.jpg`, clip: profileClip });

  // ===== 直近3ポスト =====
  // タイムライン先頭から article[data-testid="tweet"] を3件取り、
  // それぞれ本文＋メディア部分までを広めに切り抜き
  await page.waitForSelector('article[data-testid="tweet"]');
  const tweets = page.locator('article[data-testid="tweet"]').slice(0, 3);
  const count = await tweets.count();

  for (let i = 0; i < count; i++) {
    const tw = tweets.nth(i);
    // 各ポストの本文 or メディアが読み込まれるまで待機
    await tw.waitFor({ state: "visible" });
    // アクションバーの少し下まで含めるため tweet 全体をベースにパディング付与
    const box = await tw.boundingBox();
    const clip = {
      x: Math.max(0, box.x - 16),
      y: Math.max(0, box.y - 16),
      width: box.width + 32,
      height: box.height + 32,
    };
    await page.screenshot({ path: `${OUTDIR}/post_${i + 1}.jpg`, clip });
  }

  await browser.close();
  console.log("✅ saved to", OUTDIR);
})();
