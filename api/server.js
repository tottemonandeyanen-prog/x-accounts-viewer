import express from "express";
import pLimit from "p-limit";
import fs from "node:fs";
import path from "node:path";

/* ---- 予期せぬ例外でプロセスが落ちないように ---- */
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e);
});

const app = express();

// ---- 一時: Chromiumをその場で入れる管理ルート（あとで削除推奨） ----
app.post("/admin/install-chromium", async (_req, res) => {
  try {
    const { exec } = await import("node:child_process");
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/render/.cache/ms-playwright";
    const cmd =
      `PLAYWRIGHT_BROWSERS_PATH=${cache} ` +
      `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 ` +
      `npx playwright install chromium --force`;
    exec(cmd, { env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) return res.status(500).send(stderr || String(err));
      res.send(stdout || "ok");
    });
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/* ---- CORS & JSON ---- */
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "4mb" }));

/* ---- healthz ---- */
app.get("/healthz", (_req, res) => res.send("ok"));

/* ---- 診断ルート: Playwright キャッシュの中身を見る ---- */
app.get("/diag/playwright", (_req, res) => {
  try {
    const cachePath = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/render/.cache/ms-playwright";
    const bundled = "node_modules/playwright/.local-browsers";
    const existsCache = fs.existsSync(cachePath);
    const listCache = existsCache ? fs.readdirSync(cachePath) : [];
    const existsBundled = fs.existsSync(bundled);
    const listBundled = existsBundled ? fs.readdirSync(bundled) : [];
    res.json({
      cachePath, existsCache, listCache,
      bundled, existsBundled, listBundled
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ---- Playwright 起動チェック（失敗しても 500 を返すだけで落ちない） ---- */
app.get("/playwrightz", async (_req, res) => {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const v = b.version();
    await b.close();
    res.send(`ok: chromium ${v} at ${process.env.PLAYWRIGHT_BROWSERS_PATH || "(no path)"}`);
  } catch (e) {
    res.status(500).send(`ng: ${e?.message || e}`);
  }
});

/* ---- R2 & scrape を遅延 import ---- */
const r2 = () => import("./r2.js");
const scrape = () => import("./scrape.js");

/* ---- _list.json の読み書き ---- */
const LIST_KEY = "accounts/_list.json";
async function readList() {
  try {
    const { getObjectTextFromR2 } = await r2();
    const txt = await getObjectTextFromR2(LIST_KEY);
    return txt ? JSON.parse(txt) : [];
  } catch {
    return [];
  }
}
async function writeList(arr) {
  const { putObjectToR2 } = await r2();
  await putObjectToR2(LIST_KEY, JSON.stringify(arr, null, 2), "application/json");
}

/* ---- API ---- */
app.get("/accounts", async (_req, res) => {
  const list = await readList();
  res.json({ accounts: list });
});

app.post("/accounts", async (req, res) => {
  try {
    const handles = req.body?.handles;
    const items = (Array.isArray(handles) ? handles : [handles])
      .filter(Boolean)
      .map((s) => String(s).trim())
      .map((h) => (h.startsWith("@") ? h : `@${h}`));
    const current = await readList();
    const next = Array.from(new Set(current.concat(items)));
    await writeList(next);
    res.json({ ok: true, accounts: next });
  } catch (e) {
    res.status(500).json({ error: e?.message || "add failed" });
  }
});

app.get("/refresh", async (req, res) => {
  try {
    const raw = String(req.query.handles || "").trim();
    if (!raw) return res.status(400).json({ error: "handles is required" });
    const handles = raw.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
    const limit = pLimit(Number(process.env.CONCURRENCY ?? 6));
    const { refreshHandle } = await scrape();
    const results = await Promise.allSettled(handles.map((h) => limit(() => refreshHandle(h))));
    const ok = [], ng = [];
    results.forEach((r, i) => (r.status === "fulfilled" ? ok.push(r.value)
      : ng.push({ handle: handles[i], error: r.reason?.toString?.() || "error" })));
    res.json({ ok, ng });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal error" });
  }
});

app.delete("/accounts/:handle", async (req, res) => {
  try {
    const handle = String(req.params.handle || "").trim().replace(/^@/, "");
    if (!handle) return res.status(400).json({ error: "handle is required" });
    const { deletePrefixFromR2 } = await r2();
    const prefix = `accounts/${handle}/`;
    await deletePrefixFromR2(prefix);
    const list = await readList();
    const next = list.filter((h) => h.toLowerCase() !== `@${handle}`.toLowerCase());
    await writeList(next);
    res.json({ ok: true, deleted_prefix: prefix, accounts: next });
  } catch (e) {
    res.status(500).json({ error: e?.message || "delete failed" });
  }
});

/* ---- 起動 ---- */
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`API on :${port}`));

import { execSync } from "node:child_process";
try {
  console.log("🧩 Checking Playwright browser at runtime...");
  execSync("PLAYWRIGHT_BROWSERS_PATH=0 PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 npx playwright install chromium --force", {
    stdio: "inherit",
  });
  console.log("✅ Chromium installed at runtime.");
} catch (e) {
  console.error("⚠️ Chromium install at runtime failed:", e.message);
}
