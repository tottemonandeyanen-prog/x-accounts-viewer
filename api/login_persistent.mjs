// api/login_persistent.mjs
import { chromium } from "playwright";

// 一時プロファイルにログイン状態を作る
const userDataDir = "./tmp-login"; // 作業後は削除してOK
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ["--lang=ja-JP", "--disable-blink-features=AutomationControlled"],
  viewport: { width: 1200, height: 900 },
  userAgent: UA,
});
const page = await ctx.newPage();

async function openOne(url) {
  try { await page.goto(url, { waitUntil: "domcontentloaded" }); } catch {}
}

// 1) ログインページを順に試す（どれかで通ればOK）
console.log("➡ ログインページを開きます。通りやすい順で3種を試します。");
await openOne("https://x.com/login");
if (page.url().includes("/login") || page.url().includes("/flow")) {
  // そのまま操作してOK
} else {
  await openOne("https://x.com/i/flow/login");
  if (!page.url().includes("/login") && !page.url().includes("/flow")) {
    await openOne("https://m.twitter.com/i/flow/login");
  }
}

console.log("📝 ここで手動ログインしてください。（2FAが出たら完了まで）");
console.log("   タイムラインやプロフィールが表示されたら、このコンソールに戻って Enter を押してください。");

// Enter押下待ち → 保存
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", async () => {
  try {
    // cookieを確実に拾うため主要ドメインを踏む
    await openOne("https://x.com/home");
    await openOne("https://m.twitter.com/home");
  } catch {}
  const statePath = "storage_state.json";
  await ctx.storageState({ path: statePath });
  console.log(`✅ ${statePath} を出力しました（api/${statePath}）。`);
  await ctx.close();
  process.exit(0);
});
