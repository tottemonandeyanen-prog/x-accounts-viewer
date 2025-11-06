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

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", UI_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  const handle = norm.withAt(req.body?.handle || "");
  if (!handle) return res.status(400).json({ error: "handle required" });
  const list = await loadList();
  list.push(handle);
  const saved = await saveList(list);
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
app.get("/refresh", async (req, res) => {
  try {
    const handles = String(req.query.handles || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!handles.length) return res.json({ ok: true, results: [] });

    const results = [];
    for (const raw of handles) {
      const withAt = norm.withAt(raw);
      const noAt = norm.withoutAt(withAt);

      // scrape.js 側が {handle, ok, error?} を返すようにしてある
      const r = await refreshHandle(noAt);
      results.push({
        handle: withAt,
        ok: r.ok,
        error: r.ok ? undefined : r.error,
        shots: r.ok ? ["profile", "post-1", "post-2", "post-3"] : [],
      });
    }

    res.json({ ok: true, results });
  } catch (e) {
    // ここまで落ちてもJSONで返す（CORSも付く）
    res.json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// ===== 起動（0.0.0.0でbind）=====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`api on :${PORT}`));
