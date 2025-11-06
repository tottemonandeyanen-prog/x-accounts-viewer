// ===== 設定 =====
const STORAGE_KEY = "x-accounts";
const apiBase = (import.meta.env && import.meta.env.VITE_API_BASE) || (window.API_BASE || "");
const r2Host = window.R2_PUBLIC_HOST || "";

// ===== ルーター =====
const path = location.pathname.replace(/\/+$/, "");
const m = /^\/accounts\/@?([^/]+)$/.exec(path);

if (m) {
  // ========== 撮影モード (/accounts/@handle) ==========
  const handle = "@" + m[1];

  // 撮影用の安定DOM（Playwrightがここを locator(...).screenshot()）
  document.body.innerHTML = `
    <main id="capture-root" style="max-width:900px;margin:24px auto;padding:16px;font-family:system-ui">
      <section id="profile-header" data-testid="profile-header" style="display:flex;gap:12px;align-items:center;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.03)">
        <img id="avatar" alt="avatar" width="80" height="80" style="border-radius:50%;background:#f3f4f6;object-fit:cover">
        <div>
          <div id="display-name" style="font-size:20px;font-weight:700;margin-bottom:4px">Display Name</div>
          <div id="user-handle" style="color:#6b7280">
            <a href="https://x.com/${handle.slice(1)}" target="_blank" rel="noopener noreferrer">${handle}</a>
          </div>
          <div id="bio" style="margin-top:6px;color:#111">Bio text comes here.</div>
        </div>
      </section>

      <article id="post-1" data-testid="post-1" style="margin-top:16px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff">
        <div style="font-weight:600;margin-bottom:8px">Latest Post #1</div>
        <img id="post-1-img" alt="" style="width:100%;height:auto;border-radius:8px;background:#f3f4f6">
      </article>

      <article id="post-2" data-testid="post-2" style="margin-top:12px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff">
        <div style="font-weight:600;margin-bottom:8px">Latest Post #2</div>
        <img id="post-2-img" alt="" style="width:100%;height:auto;border-radius:8px;background:#f3f4f6">
      </article>

      <article id="post-3" data-testid="post-3" style="margin-top:12px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff">
        <div style="font-weight:600;margin-bottom:8px">Latest Post #3</div>
        <img id="post-3-img" alt="" style="width:100%;height:auto;border-radius:8px;background:#f3f4f6">
      </article>
    </main>
  `;

  // ここで実データを挿し込んでもいいし、プレースホルダでもOK
  // まずはプレースホルダで動作優先
  document.getElementById("avatar").src = `${r2Host}/placeholders/avatar.jpg`;
  document.getElementById("post-1-img").src = `${r2Host}/placeholders/post1.jpg`;
  document.getElementById("post-2-img").src = `${r2Host}/placeholders/post2.jpg`;
  document.getElementById("post-3-img").src = `${r2Host}/placeholders/post3.jpg`;

} else {
  // ========== ビューアモード (/) ==========
  let isRefreshing = false;
  const state = { handles: new Set() };
  const board = document.getElementById("capture-root");
  const tpl = document.getElementById("col-tpl");

  const hscroll = document.getElementById("hscroll");
  const hSpacer = hscroll?.querySelector(".hscroll-spacer");

  // board と上部バーのスクロールを双方向同期
  let _syncing = false;
  function syncScrollFromBoard() {
    if (_syncing) return;
    _syncing = true;
    hscroll.scrollLeft = board.scrollLeft;
    _syncing = false;
  }
  function syncScrollFromTop() {
    if (_syncing) return;
    _syncing = true;
    board.scrollLeft = hscroll.scrollLeft;
    _syncing = false;
  }
  if (hscroll) {
    board.addEventListener("scroll", syncScrollFromBoard, { passive: true });
    hscroll.addEventListener("scroll", syncScrollFromTop, { passive: true });
  }

  // board の内容幅に合わせて上部バーの幅（=スペーサー）を更新
  function syncHScrollWidth() {
    if (!hSpacer) return;
    // board.scrollWidth は“全列の合計幅”
    hSpacer.style.width = board.scrollWidth + "px";
  }
  window.addEventListener("resize", syncHScrollWidth);


  async function fetchAccounts() {
    // 1) API（正規ルート）
    try {
      if (apiBase) {
        const r = await fetch(`${apiBase}/accounts`, { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.accounts)) return j.accounts;
        }
      }
    } catch (e) {
      console.warn("[fetchAccounts] API fallback:", e?.message || e);
    }

    // 2) R2 公開JSON（APIが落ちてても全端末で共有できる）
    try {
      if (r2Host) {
        const r = await fetch(`${r2Host}/accounts/_list.json?ts=${Date.now()}`, { cache: "no-store" });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr)) return arr;
        }
      }
    } catch (e) {
      console.warn("[fetchAccounts] R2 fallback:", e?.message || e);
    }

    // 3) 最後の手段：各端末の localStorage
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }


  // ========== Progress Helper ==========
const progress = (() => {
  const overlay = document.getElementById("progress-overlay");
  const fill = overlay.querySelector(".progress-fill");
  const tCount = document.getElementById("progress-count");
  const tTotal = document.getElementById("progress-total");
  const tPerc  = document.getElementById("progress-perc");
  let total = 0, done = 0, fakeTimer = null;

  function open(t){
    total = Math.max(0, t|0); done = 0;
    tTotal.textContent = total; tCount.textContent = "0"; tPerc.textContent = "0";
    fill.style.width = "0%";
    overlay.classList.remove("hide");
    if (total === 0) {
      let p = 0;
      fakeTimer = setInterval(() => {
        p = Math.min(95, p + 2); // 95%で止める
        fill.style.width = p + "%";
        tPerc.textContent = String(p);
      }, 150);
    }
  }
  function inc(){
    if (total === 0) return;
    done++;
    const perc = Math.min(100, Math.round(done * 100 / total));
    tCount.textContent = String(done);
    tPerc.textContent = String(perc);
    fill.style.width = perc + "%";
    if (done >= total) close();
  }
  function close(){
    fill.style.width = "100%"; tPerc.textContent = "100";
    if (fakeTimer) { clearInterval(fakeTimer); fakeTimer = null; }
    setTimeout(() => overlay.classList.add("hide"), 300);
  }
  return { open, inc, close };
})();


  function save(){ localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.handles])); }
  function stripAt(h){ return h.replace(/^@/, ""); }
  function r2Url(handle, path){
    const keyHandle = stripAt(handle);
    return `${r2Host}/accounts/${keyHandle}/${path}.jpg`;
  }

  function render(){
    board.innerHTML = "";
    const bust = Date.now();
    const handles = [...state.handles];
    // 1アカウント = プロフィール1 + 投稿3 = 計4枚
    const totalImages = handles.length * 4;
    if (isRefreshing) progress.open(totalImages);
    handles.forEach(h => {
      const node = tpl.content.cloneNode(true);
      const a = document.createElement("a");
      a.href = `https://x.com/${stripAt(h)}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = h;
      const h2 = node.querySelector(".handle");
      h2.innerHTML = "";
      h2.appendChild(a);
      const profileImg = node.querySelector(".profile");
      const bump = () => { progress.inc(); syncHScrollWidth(); };
      profileImg.onload = profileImg.onerror = bump;
      profileImg.src = r2Url(h, "profile") + `?v=${bust}`;
      const posts = node.querySelectorAll(".posts img");
      [1,2,3].forEach((i, idx) => {
        const img = posts[idx];
        img.onload = img.onerror = bump;
        img.src = r2Url(h, `posts/${i}`) + `?v=${bust}`;
      });
      // 削除ボタンの動作：ローカル一覧から削除 + サーバーへR2削除を依頼
      node.querySelector(".btn-del").onclick = async () => {
        const user = stripAt(h);
        const ok = confirm(`@${user} を一覧から削除し、\nR2上の "accounts/${user}/" も削除します。よろしいですか？`);
        if (!ok) return;
        try {
          if (!apiBase) throw new Error("API_BASE が未設定です");

          // DELETE実行
          const res = await fetch(`${apiBase}/accounts/${user}`, { method: "DELETE" });
          if (!res.ok) throw new Error("サーバー削除失敗");
          const j = await res.json();

          // R2キャッシュ遅延を回避するために、ローカルstateを即時更新
          state.handles.delete(`@${user}`);

          // UI更新
          save();
          render();

          // R2の最新リストも非同期で反映（キャッシュバスター付き）
          setTimeout(async () => {
            const latest = await fetchAccounts();
            state.handles = new Set(latest);
            save(); render();
          }, 2000);
        } catch (e) {
          alert(`削除でエラー: ${e?.message || e}`);
        }
      };


      board.appendChild(node);
    });
    syncHScrollWidth();
    if (hscroll) hscroll.scrollLeft = board.scrollLeft;
  }

  document.getElementById("btn-add").onclick = async () => {
    const raw = document.getElementById("handles").value.trim();
    const handles = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (handles.length === 0) return;
    try {
      if (!apiBase) throw new Error("API_BASE が未設定です");
      await fetch(`${apiBase}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handles })
      });
      const latest = await fetchAccounts();
      state.handles = new Set(latest);
      save(); render();
    } catch (e) {
      alert(`追加に失敗しました: ${e?.message || e}`);
    }
  };

  document.getElementById("btn-refresh").onclick = async () => {
    if (!apiBase) { alert("API_BASE が未設定です"); return; }
    const handles = [...state.handles].map(h => h.replace(/^@/, '')).filter(Boolean);
    if (!handles.length) { alert("ハンドルが空です"); return; }

    try {
      isRefreshing = true;
      // 画像読込で progress を進める設計なので、ここでは“総画像枚数”をセットするだけ
      progress.open(handles.length * 4); // 1アカウント=4枚（profile+post3）

      const qs = encodeURIComponent(handles.join(","));
      const url = `${apiBase}/refresh?handles=${qs}`;
      const res = await fetch(url, { method: "GET", mode: "cors", credentials: "omit" });
      if (!res.ok) throw new Error(`/refresh failed: ${res.status}`);
      const json = await res.json();
      console.log("refresh:", json);

      // R2/CDNの反映を少し待ってから再読込
      await new Promise(r => setTimeout(r, 1200));
      render();
    } catch (e) {
      alert(`更新APIエラー: ${e?.message || e}`);
    } finally {
      isRefreshing = false;
      setTimeout(() => progress.close(), 4000);
    }
  };



  // サーバー一覧を読み込んでから描画
  (async () => {
    const list = await fetchAccounts();
    state.handles = new Set(list);
    save();
    render();
  })();
}
