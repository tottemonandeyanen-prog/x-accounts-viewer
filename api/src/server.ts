// src/server.ts
import express, { type Request, type Response } from "express";
import pLimit from "p-limit";
import {
  uploadToR2,
  putObjectToR2,
  getObjectTextFromR2,
  deletePrefixFromR2,
} from "./r2.js";
import { refreshHandle } from "./scrape.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- CORS ----
const BUILD_TAG = process.env.RENDER_GIT_COMMIT || "local";
app.use((_req: Request, res: Response, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Debug-CORS", `ok:${BUILD_TAG}`);
  next();
});
app.options("*", (_req: Request, res: Response) => res.sendStatus(204));

app.get("/healthz", (_req: Request, res: Response) => res.send("ok"));

// ---- R2-backed accounts list ----
const LIST_KEY = "accounts/_list.json";

async function loadList(): Promise<string[]> {
  const txt = await getObjectTextFromR2(LIST_KEY);
  if (!txt) return [];
  try {
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveList(handles: string[]): Promise<void> {
  const uniq = Array.from(new Set(handles.map(h => h.replace(/^@/, "")))).sort();
  await uploadToR2(
    LIST_KEY,
    Buffer.from(JSON.stringify(uniq, null, 2), "utf-8"),
    "application/json"
  );
}

// 一覧取得
app.get("/accounts", async (_req: Request, res: Response) => {
  const list = await loadList();
  res.json({ ok: true, accounts: list });
});

// 追加
app.post("/accounts", async (req: Request, res: Response) => {
  const handles: unknown = req.body?.handles;
  if (!Array.isArray(handles) || handles.length === 0) {
    return res.status(400).json({ ok: false, error: "handles required" });
  }
  const cur = await loadList();
  const next = Array.from(
    new Set([...cur, ...handles.map((h) => String(h).replace(/^@/, ""))])
  ).sort();
  await saveList(next);
  res.json({ ok: true, accounts: next });
});

// 削除（スクショも掃除：screenshots/{handle}/ 配下）
app.delete("/accounts/:handle", async (req: Request, res: Response) => {
  const handle = String(req.params.handle || "").replace(/^@/, "");
  if (!handle) return res.status(400).json({ ok: false, error: "handle required" });

  const cur = await loadList();
  const next = cur.filter((h) => h !== handle);
  await saveList(next);

  const prefix = `screenshots/${handle}/`;
  const deleted = await deletePrefixFromR2(prefix);

  res.json({ ok: true, accounts: next, deleted });
});

// ---- R2 helpers ----
app.post("/r2/put", async (req: Request, res: Response) => {
  const { key, content, contentType = "application/octet-stream" } = req.body || {};
  if (!key || typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "key and base64 content required" });
  }
  const buf = Buffer.from(content, "base64");
  const out = await uploadToR2(String(key), buf, String(contentType));
  res.json({ ok: true, ...out });
});

app.get("/r2/text", async (req: Request, res: Response) => {
  const key = String(req.query.key || "");
  if (!key) return res.status(400).json({ ok: false, error: "key required" });
  const text = await getObjectTextFromR2(key);
  if (text == null) return res.status(404).json({ ok: false, error: "not found" });
  res.type("text/plain").send(text);
});

app.delete("/r2/prefix", async (req: Request, res: Response) => {
  const prefix = String(req.query.prefix || "");
  if (!prefix) return res.status(400).json({ ok: false, error: "prefix required" });
  const deleted = await deletePrefixFromR2(prefix);
  res.json({ ok: true, deleted });
});

// 互換：旧putObjectToR2 名でのアップロード
app.post("/r2/putCompat", async (req: Request, res: Response) => {
  const { key, content, contentType } = req.body || {};
  if (!key || typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "key and base64 content required" });
  }
  const buf = Buffer.from(content, "base64");
  const out = await putObjectToR2(String(key), buf, String(contentType || "application/octet-stream"));
  res.json({ ok: true, ...out });
});

// ---- Refresh（撮影→R2保存）----
// app.js が GET /refresh?handles=a,b,c を呼ぶ前提
app.get("/refresh", async (req: Request, res: Response) => {
  const csv = String(req.query.handles || "");
  const handles = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (handles.length === 0) {
    return res.status(400).json({ ok: false, error: "handles required" });
  }

  const limit = pLimit(2);
  const results = await Promise.allSettled(
    handles.map((h) => limit(() => refreshHandle(h)))
  );

  const okList = results
    .map((r, i) => ({ r, h: handles[i] }))
    .filter((x) => x.r.status === "fulfilled")
    .map((x) => ({ handle: x.h, data: (x.r as PromiseFulfilledResult<any>).value }));

  const ng = results
    .map((r, i) => ({ r, h: handles[i] }))
    .filter((x) => x.r.status === "rejected")
    .map((x) => ({ handle: x.h, error: String((x.r as PromiseRejectedResult).reason) }));

  res.json({ ok: true, okList, ng });
});

// ---- start ----
const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
