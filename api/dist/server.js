import express from "express";
import cors from "cors";
import pLimit from "p-limit";
import { refreshHandle } from "./scrape.js";
import { deletePrefixFromR2 } from "./r2.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/healthz", (_, res) => res.send("ok"));

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
    res.json({ ok: true, deleted_prefix: prefix });
  } catch (e) {
    res.status(500).json({ error: e?.message || "delete failed" });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`API on :${port}`));
