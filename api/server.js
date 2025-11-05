import express from "express";
import pLimit from "p-limit";

const app = express();

/* ---------- CORS（プリフライト即応） ---------- */
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

/* ---------- health / playwright check ---------- */
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/playwrightz", async (_req, res) => {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const v = b.version();
    await b.close();
    res.send(
      `ok: chromium ${v} at ${process.env.PLAYWRIGHT_BROWSERS_PATH || "(no path)"}`
    );
  } catch (e) {
    res.status(500).send(`ng: ${e?.message || e}`);
  }
});

/* ---------- R2 & scrape を遅延 import するヘルパ ---------- */
const r2 = () => import("./r2.js");         // ← 起動時に触らない
const scrape = () => import("./scrape.js"); // ← 同上

/* ---------- _list.json の読み書き ---------- */
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

/* ---------- API ---------- */
// 一覧取得
app.get("/accounts", async (_req, res) => {
  const list = await readList();
  res.json({ accounts: list });
});

// 追加
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

// 更新（スクショ）
app.get("/refresh", async (req, res) => {
  try {
    const raw = String(req.query.handles || "").trim();
    if (!raw) return res.status(400).json({ error: "handles is required" });

    const handles = raw
      .split(",")
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);

    const limit = pLimit(Number(process.env.CONCURRENCY ?? 6));
    const { refreshHandle } = await scrape(); // ← ここで初めて読み込む
    const results = await Promise.allSettled(
      handles.map((h) => limit(() => refreshHandle(h)))
    );

    const ok = [];
    const ng = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") ok.push(r.value);
      else ng.push({ handle: handles[i], error: r.reason?.toString?.() || "error" });
    });

    res.json({ ok, ng });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal error" });
  }
});

// 削除
app.delete("/accounts/:handle", async (req, res) => {
  try {
    const handle = String(req.params.handle || "").trim().replace(/^@/, "");
    if (!handle) return res.status(400).json({ error: "handle is required" });

    const { deletePrefixFromR2 } = await r2();
    const prefix = `accounts/${handle}/`;
    await deletePrefixFromR2(prefix);

    const list = await readList();
    const next = list.filter(
      (h) => h.toLowerCase() !== `@${handle}`.toLowerCase()
    );
    await writeList(next);

    res.json({ ok: true, deleted_prefix: prefix, accounts: next });
  } catch (e) {
    res.status(500).json({ error: e?.message || "delete failed" });
  }
});

/* ---------- 起動 ---------- */
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`API on :${port}`));
