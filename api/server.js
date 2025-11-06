// server.js
import express from "express";
import { chromium } from "playwright";
import { refreshHandle } from "./scrape.js";
import {
  getObjectTextFromR2,
  putObjectToR2,
  deletePrefixFromR2,
} from "./r2.js";
// --- keep process alive (log instead of crash) ---
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const app = express();

// ===== CORS（常時付与・最優先）=====
const UI_ORIGIN =
  process.env.UI_ORIGIN ||
  "https://x-accounts-viewer-1.onrender.com"; // ←必要ならENVで差し替え

const allowList = (process.env.UI_ORIGIN || "https://x-accounts-viewer-1.onrender.com")
.split(",").map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowList.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || allowList[0]);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ===== 小物 =====
const LIST_KEY = "accounts/_list.json";
const norm = {
  withAt(h) {
    h = String(h || "").trim();
    return h.startsWith("@") ? h : `@${h}`;
  },
  withoutAt(h) {
    h = String(h || "").trim();
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
  const uniq = [...new Set(list.map(norm.withAt))].sort((a, b) =>
    a.localeCompare(b)
  );
  await putObjectToR2(LIST_KEY, JSON.stringify(uniq, null, 2), {
    ContentType: "application/json",
  });
  return uniq;
}

// ===== 診断 =====
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

// ===== アカウント一覧 =====
app.get("/accounts", async (_req, res) => {
  const list = await loadList();
  res.json(list);
});

app.post("/accounts", async (req, res) => {
  const raw = req.body?.handles ?? req.body?.handle ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const withAts = arr.map((h) => (String(h||"").trim().startsWith("@") ? String(h).trim() : `@${String(h).trim()}`))
                     .filter(Boolean);

  if (!withAts.length) return res.status(400).json({ error: "handle(s) required" });

  const list = await loadList();
  const saved = await saveList([...list, ...withAts]);
  res.json({ ok: true, list: saved });
});

app.delete("/accounts/:handle", async (req, res) => {
  const withAt = norm.withAt(req.params.handle || "");
  const noAt = norm.withoutAt(withAt);
  await deletePrefixFromR2(`accounts/${withAt}/`).catch(() => {});
  await deletePrefixFromR2(`accounts/${noAt}/`).catch(() => {});
  const list = await loadList();
  const saved = await saveList(list.filter((h) => h !== withAt));
  res.json({ ok: true, list: saved });
});

// ===== 撮影（絶対にthrowしない）=====
// ===== 撮影（絶対にthrowしない）=====
app.get("/refresh", async (req, res) => {
  try {
    const handles = String(req.query.handles || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (!handles.length) return res.json({ ok: true, results: [] });

    const BATCH = Math.max(1, parseInt(process.env.CONCURRENCY || "2", 10)); // 並行数
    const TIME_BUDGET_MS = 85_000; // 全体の安全上限
    const started = Date.now();

    const results = [];
    for (let i = 0; i < handles.length; i += BATCH) {
      // 予算を超えそうなら打ち切り
      if (Date.now() - started > TIME_BUDGET_MS) {
        results.push(...handles.slice(i).map(h => ({
          handle: h.startsWith("@") ? h : `@${h}`,
          ok: false,
          error: "time budget exceeded",
          shots: []
        })));
        break;
      }
      const chunk = handles.slice(i, i + BATCH).map(raw => raw.replace(/^@/, ""));
      // 各ハンドルを並行実行（refreshHandle は throw しない設計）
      const settled = await Promise.allSettled(chunk.map(h => refreshHandle(h)));
      for (let j = 0; j < settled.length; j++) {
        const h = chunk[j];
        const r = settled[j].status === "fulfilled" ? settled[j].value
                                                    : { ok:false, error:String(settled[j].reason||"failed") };
        results.push({
          handle: `@${h}`,
          ok: !!r.ok,
          error: r.ok ? undefined : r.error,
          shots: r.ok ? ["profile","post-1","post-2","post-3"] : [],
        });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.get("/refresh-shot", async (req, res) => {
  return res.status(400).json({ ok:false, error:"Use /refresh (batched & fast)" });
  /*
  try {
    const handle = String(req.query.handle || "").replace(/^@/, "");
    const shot = String(req.query.shot || "profile");
    if (!handle) return res.status(400).json({ ok: false, error: "handle required" });

    const r = await refreshShot(handle, shot); // throwしない
    res.json({ ok: !!r.ok, handle: `@${handle}`, shot, error: r.ok ? undefined : r.error });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
    */
});

// ===== 起動（0.0.0.0でbind）=====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`api on :${PORT}`);

  // ---- Playwright warm-up（初回の遅さ対策）----
  try {
    const b = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
    const ctx = await b.newContext({ viewport: { width: 400, height: 800 } });
    const p = await ctx.newPage();
    await p.goto("https://m.x.com/home", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
    await p.close(); await ctx.close(); await b.close();
    console.log("[warmup] ok");
  } catch (e) { console.log("[warmup] skip:", e?.message || e); }
});
