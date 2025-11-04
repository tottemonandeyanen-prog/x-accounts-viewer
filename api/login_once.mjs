// api/login_once.mjs
import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  userAgent: UA,
  viewport: { width: 420, height: 840 }
});
const page = await context.newPage();

// 1) ログインページへ（モバイル版は軽くて崩れにくい）
console.log("➡ Xのログインページを開きます。ログインを完了してください。");
await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded" });

// 2) ログイン完了を確認するヒント
console.log("📝 画面にタイムラインや自分のプロフィールが見えたら、\n   このコンソールに戻って Enter を押してください。");

// Enter押下待ち
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", async () => {
  // 3) 主要ドメインを一度踏んでcookieを確実に捕捉
  try {
    await page.goto("https://m.twitter.com/home", { waitUntil: "domcontentloaded" });
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  } catch {}

  // 4) storage_state.json を出力
  await context.storageState({ path: "storage_state.json" });
  console.log("✅ storage_state.json を出力しました（api/storage_state.json）。");

  await browser.close();
  process.exit(0);
});
