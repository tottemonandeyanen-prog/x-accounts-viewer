// server.js （該当部分を追加/置換）

import express from "express";
import { chromium } from "playwright";
import {
  getObjectTextFromR2,
  putObjectToR2,
  deletePrefixFromR2,
  uploadToR2,
} from "./r2.js";

const app = express();
// CORS (UIからの呼び出しを許可)
const UI_ORIGIN = (() => {
  try { return new URL(process.env.UI_BASE).origin; } catch { return "*"; }
})();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", UI_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

const {
  UI_BASE = "",
  UI_PATH_TMPL = "/accounts/@{handle}",
  SELECTOR_PROFILE = "#profile-header",
  UI_POST_SELECTORS = "#post-1,#post-2,#post-3",
  TARGET_WIDTH = "900",
  JPEG_QUALITY = "70",
  PAGE_TIMEOUT_MS = "90000",
  CONCURRENCY = "1",
  R2_BUCKET = "x-accounts",
} = process.env;

const LIST_KEY = "accounts/_list.json";

// ---- 追加: ハンドル正規化 & 用具 ----
const norm = {
  withAt(h) {
    if (!h) return "";
    h = h.trim();
    return h.startsWith("@") ? h : `@${h}`;
  },
  withoutAt(h) {
    if (!h) return "";
    return h.startsWith("@") ? h.slice(1) : h;
  },
};

async function loadList() {
  try {
    const txt = await getObjectTextFromR2(LIST_KEY);
    const arr = JSON.parse(txt || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveList(list) {
  // 重複排除 & ソート（常に @付きで保存）
  const uniq = [...new Set(list.map(norm.withAt))].sort((a, b) =>
    a.localeCompare(b)
  );
  await putObjectToR2(LIST_KEY, JSON.stringify(uniq, null, 2), {
    ContentType: "application/json",
  });
  return uniq;
}

// ---- 診断 ----
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/playwrightz", async (_req, res) => {
  try {
    const b = await chromium.launch();
    const v = b.version();
    await b.close();
    res.send(`ok: chromium ${v}`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ---- アカウント一覧 ----
app.get("/accounts", async (_req, res) => {
  const list = await loadList();
  res.json(list);
});

app.post("/accounts", async (req, res) => {
  const raw = String(req.body.handle || "");
  const handle = norm.withAt(raw);
  if (!handle) return res.status(400).json({ error: "handle required" });

  const list = await loadList();
  list.push(handle);
  const saved = await saveList(list);
  res.json({ ok: true, list: saved });
});

app.delete("/accounts/:handle", async (req, res) => {
  const raw = req.params.handle || "";
  const handle = norm.withAt(raw);
  const noAt = norm.withoutAt(handle);

  // 先にR2のプレフィックス削除
  await deletePrefixFromR2(`accounts/${handle}/`); // 旧レイアウト(@あり)
  await deletePrefixFromR2(`accounts/${noAt}/`);   // 新レイアウト(@なし)

  // _list.json からも確実に除去
  const list = await loadList();
  const saved = await saveList(list.filter((h) => h !== handle));

  res.json({ ok: true, list: saved });
});

// ---- 撮影 ----
app.get("/refresh", async (req, res) => {
  const handles = String(req.query.handles || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!handles.length) return res.status(400).json({ error: "handles required" });

  const profileSel = SELECTOR_PROFILE;
  const postSelectors = UI_POST_SELECTORS.split(",").map((s) => s.trim()).filter(Boolean);
  const timeout = Number(PAGE_TIMEOUT_MS) || 90000;
  const width = Number(TARGET_WIDTH) || 900;
  const quality = Number(JPEG_QUALITY) || 70;

  const browser = await chromium.launch();
  const results = [];

  try {
    for (const raw of handles) {
      const atHandle = norm.withAt(raw);
      const noAt = norm.withoutAt(atHandle);

      const tpl = UI_PATH_TMPL
        .replace("{handle}", noAt)
        .replace("@{handle}", `@${noAt}`);
      const url = UI_BASE + tpl;

      const ctx = await browser.newContext({ viewport: { width, height: 1200 } });
      const page = await ctx.newPage();

      const one = { handle: atHandle, ok: false, shots: [] };
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        console.log('[goto]', url, resp?.status());

        await page.waitForSelector('body[data-ready="1"]', { timeout }); // まずUI側のonloadマーカー
        await page.waitForSelector(profileSel, { timeout, state: 'visible' });
        await page.waitForSelector(postSelectors[0], { timeout, state: 'visible' });
        await page.waitForSelector(`body[data-ready="1"], ${profileSel}, ${postSelectors[0]}`, { timeout });
        // セレクタが出るまで待つ（プロフィール or 最初の投稿）
        await page.waitForSelector(`${profileSel}, ${postSelectors[0]}`, { timeout });

        // プロフィール
        try {
          const el = await page.$(profileSel);
          if (el) {
            const buf = await el.screenshot({ type: "jpeg", quality });
            await uploadToR2(`accounts/${noAt}/profile.jpg`, buf, { ContentType: "image/jpeg" });
            one.shots.push("profile");
          }
        } catch {}

        // 投稿（1～3）
        for (let i = 0; i < postSelectors.length; i++) {
          const sel = postSelectors[i];
          try {
            const el = await page.$(sel);
            if (el) {
              const buf = await el.screenshot({ type: "jpeg", quality });
              await uploadToR2(`accounts/${noAt}/posts/${i + 1}.jpg`, buf, {
                ContentType: "image/jpeg",
              });
              one.shots.push(`post-${i + 1}`);
            }
          } catch {}
        }

        one.ok = one.shots.length > 0;
      } catch (e) {
        one.error = String(e);
      } finally {
        await ctx.close();
      }
      results.push(one);
    }
  } finally {
    await browser.close();
  }

  res.json({ ok: true, results });
});

// 起動
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`api on :${port}`));
