import express from "express";
import cors from "cors";
import pLimit from "p-limit";
import { refreshHandle } from "./scrape.js";
import { deletePrefixFromR2, getObjectTextFromR2, putObjectToR2 } from "./r2.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// R2上に保存する“正”のアカウント一覧
const LIST_KEY = "accounts/_list.json";

async function readList() {
  try {
    const txt = await getObjectTextFromR2(LIST_KEY);
    return txt ? JSON.parse(txt) : [];
  } catch {
    return [];
  }
}
async function writeList(arr) {
  await putObjectToR2(LIST_KEY, JSON.stringify(arr, null, 2), "application/json");
}

app.get("/healthz", (_, res) => res.send("ok"));

// 一覧取得
app.get("/accounts", async (_req, res) => {
  const list = await readList();
  res.json({ accounts: list });
});

// 追加（単体/複数どちらでも OK）
app.post("/accounts", async (req, res) => {
  try {
    const handles = req.body?.handles;
    const items = (Array.isArray(handles) ? handles : [handles])
      .filter(Boolean)
      .map(s => String(s).trim())
      .map(h => (h.startsWith("@") ? h : `@${h}`));

    const current = await readList();
    const set = new Set(current.concat(items));
    const next = Array.from(set);
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

    const handles = raw.split(",")
      .map(s => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    console.log("[/refresh] handles:", handles);
    const limit = pLimit(Number(process.env.CONCURRENCY ?? 6));
    const jobs = handles.map(h => limit(() => refreshHandle(h)));
    const results = await Promise.allSettled(jobs);

    const ok = [];
    const ng = [];
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") ok.push(r.value);
      else ng.push({ handle: handles[idx], error: r.reason?.toString?.() || "error" });
    });

    res.json({ ok, ng });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal error" });
  }
});

// 例: DELETE /accounts/akiko_lawson で accounts/akiko_lawson/ を丸ごと削除
app.delete("/accounts/:handle", async (req, res) => {
  try {
    const handle = String(req.params.handle || "").trim().replace(/^@/, "");
    if (!handle) return res.status(400).json({ error: "handle is required" });
    const prefix = `accounts/${handle}/`;
    await deletePrefixFromR2(prefix);
    const list = await readList();
    const next = list.filter(h => h.toLowerCase() !== `@${handle}`.toLowerCase());
    await writeList(next);
    res.json({ ok: true, deleted_prefix: prefix, accounts: next });
  } catch (e) {
    res.status(500).json({ error: e?.message || "delete failed" });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`API on :${port}`));
