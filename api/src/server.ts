import express from "express";
import pLimit from "p-limit";
import { refreshHandle } from "./scrape.js";

const app = express();

app.get("/healthz", (_, res) => res.send("ok"));

app.get("/refresh", async (req, res) => {
  try {
    const raw = String(req.query.handles || "").trim();
    if (!raw) return res.status(400).json({ error: "handles is required" });

    const handles = raw.split(",").map(s => s.trim()).filter(Boolean);
    const limit = pLimit(Number(process.env.CONCURRENCY ?? 6));

    const jobs = handles.map(h => limit(() => refreshHandle(h)));
    const results = await Promise.allSettled(jobs);

    const ok = results
      .filter(r => r.status === "fulfilled")
      .map(r => (r as PromiseFulfilledResult<any>).value);
    const ng = results
      .filter(r => r.status === "rejected")
      .map((r, i) => ({ handle: handles[i], error: (r as PromiseRejectedResult).reason?.toString?.() || "error" }));

    res.json({ ok, ng });
  } catch (e:any) {
    res.status(500).json({ error: e?.message || "internal error" });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`API on :${port}`));
