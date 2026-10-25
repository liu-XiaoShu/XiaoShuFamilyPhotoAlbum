/* 小树时光相册前端 */
const state = {
  currentPath: null,
  pendingRotate: 0,
  cropEnabled: false,
  mediaKind: "image",
  videoDuration: 0,
  trimDirty: false,
  trimStart: 0,
  trimEnd: 0,
  galleryPaths: [],
  galleryIndex: 0,
  reopenLightbox: false,
  editReturnPath: null,
  thumbBust: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  naturalW: 0,
  naturalH: 0,
  fitScale: 1,
  crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
  viewMode: "journey",
  mediaKindFilter: (() => {
    const v = localStorage.getItem("xiaoshu_media_kind") || "all";
    return ["all", "image", "video"].includes(v) ? v : "all";
  })(),
  section: "browse",
  manageTab: (() => {
    const m = localStorage.getItem("xiaoshu_manage") || "album";
    return ["album", "import", "trash", "settings", "storage", "visitors", "about"].includes(m) ? m : "album";
  })(),
  trashSort: localStorage.getItem("xiaoshu_trash_sort") || "deleted_at",
  trashSelectMode: false,
  trashSelected: new Set(),
  trashItems: [],
  me: null,
  timelineCache: null,
  outlineCache: null,
  monthPhotoCache: {},
  classicState: null,
  mapSummary: null,
  shareMode: "years",
  shareYears: new Set(),
  shareMediaPaths: new Set(),
  shareMediaLoaded: false,
  shareMediaVisible: [],
  shareSearchItems: [],
  selectMode: false,
  selectScope: null,
  selectedPaths: new Set(),
  batchTarget: null,
  importItemCount: 0,
  /** @type {Map<string, {ok:boolean, message:string}>} 入库结果，刷新列表后仍保留失败标记 */
  importOutcomes: new Map(),
  _detachedImportList: null,
  _importListParent: null,
  map: null,
  mapLayer: null,
  mapMarkers: null,
  mapProviderKey: "",
  mapPoints: null,
  mapPackPoll: null,
};

function askConfirm(message) {
  // Firefox：页面已有 <dialog> 时 window.confirm/alert 常直接返回 false 且不弹窗
  return new Promise((resolve) => {
    const dlg = document.getElementById("app-confirm-dialog");
    const msgEl = document.getElementById("app-confirm-msg");
    const yes = document.getElementById("app-confirm-yes");
    const no = document.getElementById("app-confirm-no");
    if (!dlg || !msgEl || !yes || !no || typeof dlg.showModal !== "function") {
      resolve(window.confirm(message));
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      dlg.removeEventListener("cancel", onCancel);
      dlg.removeEventListener("close", onClose);
      try {
        if (dlg.open) dlg.close();
      } catch (_) {}
      resolve(ok);
    };
    const onYes = (e) => {
      e.preventDefault();
      finish(true);
    };
    const onNo = (e) => {
      e.preventDefault();
      finish(false);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    const onClose = () => finish(false);
    msgEl.textContent = message;
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("close", onClose);
    try {
      if (dlg.open) dlg.close();
      dlg.showModal();
    } catch (_) {
      finish(window.confirm(message));
    }
  });
}

async function api(url, options = {}) {
  const opts = { ...options };
  const headers = { ...(opts.headers || {}) };
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (!isForm && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  opts.headers = headers;
  if (!opts.credentials) opts.credentials = "same-origin";
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.detail || JSON.stringify(j);
    } catch (_) {
      try {
        msg = await res.text();
      } catch (__) {}
    }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

function $(sel) {
  return document.querySelector(sel);
}

function toLocalInput(dt) {
  if (!dt) return "";
  return dt.replace(" ", "T").slice(0, 16);
}

function fromLocalInput(v) {
  if (!v) return null;
  return v.length === 16 ? `${v.replace("T", " ")}:00` : v.replace("T", " ");
}

function escapeAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function canonicalizeAlbumPath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const i = s.indexOf(".narration.");
  if (i > 0) return s.slice(0, i);
  return s;
}

/* 一级：相册浏览 / 相册管理 */
function applySection() {
  const section = state.section === "manage" ? "manage" : "browse";
  state.section = section;
  localStorage.setItem("xiaoshu_section", section);
  document.querySelectorAll(".tab[data-section]").forEach((b) => {
    b.classList.toggle("active", b.dataset.section === section);
  });
  $("#panel-browse")?.classList.toggle("active", section === "browse");
  $("#panel-manage")?.classList.toggle("active", section === "manage");
  if (section === "browse") {
    if (state.selectMode) setSelectMode(false);
    applyViewMode();
  } else {
    applyManageTab();
  }
}

function applyManageTab() {
  const allowed = manageTabsAllowed();
  const tab = allowed.includes(state.manageTab) ? state.manageTab : allowed[0] || "album";
  state.manageTab = tab;
  localStorage.setItem("xiaoshu_manage", tab);
  document.querySelectorAll('.seg[aria-label="管理功能"] .seg-btn').forEach((b) => {
    const ok = allowed.includes(b.dataset.manage);
    b.classList.toggle("hidden", !ok);
    b.classList.toggle("active", b.dataset.manage === tab);
  });
  $("#manage-album")?.classList.toggle("hidden", tab !== "album");
  $("#manage-import")?.classList.toggle("hidden", tab !== "import");
  $("#manage-trash")?.classList.toggle("hidden", tab !== "trash");
  $("#manage-settings")?.classList.toggle("hidden", tab !== "settings");
  $("#manage-storage")?.classList.toggle("hidden", tab !== "storage");
  $("#manage-visitors")?.classList.toggle("hidden", tab !== "visitors");
  $("#manage-about")?.classList.toggle("hidden", tab !== "about");
  if (tab !== "album" && state.selectMode) setSelectMode(false);
  if (tab !== "trash" && state.trashSelectMode) setTrashSelectMode(false);
  if (tab === "album") loadTree().catch(console.error);
  if (tab === "import") {
    resetImportUiState();
    loadImport().catch(console.error);
  }
  if (tab === "trash") loadTrash().catch(console.error);
  if (tab === "settings") loadSettings().catch(console.error);
  if (tab === "storage") loadStorage().catch(console.error);
  if (tab === "visitors") loadVisitorStats().catch(console.error);
}

function manageTabsAllowed() {
  const me = state.me || {};
  const tabs = ["album"];
  if (me.can_upload || me.open_mode) tabs.push("import");
  if (me.can_trash || me.open_mode) tabs.push("trash");
  if (me.can_settings || me.open_mode || me.needs_setup) tabs.push("settings");
  if (me.can_settings) tabs.push("storage");
  if (me.can_settings) tabs.push("visitors");
  // 登录后均可看关于（含分享访客）
  if (me.authenticated || me.open_mode) tabs.push("about");
  return tabs;
}

function applyCapabilities(me) {
  state.me = me || state.me || {};
  const m = state.me;
  document.body.classList.toggle(
    "cap-no-edit",
    !(m.can_edit || m.open_mode || m.kind === "share")
  );
  const who = $("#auth-who");
  const role = $("#auth-role");
  const chip = $("#auth-chip");
  const loginBtn = $("#btn-auth-open");
  const logoutBtn = $("#btn-auth-logout");
  chip?.classList.remove("is-admin", "is-share", "is-guest", "is-open");
  if (m.is_admin) {
    if (role) role.textContent = "超管";
    if (who) who.textContent = m.username || "admin";
    chip?.classList.add("is-admin");
  } else if (m.kind === "share") {
    if (role) role.textContent = "分享";
    if (who) who.textContent = m.share_label || "访客";
    chip?.classList.add("is-share");
  } else if (m.open_mode) {
    if (role) role.textContent = "本机";
    if (who) who.textContent = "开放模式";
    chip?.classList.add("is-open");
  } else {
    if (role) role.textContent = "访客";
    if (who) who.textContent = "未登录";
    chip?.classList.add("is-guest");
  }
  // 角色与名称之间用分隔点，与退出按钮成对更整齐
  if (chip && role && who) {
    let sep = chip.querySelector(".auth-sep");
    if (!sep) {
      sep = document.createElement("span");
      sep.className = "auth-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "·";
      chip.insertBefore(sep, who);
    }
  }
  const authed = Boolean(m.authenticated);
  loginBtn?.classList.toggle("hidden", authed && !m.needs_setup);
  if (loginBtn) {
    loginBtn.textContent = m.needs_setup ? "创建账号" : "登录";
    loginBtn.setAttribute("href", "/login");
  }
  logoutBtn?.classList.toggle("hidden", !authed);
  if (state.section === "manage") applyManageTab();
}

function bindBrandMotion() {
  const roots = [document.getElementById("brand-block"), document.querySelector(".login-brand")].filter(
    Boolean
  );
  roots.forEach((root) => {
    const icon = root.querySelector(".brand-mark");
    if (!icon) return;
    const reset = () => {
      icon.classList.remove("is-tilt");
      icon.style.transform = "";
    };
    root.addEventListener("pointermove", (e) => {
      const r = root.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      const rotY = x * 16;
      const rotX = -y * 12;
      const tx = x * 6;
      const ty = y * 6;
      icon.classList.add("is-tilt");
      icon.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(1.06)`;
    });
    root.addEventListener("pointerleave", reset);
  });
}
bindBrandMotion();

document.querySelectorAll(".tab[data-section]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.section = btn.dataset.section;
    applySection();
    if (state.section === "browse") loadBrowse().catch(console.error);
  });
});

document.querySelectorAll('.seg[aria-label="管理功能"] .seg-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    state.manageTab = btn.dataset.manage;
    applyManageTab();
  });
});

/* Timeline / 浏览模式 */
const MONTH_PAGE = 120;
const CLASSIC_PAGE = 40;

async function loadOutline(force = false, { brief = true } = {}) {
  const have = state.outlineCache;
  if (!force && have?.years) {
    if (!have.brief) return have; // 完整大纲
    if (brief) return have; // brief 够用
  }
  const data = await api(`/api/timeline/outline${brief ? "?brief=1" : ""}`);
  if (!have?.years || force || !brief || have.brief) {
    state.outlineCache = data;
  }
  state.timelineCache = state.outlineCache;
  return data;
}

function mediaKindQuery() {
  const k = state.mediaKindFilter || "all";
  return k === "image" || k === "video" ? k : "";
}

function monthMatchesKindFilter(m) {
  const f = state.mediaKindFilter || "all";
  if (f === "video") return (m.video_count || 0) > 0;
  if (f === "image") return (m.image_count || (m.photo_count || 0) - (m.video_count || 0)) > 0;
  return (m.photo_count || 0) > 0;
}

function yearMatchesKindFilter(y) {
  const f = state.mediaKindFilter || "all";
  if (f === "video") {
    return (y.video_count != null
      ? y.video_count
      : (y.months || []).reduce((n, m) => n + (m.video_count || 0), 0)) > 0;
  }
  if (f === "image") {
    const img =
      y.image_count != null
        ? y.image_count
        : (y.months || []).reduce(
            (n, m) => n + (m.image_count || Math.max(0, (m.photo_count || 0) - (m.video_count || 0))),
            0
          );
    return img > 0;
  }
  return (y.photo_count || (y.months || []).reduce((n, m) => n + (m.photo_count || 0), 0)) > 0;
}

function clearMonthPhotoCache() {
  state.monthPhotoCache = {};
}

async function fetchMonthPhotos(month, offset = 0, limit = MONTH_PAGE) {
  const kind = mediaKindQuery() || "all";
  const key = `${month}@${offset}@${limit}@${kind}`;
  if (state.monthPhotoCache[key]) return state.monthPhotoCache[key];
  const qs = new URLSearchParams({
    month,
    offset: String(offset),
    limit: String(limit),
  });
  if (kind !== "all") qs.set("kind", kind);
  const data = await api(`/api/timeline/month?${qs.toString()}`);
  state.monthPhotoCache[key] = data;
  return data;
}

async function fetchScopePaths(scopeKey) {
  if (!scopeKey) return [];
  const kind = mediaKindQuery();
  const kindQs = kind ? `&kind=${encodeURIComponent(kind)}` : "";
  if (scopeKey.startsWith("year:")) {
    const y = scopeKey.slice(5);
    const r = await api(`/api/timeline/paths?year=${encodeURIComponent(y)}${kindQs}`);
    return r.paths || [];
  }
  if (scopeKey.startsWith("month:")) {
    const m = scopeKey.slice(6);
    const r = await api(`/api/timeline/paths?month=${encodeURIComponent(m)}${kindQs}`);
    return r.paths || [];
  }
  return [];
}

function applyViewMode() {
  if (!["journey", "classic", "map", "search"].includes(state.viewMode)) {
    state.viewMode = "journey";
  }
  const journey = $("#journey-root");
  const classic = $("#classic-root");
  const mapRoot = $("#map-root");
  const searchRoot = $("#search-root");
  document.querySelectorAll('.seg[aria-label="浏览模式"] .seg-btn').forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.viewMode);
  });
  journey?.classList.add("hidden");
  classic?.classList.add("hidden");
  mapRoot?.classList.add("hidden");
  searchRoot?.classList.add("hidden");
  const empty = !(state.outlineCache?.years?.length || state.timelineCache?.years?.length);
  if (state.viewMode === "search") {
    $("#browse-empty")?.classList.add("hidden");
    searchRoot?.classList.remove("hidden");
    setTimeout(() => $("#search-q")?.focus(), 40);
    updateSelectUI();
    return;
  }
  if (empty) {
    // 首屏加载中不闪「空相册」
    $("#browse-empty")?.classList.add("hidden");
    if (state.viewMode === "journey") {
      journey?.classList.remove("hidden");
      if (journey && !journey.innerHTML.trim()) {
        journey.innerHTML = `<p class="muted" style="padding:1rem 0">加载相册大纲…</p>`;
      }
    } else if (state.viewMode === "classic") {
      classic?.classList.remove("hidden");
    } else if (state.viewMode === "map") {
      mapRoot?.classList.remove("hidden");
      $("#map-status").textContent = "加载地图…";
    }
    updateSelectUI();
    return;
  }
  $("#browse-empty")?.classList.add("hidden");
  if (state.viewMode === "journey") {
    journey?.classList.remove("hidden");
    if (state.outlineCache) renderJourney(state.outlineCache);
  } else if (state.viewMode === "classic") {
    classic?.classList.remove("hidden");
    // 分类变化时强制重建经典流
    if (state.classicState) state.classicState.built = false;
    const root = $("#classic-root");
    if (root) root.dataset.built = "";
    ensureClassicView(true).catch((e) => console.error(e));
  } else if (state.viewMode === "map") {
    mapRoot?.classList.remove("hidden");
    loadMap(false).catch((e) => {
      $("#map-status").textContent = e.message;
    });
  }
  updateSelectUI();
}

function flattenTimelinePhotos(data) {
  const list = [];
  (data?.years || []).forEach((y) => {
    (y.months || []).forEach((m) => {
      (m.photos || []).forEach((p) => list.push(p));
    });
  });
  return list;
}

function formatClassicDay(day) {
  if (!day || day === "未知日期" || day.length < 10) return day || "未知日期";
  const [y, mo, d] = day.split("-");
  const dt = new Date(`${day}T12:00:00`);
  const week = ["日", "一", "二", "三", "四", "五", "六"][dt.getDay()] || "";
  return `${y}年${Number(mo)}月${Number(d)}日 周${week}`;
}

function outlineMonthList(outline) {
  const list = [];
  (outline?.years || []).forEach((y) => {
    (y.months || []).forEach((m) => {
      if (!monthMatchesKindFilter(m)) return;
      list.push({
        month: m.month,
        photo_count: m.photo_count || 0,
      });
    });
  });
  return list;
}

function appendClassicPhotos(photos, root) {
  const body = root.querySelector(".classic-body") || root;
  let curSection = body.querySelector(".classic-day:last-child");
  let curDay = curSection?.dataset?.day || null;
  let curGrid = curSection?.querySelector(".classic-grid") || null;

  const pendingImgs = [];
  photos.forEach((p) => {
    const day = ((p.meta && p.meta.datetime) || "").slice(0, 10) || "未知日期";
    if (day !== curDay) {
      curDay = day;
      curSection = document.createElement("section");
      curSection.className = "classic-day";
      curSection.dataset.day = day;
      const h = document.createElement("header");
      h.className = "classic-day-head";
      h.innerHTML = `<strong>${formatClassicDay(day)}</strong><span class="muted classic-day-n">0 张</span>`;
      curGrid = document.createElement("div");
      curGrid.className = "classic-grid";
      curSection.appendChild(h);
      curSection.appendChild(curGrid);
      body.appendChild(curSection);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "classic-cell";
    btn.dataset.path = p.path;
    const title = (p.meta && p.meta.title) || p.name || "";
    const isVid = p.kind === "video" || isVideoName(p.name);
    btn.title = title;
    btn.dataset.kind = isVid ? "video" : "image";
    const thumbSrc = `/api/thumb?path=${encodeURIComponent(p.path)}&size=${albumThumbSize()}&_=${state.thumbBust || 0}`;
    btn.innerHTML = `
      ${
        isVid
          ? `<span class="classic-vid" aria-hidden="true">视频</span>`
          : `<span class="classic-img-badge" aria-hidden="true">照片</span>`
      }
      <img class="classic-thumb js-thumb" decoding="async" alt="${escapeAttr(title)}"
        data-src="${thumbSrc}" />`;
    if (state.mediaKindFilter === "image" && isVid) btn.classList.add("media-kind-hidden");
    if (state.mediaKindFilter === "video" && !isVid) btn.classList.add("media-kind-hidden");
    btn.addEventListener("click", () =>
      openLightbox(p.path, state.classicPaths || [], p.meta || null)
    );
    pendingImgs.push(btn.querySelector("img.classic-thumb"));
    curGrid.appendChild(btn);
    const nEl = curSection.querySelector(".classic-day-n");
    if (nEl) nEl.textContent = `${curGrid.children.length} 张`;
    state.classicPaths.push(p.path);
  });
  bindClassicThumbLazy(pendingImgs);
}

async function ensureClassicView(force = false) {
  const root = $("#classic-root");
  if (!root) return;
  const outline = state.outlineCache || (await loadOutline());
  if (!force && state.classicState?.built && root.dataset.built === "1") return;

  root.innerHTML = "";
  state.classicPaths = [];
  const months = outlineMonthList(outline);
  const total = outline.total || months.reduce((n, m) => n + (m.photo_count || 0), 0);
  const head = document.createElement("div");
  head.className = "classic-toolbar";
  head.innerHTML = `<span class="classic-total">共 ${total} 张 · 滚动加载 · 点击沉浸翻看</span>`;
  const body = document.createElement("div");
  body.className = "classic-body";
  const sentinel = document.createElement("div");
  sentinel.className = "classic-sentinel muted";
  sentinel.textContent = months.length ? "向下滚动加载更多…" : "暂无照片";
  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(sentinel);
  root.dataset.built = "1";

  state.classicState = {
    built: true,
    months,
    monthIdx: 0,
    offset: 0,
    loading: false,
    done: !months.length,
    sentinel,
  };

  const loadMore = async () => {
    const st = state.classicState;
    if (!st || st.loading || st.done) return;
    st.loading = true;
    sentinel.textContent = "加载中…";
    try {
      let loaded = 0;
      while (loaded < CLASSIC_PAGE && st.monthIdx < st.months.length) {
        const m = st.months[st.monthIdx];
        const page = await fetchMonthPhotos(m.month, st.offset, CLASSIC_PAGE - loaded);
        appendClassicPhotos(page.photos || [], root);
        loaded += (page.photos || []).length;
        if (page.has_more) {
          st.offset = (page.offset || 0) + (page.photos || []).length;
        } else {
          st.monthIdx += 1;
          st.offset = 0;
        }
        if (!(page.photos || []).length && !page.has_more) {
          st.monthIdx += 1;
          st.offset = 0;
        }
      }
      st.done = st.monthIdx >= st.months.length;
      sentinel.textContent = st.done ? "已加载全部" : "向下滚动加载更多…";
      const totalEl = root.querySelector(".classic-total");
      if (totalEl) {
        totalEl.textContent = `已加载 ${state.classicPaths.length} / ${total} 张 · 点击沉浸翻看`;
      }
      enqueueVisibleThumbs([...root.querySelectorAll("img.classic-thumb.js-thumb")]);
    } catch (e) {
      sentinel.textContent = e.message || String(e);
    } finally {
      st.loading = false;
    }
  };

  if (state._classicObserver) {
    state._classicObserver.disconnect();
    state._classicObserver = null;
  }
  state._classicObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((en) => en.isIntersecting)) loadMore();
    },
    { root: null, rootMargin: "200px", threshold: 0 }
  );
  state._classicObserver.observe(sentinel);
  await loadMore();
}

/** @deprecated 全量渲染，仅兼容旧调用 */
function renderClassic(data) {
  state.outlineCache = data;
  ensureClassicView(true).catch(console.error);
}

function buildMonthSelectBar(monthKey) {
  const bar = document.createElement("div");
  bar.className = "album-select-bar";
  bar.innerHTML = `
    <button type="button" class="btn ghost btn-scope-select">选择</button>
    <button type="button" class="btn ghost btn-scope-all hidden">全选</button>
    <button type="button" class="btn ghost btn-scope-batch hidden">批量编辑</button>
    <button type="button" class="btn ghost btn-scope-trash hidden">移入回收站</button>`;
  const btnSelect = bar.querySelector(".btn-scope-select");
  const btnAll = bar.querySelector(".btn-scope-all");
  const btnBatch = bar.querySelector(".btn-scope-batch");
  const btnTrash = bar.querySelector(".btn-scope-trash");
  btnSelect.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.selectMode && state.selectScope === monthKey) {
      setSelectMode(false);
      return;
    }
    btnSelect.disabled = true;
    try {
      const paths = await fetchScopePaths(monthKey);
      setSelectMode(true, monthKey, paths);
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      btnSelect.disabled = false;
    }
  });
  btnAll.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!(state.selectMode && state.selectScope === monthKey && state.selectPathsSet)) return;
    const allPaths = [...state.selectPathsSet];
    const allOn = allPaths.length > 0 && allPaths.every((p) => state.selectedPaths.has(p));
    if (allOn) {
      state.selectedPaths.clear();
      document.querySelectorAll(".photo-card.selectable").forEach((c) => c.classList.remove("selected"));
    } else {
      allPaths.forEach((p) => state.selectedPaths.add(p));
      document.querySelectorAll(".photo-card.selectable").forEach((c) => {
        if (state.selectedPaths.has(c.dataset.path)) c.classList.add("selected");
      });
    }
    updateSelectUI();
  });
  btnBatch.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const n = state.selectedPaths.size;
    if (!n) {
      alert("请先点选照片");
      return;
    }
    openBatchDialog("library", n);
  });
  btnTrash.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    moveSelectedToTrash().catch((err) => alert(err.message || String(err)));
  });
  bar.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return bar;
}

function syncScopeBars() {
  document.querySelectorAll(".album-select-bar").forEach((bar) => {
    const monthEl = bar.closest(".month, .year");
    const key = monthEl?.dataset?.scopeKey;
    const active = state.selectMode && state.selectScope === key;
    bar.querySelector(".btn-scope-select").textContent = active ? "取消选择" : "选择";
    bar.querySelector(".btn-scope-select").classList.toggle("is-active", active);
    const n = active ? state.selectedPaths.size : 0;
    const scopeSize = active && state.selectPathsSet ? state.selectPathsSet.size : 0;
    const allOn = active && scopeSize > 0 && n >= scopeSize;
    const allBtn = bar.querySelector(".btn-scope-all");
    if (allBtn) {
      allBtn.classList.toggle("hidden", !active);
      allBtn.textContent = allOn ? "取消全选" : "全选";
      allBtn.classList.toggle("is-active", allOn);
    }
    const batch = bar.querySelector(".btn-scope-batch");
    const trash = bar.querySelector(".btn-scope-trash");
    batch.classList.toggle("hidden", !(active && n > 0));
    batch.textContent = n ? `批量编辑(${n})` : "批量编辑";
    trash.classList.toggle("hidden", !(active && n > 0));
    trash.textContent = n ? `移入回收站(${n})` : "移入回收站";
  });
}

async function moveSelectedToTrash() {
  const paths = [...state.selectedPaths];
  if (!paths.length) {
    alert("请先点选照片");
    return;
  }
  if (!confirm(`确定将 ${paths.length} 项移入回收站？\n可在「相册管理 → 回收站」恢复或彻底删除。`)) {
    return;
  }
  const r = await api("/api/photo/trash", {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
  setSelectMode(false);
  await loadTree(true);
  await invalidateMapData();
  alert(r.message || "已移入回收站");
}

function journeyTitleFreqBrief(topTitles) {
  const ranked = (topTitles || []).filter(Boolean).slice(0, 5);
  if (!ranked.length) return "这一年还在生长。";
  return `代表瞬间：${ranked.join(" · ")}`;
}

function renderJourney(data) {
  const root = $("#journey-root");
  if (!root) return;
  root.innerHTML = "";
  const rail = document.createElement("div");
  rail.className = "journey-rail";
  const shaft = document.createElement("div");
  shaft.className = "journey-shaft";
  const head = document.createElement("div");
  head.className = "journey-head";
  rail.appendChild(shaft);
  rail.appendChild(head);

  (data.years || []).forEach((y) => {
    if (!yearMatchesKindFilter(y)) return;
    const albums = (y.months || []).filter(monthMatchesKindFilter).length || y.month_count || (y.months || []).length;
    const imageCount = y.image_count != null
      ? y.image_count
      : (y.months || []).reduce((n, m) => n + (m.image_count || (m.photos || []).filter((p) => p.kind !== "video").length), 0);
    const videoCount = y.video_count != null
      ? y.video_count
      : (y.months || []).reduce((n, m) => n + (m.video_count || (m.photos || []).filter((p) => p.kind === "video").length), 0);
    const brief = journeyTitleFreqBrief(y.top_titles);

    const item = document.createElement("div");
    item.className = "journey-item";
    item.dataset.year = y.year;

    const dot = document.createElement("span");
    dot.className = "journey-dot";
    dot.setAttribute("aria-hidden", "true");

    const node = document.createElement("button");
    node.type = "button";
    node.className = "journey-node";
    const f = state.mediaKindFilter || "all";
    const showImg = f !== "video";
    const showVid = f !== "image";
    const videoStat =
      showVid && videoCount > 0
        ? `<span>视频 <strong>${videoCount}</strong> 条</span>`
        : "";
    const photoStat = showImg
      ? `<span>照片 <strong>${imageCount}</strong> 张</span>`
      : "";
    node.innerHTML = `
      <div class="journey-year">${y.year}</div>
      <div class="journey-stats">
        <span>相册 <strong>${albums}</strong> 册</span>
        ${photoStat}
        ${videoStat}
      </div>
      <p class="journey-brief">${escapeAttr(brief)}</p>`;

    const albumsBox = document.createElement("div");
    albumsBox.className = "journey-albums";
    (y.months || []).forEach((m) => {
      if (!monthMatchesKindFilter(m)) return;
      const albumBtn = document.createElement("button");
      albumBtn.type = "button";
      albumBtn.className = "journey-album";
      const monthLabel = m.month;
      const mImg = m.image_count != null
        ? m.image_count
        : (m.photos || []).filter((p) => p.kind !== "video").length;
      const mVid = m.video_count != null
        ? m.video_count
        : (m.photos || []).filter((p) => p.kind === "video").length;
      const mTotal =
        f === "video" ? mVid : f === "image" ? mImg : (m.photo_count != null ? m.photo_count : mImg + mVid);
      const metaBits = [];
      if (f === "video") metaBits.push(`${mVid} 条视频`);
      else if (f === "image") metaBits.push(`${mImg} 张`);
      else {
        metaBits.push(`${mTotal || mImg} 张`);
        if (mVid) metaBits.push(`${mVid} 条视频`);
      }
      albumBtn.innerHTML = `
        <span class="journey-album-name">${monthLabel}</span>
        <span class="journey-album-meta">${metaBits.join(" · ")}</span>`;
      albumBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openYearMonthInTree(y.year, m.month);
      });
      albumsBox.appendChild(albumBtn);
    });

    node.addEventListener("click", () => {
      const willOpen = !item.classList.contains("open");
      rail.querySelectorAll(".journey-item.open").forEach((el) => {
        if (el !== item) el.classList.remove("open");
      });
      item.classList.toggle("open", willOpen);
      if (willOpen) {
        item.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });

    item.appendChild(dot);
    item.appendChild(node);
    item.appendChild(albumsBox);
    rail.appendChild(item);
  });
  root.appendChild(rail);
}

function makePhotoCard(p, galleryPaths) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "photo-card";
  card.dataset.path = p.path;
  const title = (p.meta && p.meta.title) || p.name;
  const isVid = p.kind === "video" || isVideoName(p.name);
  card.dataset.kind = isVid ? "video" : "image";
  const thumbSrc = `/api/thumb?path=${encodeURIComponent(p.path)}&size=${albumThumbSize()}&_=${state.thumbBust || 0}`;
  card.innerHTML = `
    <span class="photo-check" aria-hidden="true"></span>
    ${
      isVid
        ? `<span class="media-badge media-badge-video" aria-hidden="true">视频</span>`
        : `<span class="media-badge media-badge-image" aria-hidden="true">照片</span>`
    }
    <img class="js-thumb" loading="lazy" decoding="async" data-src="${thumbSrc}" alt="" />
    <span>${escapeHtml(title)}</span>`;
  if (state.mediaKindFilter === "image" && isVid) card.classList.add("media-kind-hidden");
  if (state.mediaKindFilter === "video" && !isVid) card.classList.add("media-kind-hidden");
  card.addEventListener("click", (e) => {
    if (state.selectMode) {
      e.preventDefault();
      if (state.selectPathsSet && !state.selectPathsSet.has(p.path)) return;
      toggleSelectPath(p.path, card);
      return;
    }
    openLightbox(p.path, galleryPaths);
  });
  if (state.selectedPaths.has(p.path)) card.classList.add("selected");
  if (state.selectMode && state.selectPathsSet?.has(p.path)) {
    card.classList.add("selectable");
  }
  return card;
}

async function fillMonthGrid(monthEl, month, opts = {}) {
  const { force = false } = opts;
  let grid = monthEl.querySelector(".month-body.photo-grid");
  if (!grid) {
    grid = document.createElement("div");
    grid.className = "month-body photo-grid";
    monthEl.appendChild(grid);
  }
  const kind = mediaKindQuery() || "all";
  if (grid.dataset.loaded === "1" && grid.dataset.kind === kind && !force) return;

  const paths = [];
  let offset = 0;
  grid.innerHTML = `<p class="muted month-loading">加载中…</p>`;
  monthEl.open = true;

  const appendPage = async () => {
    const page = await fetchMonthPhotos(month, offset, MONTH_PAGE);
    const photos = page.photos || [];
    if (offset === 0) grid.innerHTML = "";
    const moreBtn = grid.querySelector(".month-more");
    moreBtn?.remove();
    photos.forEach((p) => {
      paths.push(p.path);
      grid.appendChild(makePhotoCard(p, paths));
    });
    bindAlbumThumbLazy(grid);
    offset = (page.offset || 0) + photos.length;
    if (page.has_more) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn ghost month-more";
      btn.textContent = `加载更多（已 ${paths.length} / ${page.total}）`;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = "加载中…";
        try {
          await appendPage();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = err.message || "重试";
        }
      });
      grid.appendChild(btn);
    } else {
      grid.dataset.loaded = "1";
      grid.dataset.kind = kind;
    }
    grid.dataset.total = String(page.total || paths.length);
  };

  await appendPage();
  monthEl.dataset.loadedPaths = "1";
}

async function openYearMonthInTree(year, month) {
  state.section = "manage";
  state.manageTab = "album";
  localStorage.setItem("xiaoshu_section", "manage");
  localStorage.setItem("xiaoshu_manage", "album");
  document.querySelectorAll(".tab[data-section]").forEach((b) => {
    b.classList.toggle("active", b.dataset.section === "manage");
  });
  $("#panel-browse")?.classList.remove("active");
  $("#panel-manage")?.classList.add("active");
  document.querySelectorAll('.seg[aria-label="管理功能"] .seg-btn').forEach((b) => {
    b.classList.toggle("active", b.dataset.manage === "album");
  });
  $("#manage-album")?.classList.remove("hidden");
  $("#manage-import")?.classList.add("hidden");
  $("#manage-trash")?.classList.add("hidden");
  $("#manage-settings")?.classList.add("hidden");
  $("#manage-storage")?.classList.add("hidden");
  $("#manage-visitors")?.classList.add("hidden");
  $("#manage-about")?.classList.add("hidden");
  await loadTree();
  const yearEl = [...($("#tree-root")?.querySelectorAll(".year") || [])].find((el) =>
    (el.querySelector("summary")?.textContent || "").startsWith(String(year))
  );
  if (!yearEl) return;
  yearEl.open = true;
  const monthEl = [...yearEl.querySelectorAll(".month")].find((el) =>
    (el.querySelector("summary")?.textContent || "").startsWith(String(month))
  );
  if (monthEl) {
    await fillMonthGrid(monthEl, month);
    monthEl.open = true;
  }
  (monthEl || yearEl).scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadBrowse(force = false) {
  const root = $("#journey-root");
  if (root && !state.outlineCache) {
    root.innerHTML = `<p class="muted" style="padding:1rem 0">加载相册大纲…</p>`;
  }
  const data = await loadOutline(force, { brief: true });
  if (force) {
    state.classicState = null;
    const classic = $("#classic-root");
    if (classic) classic.dataset.built = "";
  }
  const browseEmpty = $("#browse-empty");
  if (!data.years.length) {
    browseEmpty?.classList.remove("hidden");
    $("#journey-root")?.classList.add("hidden");
    $("#classic-root")?.classList.add("hidden");
    $("#map-root")?.classList.add("hidden");
    return;
  }
  browseEmpty?.classList.add("hidden");
  renderJourney(data);
  if (state.section === "browse") applyViewMode();
  // 后台补全「代表瞬间」简述，不阻塞首屏
  if (data.brief) {
    loadOutline(true, { brief: false })
      .then((full) => {
        if (state.section === "browse" && state.viewMode === "journey") {
          renderJourney(full);
        }
      })
      .catch(() => {});
  }
}

async function loadTree(force = false) {
  const data = await loadOutline(force);
  state.monthPhotoCache = force ? {} : state.monthPhotoCache;
  if (force) {
    state.classicState = null;
    const classic = $("#classic-root");
    if (classic) classic.dataset.built = "";
  }
  const root = $("#tree-root");
  const treeEmpty = $("#tree-empty");
  const browseEmpty = $("#browse-empty");
  if (root) root.innerHTML = "";
  if (!data.years.length) {
    treeEmpty?.classList.remove("hidden");
    if (state.section === "browse") {
      browseEmpty?.classList.remove("hidden");
      $("#journey-root")?.classList.add("hidden");
      $("#classic-root")?.classList.add("hidden");
      $("#map-root")?.classList.add("hidden");
    }
    return;
  }
  treeEmpty?.classList.add("hidden");
  browseEmpty?.classList.add("hidden");

  data.years.forEach((y) => {
    const yearEl = document.createElement("details");
    yearEl.className = "year";
    yearEl.dataset.scopeKey = `year:${y.year}`;
    const count = y.photo_count != null
      ? y.photo_count
      : (y.months || []).reduce((n, m) => n + (m.photo_count || (m.photos || []).length), 0);
    const yearSummary = document.createElement("summary");
    yearSummary.innerHTML = `<span>${y.year}<span class="muted"> · ${count} 张</span></span>`;
    yearSummary.appendChild(buildMonthSelectBar(`year:${y.year}`));
    yearEl.appendChild(yearSummary);
    const body = document.createElement("div");
    body.className = "year-body months";

    yearEl.addEventListener("toggle", () => {
      if (!yearEl.open) {
        yearEl.querySelectorAll(".month").forEach((mEl) => {
          mEl.open = false;
          const g = mEl.querySelector(".month-body.photo-grid");
          if (g) {
            g.innerHTML = "";
            delete g.dataset.loaded;
          }
        });
        return;
      }
      root?.querySelectorAll(".year").forEach((el) => {
        if (el !== yearEl && el.open) el.open = false;
      });
    });

    (y.months || []).forEach((m) => {
      if (!monthMatchesKindFilter(m)) return;
      const monthEl = document.createElement("details");
      monthEl.className = "month";
      monthEl.dataset.scopeKey = `month:${m.month}`;
      monthEl.dataset.month = m.month;
      const f = state.mediaKindFilter || "all";
      const mImg = m.image_count != null ? m.image_count : 0;
      const mVid = m.video_count != null ? m.video_count : 0;
      const mCount =
        f === "video"
          ? mVid
          : f === "image"
            ? mImg || Math.max(0, (m.photo_count || 0) - mVid)
            : m.photo_count != null
              ? m.photo_count
              : (m.photos || []).length;
      const monthSummary = document.createElement("summary");
      monthSummary.innerHTML = `<span>${m.month}<span class="muted"> · ${mCount} ${
        f === "video" ? "条" : "张"
      }</span></span>`;
      monthSummary.appendChild(buildMonthSelectBar(`month:${m.month}`));
      monthEl.appendChild(monthSummary);
      const grid = document.createElement("div");
      grid.className = "month-body photo-grid";
      monthEl.appendChild(grid);
      monthEl.addEventListener("toggle", () => {
        if (!monthEl.open) {
          grid.innerHTML = "";
          delete grid.dataset.loaded;
          return;
        }
        root?.querySelectorAll(".month").forEach((el) => {
          if (el !== monthEl && el.open) el.open = false;
        });
        fillMonthGrid(monthEl, m.month).catch((err) => {
          grid.innerHTML = `<p class="muted">${escapeHtml(err.message || String(err))}</p>`;
        });
      });
      body.appendChild(monthEl);
    });
    yearEl.appendChild(body);
    root?.appendChild(yearEl);
  });

  if (state.section === "browse") {
    renderJourney(data);
    applyViewMode();
  } else {
    updateSelectUI();
  }
  syncScopeBars();
}

document.querySelectorAll('.seg[aria-label="浏览模式"] .seg-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    state.viewMode = btn.dataset.view;
    localStorage.setItem("xiaoshu_view", state.viewMode);
    if (state.selectMode) setSelectMode(false);
    applyViewMode();
  });
});

$("#btn-refresh-map")?.addEventListener("click", () => {
  loadMap(true).catch(alert);
});

/* Map — 苹果相册「地点」式：高德/离线底图 + 元数据聚点 + 点击展开 */
function loadScriptOnce(src) {
  if (!state._scriptPromises) state._scriptPromises = {};
  if (state._scriptPromises[src]) return state._scriptPromises[src];
  state._scriptPromises[src] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载失败: ${src}`));
    document.head.appendChild(s);
  });
  return state._scriptPromises[src];
}

async function ensureLeaflet() {
  if (typeof L !== "undefined") return;
  await loadScriptOnce("/vendor/leaflet/leaflet.js");
  if (typeof L === "undefined") throw new Error("地图组件未加载");
}

function mapZoomCap(pack) {
  const z = Number(pack && pack.max_zoom);
  if (Number.isFinite(z) && z >= 2) return Math.min(18, Math.max(2, Math.floor(z)));
  if (pack && pack.provider_mode === "amap") return 18;
  return 11;
}

async function ensureMap(pack) {
  await ensureLeaflet();
  const p = pack || state.mapPack || {};
  const mode = p.provider_mode || "offline";
  const maxZ = mapZoomCap(p);
  const want = `${mode}:z${maxZ}`;
  if (state.map && state.mapProviderKey === want) {
    setTimeout(() => state.map && state.map.invalidateSize(), 0);
    return state.map;
  }
  if (typeof L === "undefined") throw new Error("地图组件未加载");

  if (state.map) {
    state.map.remove();
    state.map = null;
    state.mapLayer = null;
    state.mapMarkers = null;
  }

  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "/vendor/leaflet/images/marker-icon-2x.png",
    iconUrl: "/vendor/leaflet/images/marker-icon.png",
    shadowUrl: "/vendor/leaflet/images/marker-shadow.png",
  });

  const el = document.getElementById("album-map");
  if (el && (el.offsetWidth < 10 || el.offsetHeight < 10)) {
    el.style.minHeight = "420px";
  }

  state.map = L.map("album-map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 2,
    maxZoom: maxZ,
    fadeAnimation: false,
    zoomAnimation: true,
    markerZoomAnimation: false,
  });
  // 走 API：高德代理缓存 / 离线包；缺瓦片返回透明占位
  state.mapLayer = L.tileLayer("/api/map/tiles/{z}/{x}/{y}.png", {
    maxZoom: maxZ,
    minZoom: 2,
    maxNativeZoom: maxZ,
    keepBuffer: 1,
    updateWhenZooming: false,
    updateWhenIdle: true,
    updateInterval: 250,
    attribution: p.attribution || (mode === "amap" ? "© 高德地图" : "© OpenStreetMap"),
  }).addTo(state.map);
  state.mapMarkers = L.layerGroup().addTo(state.map);
  state.mapProviderKey = want;
  state.mapPack = p;
  state._clusterTimer = null;
  state._lastClusterZoom = null;
  state.map.on("zoomend moveend", () => {
    clearTimeout(state._clusterTimer);
    state._clusterTimer = setTimeout(() => {
      refreshMapClusters().catch(console.error);
    }, 120);
  });
  return state.map;
}

function fitMapToBounds(bounds, scope) {
  const map = state.map;
  if (!map) return;
  const cap = mapZoomCap(state.mapPack);
  if (!bounds) {
    if (scope === "world") map.setView([20, 10], 2);
    else map.setView([35.2, 105.0], 4);
    return;
  }
  const llb = L.latLngBounds(
    [bounds.south, bounds.west],
    [bounds.north, bounds.east]
  );
  if (!llb.isValid()) return;
  const span = Math.max(
    Math.abs(bounds.north - bounds.south),
    Math.abs(bounds.east - bounds.west)
  );
  let maxZoom = Math.min(cap, 14);
  if (scope === "world" || span > 25) maxZoom = 5;
  else if (span > 8) maxZoom = 7;
  else if (span > 2) maxZoom = 9;
  else if (span > 0.5) maxZoom = Math.min(cap, 12);
  else maxZoom = Math.min(cap, 14);
  map.fitBounds(llb.pad(0.35), { maxZoom, animate: false });
}

function fitMapToPoints(points, scope) {
  if (!points?.length) {
    fitMapToBounds(null, scope);
    return;
  }
  const bounds = {
    south: Math.min(...points.map((p) => p.lat)),
    north: Math.max(...points.map((p) => p.lat)),
    west: Math.min(...points.map((p) => p.lng)),
    east: Math.max(...points.map((p) => p.lng)),
  };
  fitMapToBounds(bounds, scope);
}

/** 按当前缩放网格聚点（小数据兜底） */
function clusterPhotosByZoom(points, zoom) {
  const cell = Math.max(0.02, 360 / Math.pow(2, zoom + 2));
  const buckets = new Map();
  points.forEach((p) => {
    const gy = Math.round(p.lat / cell);
    const gx = Math.round(p.lng / cell);
    const key = `${gy}:${gx}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        photos: [],
        latSum: 0,
        lngSum: 0,
        gy,
        gx,
        cell,
      });
    }
    const b = buckets.get(key);
    b.photos.push(p);
    b.latSum += p.lat;
    b.lngSum += p.lng;
  });
  return Array.from(buckets.values()).map((b) => {
    const photos = b.photos.slice().sort((a, c) => {
      const da = (a.meta && a.meta.datetime) || "";
      const db = (c.meta && c.meta.datetime) || "";
      return db.localeCompare(da);
    });
    return {
      lat: b.latSum / b.photos.length,
      lng: b.lngSum / b.photos.length,
      photos,
      cover: photos[0],
      count: photos.length,
      gy: b.gy,
      gx: b.gx,
      cell: b.cell,
    };
  });
}

function placeLabel(cluster) {
  const locs = (cluster.photos || [])
    .map((p) => (p.meta && p.meta.location) || "")
    .filter(Boolean);
  if (locs.length) {
    const freq = {};
    locs.forEach((l) => {
      freq[l] = (freq[l] || 0) + 1;
    });
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  }
  const coverLoc = cluster.cover?.meta?.location;
  if (coverLoc) return coverLoc;
  return `${cluster.lat.toFixed(2)}, ${cluster.lng.toFixed(2)}`;
}

function stackIconHtml(cluster) {
  const cover = cluster.cover;
  if (!cover?.path) {
    return `<div class="places-stack"><div class="places-stack-face"><span class="places-badge">${
      cluster.count > 99 ? "99+" : cluster.count
    }</span></div></div>`;
  }
  const src = `/api/thumb?path=${encodeURIComponent(cover.path)}&size=160&_=${state.thumbBust || 0}`;
  const n = cluster.count;
  const stack =
    n > 1
      ? `<span class="places-stack-back" aria-hidden="true"></span><span class="places-stack-mid" aria-hidden="true"></span>`
      : "";
  const badge = n > 1 ? `<span class="places-badge">${n > 99 ? "99+" : n}</span>` : "";
  return `<div class="places-stack">${stack}<div class="places-stack-face"><img src="${src}" alt="" />${badge}</div></div>`;
}

function focusMapOnCluster(cluster, zoom = 11) {
  const map = state.map;
  if (!map || !cluster) return;
  const z = Math.min(mapZoomCap(state.mapPack), Math.max(zoom, 10));
  const run = () => {
    map.invalidateSize(true);
    map.setView([cluster.lat, cluster.lng], z, { animate: true });
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      run();
      setTimeout(() => map.invalidateSize(true), 120);
      setTimeout(() => map.invalidateSize(true), 320);
    });
  });
}

async function openMapExpand(cluster) {
  const panel = $("#map-expand");
  const grid = $("#map-expand-grid");
  $("#map-expand-title").textContent = placeLabel(cluster);
  $("#map-expand-sub").textContent = `${cluster.count} 张 · 点击照片打开`;
  grid.innerHTML = `<p class="muted">加载中…</p>`;
  panel.classList.remove("hidden");
  $("#map-root").classList.add("map-expand-open");
  focusMapOnCluster(cluster, 12);

  let photos = cluster.photos;
  if ((!photos || !photos.length) && cluster.gy != null && cluster.gx != null) {
    const cell = cluster.cell || 0.05;
    const data = await api(
      `/api/map/cluster?gy=${cluster.gy}&gx=${cluster.gx}&cell=${cell}&limit=200&offset=0`
    );
    photos = data.photos || [];
    cluster.photos = photos;
  }
  photos = photos || [];
  grid.innerHTML = "";
  if (!photos.length) {
    grid.innerHTML = `<p class="muted">该位置暂无照片</p>`;
    return;
  }
  photos.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-expand-item";
    const t = (p.meta && p.meta.title) || p.name;
    btn.innerHTML = `<img class="js-thumb" loading="lazy" decoding="async" data-src="/api/thumb?path=${encodeURIComponent(
      p.path
    )}&size=${albumThumbSize()}&_=${state.thumbBust || 0}" alt="" /><span>${escapeAttr(t)}</span>`;
    btn.addEventListener("click", () =>
      openLightbox(
        p.path,
        photos.map((x) => x.path),
        p.meta || null
      )
    );
    grid.appendChild(btn);
  });
  bindAlbumThumbLazy(grid);
}

function closeMapExpand() {
  $("#map-expand")?.classList.add("hidden");
  $("#map-root")?.classList.remove("map-expand-open");
  setTimeout(() => {
    if (!state.map) return;
    state.map.invalidateSize(true);
  }, 80);
}

$("#map-expand-close")?.addEventListener("click", closeMapExpand);

async function paintMapClusters(clusters) {
  await ensureMap();
  state.mapClusters = clusters;
  state.mapMarkers.clearLayers();
  clusters.forEach((c) => {
    if (!c.cover?.path && c.count > 0) {
      /* 无封面仍显示数量角标 */
    }
    const icon = L.divIcon({
      className: "places-marker",
      html: stackIconHtml(c),
      iconSize: [56, 64],
      iconAnchor: [28, 64],
    });
    const marker = L.marker([c.lat, c.lng], { icon, riseOnHover: true });
    marker.on("click", () => {
      if (c.count === 1 && c.cover?.path) {
        openLightbox(c.cover.path, [c.cover.path], c.cover.meta || null);
        focusMapOnCluster(c, 12);
        return;
      }
      openMapExpand(c).catch((e) => {
        $("#map-status").textContent = e.message || String(e);
      });
    });
    state.mapMarkers.addLayer(marker);
  });
}

function renderMapClusters(points) {
  const zoom = state.map?.getZoom() || 4;
  paintMapClusters(clusterPhotosByZoom(points || [], zoom)).catch(console.error);
}

async function refreshMapClusters() {
  if (!state.map) return;
  const z = state.map.getZoom();
  const b = state.map.getBounds();
  const q =
    `zoom=${encodeURIComponent(z)}` +
    `&west=${b.getWest()}&south=${b.getSouth()}` +
    `&east=${b.getEast()}&north=${b.getNorth()}&limit=800` +
    (mediaKindQuery() ? `&kind=${encodeURIComponent(mediaKindQuery())}` : "");
  const data = await api(`/api/map/clusters?${q}`);
  state._lastClusterZoom = z;
  await paintMapClusters(data.clusters || []);
}

async function loadMap(force = false) {
  $("#map-status").textContent = "加载地图…";
  closeMapExpand();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!state.mapSummary || force) {
    state.mapSummary = await api("/api/map/summary");
  }
  let pack = state.mapPack;
  if (!pack || force) {
    pack = await api("/api/map/pack").catch(() => ({ ready: false }));
    state.mapPack = pack;
  }
  try {
    await ensureMap(pack);
  } catch (e) {
    $("#map-status").textContent = e.message;
    return;
  }
  const refreshSize = () => {
    if (!state.map) return;
    state.map.invalidateSize(true);
  };
  refreshSize();
  setTimeout(refreshSize, 80);
  setTimeout(refreshSize, 250);

  const summary = state.mapSummary || {};
  const scope = summary.scope || (summary.has_foreign ? "world" : "china");
  if (force || state._mapFitted !== summary.points) {
    fitMapToBounds(summary.bounds, scope);
    state._mapFitted = summary.points;
  }
  await refreshMapClusters();
  refreshSize();
  const n = summary.points || 0;
  const skip = summary.skipped || 0;
  const viewTip = summary.has_foreign ? "含境外 · 世界视野" : "国内 · 自动聚焦";
  const packTip =
    pack.provider_mode === "amap"
      ? "高德在线"
      : pack.ready
        ? "离线标准地图"
        : "地图包缺失";
  $("#map-status").textContent = n
    ? `${packTip} · ${viewTip} · ${n} 张有坐标${skip ? `（${skip} 张无地点）` : ""}`
    : skip
      ? `暂无坐标点（${skip} 张缺地点或 GPS）`
      : "暂无照片";
}

/** 地点/元数据变更后清缓存；若正在看地图则立即重载 */
function invalidateMapData() {
  state.mapPoints = null;
  state.mapSummary = null;
  state._lastClusterZoom = null;
  state._mapFitted = null;
  if (state.viewMode === "map") {
    return loadMap(true).catch((e) => {
      $("#map-status").textContent = e.message || String(e);
    });
  }
  return Promise.resolve();
}

/* Import */
const importPreviewLoader = {
  max: 2,
  active: 0,
  queue: [],
  paused: false,
  enqueue(img) {
    this.queue.push(img);
    this.pump();
  },
  pause() {
    this.paused = true;
  },
  resume() {
    this.paused = false;
    this.pump();
  },
  pump() {
    while (!this.paused && this.active < this.max && this.queue.length) {
      const img = this.queue.shift();
      if (!img || !img.isConnected) continue;
      const src = img.dataset.src;
      if (!src || img.dataset.loaded === "1") continue;
      this.active += 1;
      img.dataset.loading = "1";
      const tryLoad = (attempt) => {
        const url = attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}r=${attempt}` : src;
        img.onload = () => {
          img.dataset.loaded = "1";
          img.dataset.loading = "";
          img.classList.add("is-ready");
          this.active = Math.max(0, this.active - 1);
          this.pump();
        };
        img.onerror = () => {
          if (attempt < 1) {
            tryLoad(attempt + 1);
            return;
          }
          img.dataset.loading = "";
          img.classList.add("is-broken");
          img.removeAttribute("src");
          img.alt = "预览失败";
          this.active = Math.max(0, this.active - 1);
          this.pump();
        };
        img.src = url;
      };
      tryLoad(0);
    }
  },
  reset() {
    this.queue = [];
    this.active = 0;
    this.paused = false;
  },
};

/** 全局缩略图并发队列：经典 / 时光 / 地图共用，避免打满树莓派 */
const albumThumbLoader = {
  max: 4,
  active: 0,
  queue: [],
  enqueue(img) {
    this.queue.push(img);
    this.pump();
  },
  pump() {
    while (this.active < this.max && this.queue.length) {
      const img = this.queue.shift();
      if (!img || !img.isConnected) continue;
      const src = img.dataset.src;
      if (!src || img.dataset.loaded === "1") continue;
      this.active += 1;
      img.onload = () => {
        img.dataset.loaded = "1";
        img.classList.add("is-ready");
        this.active = Math.max(0, this.active - 1);
        this.pump();
      };
      img.onerror = () => {
        img.classList.add("is-broken");
        this.active = Math.max(0, this.active - 1);
        this.pump();
      };
      img.src = src;
    }
  },
};

function albumThumbIO() {
  if (state._albumThumbIO) return state._albumThumbIO;
  state._albumThumbIO = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        state._albumThumbIO.unobserve(entry.target);
        albumThumbLoader.enqueue(entry.target);
      }
    },
    { root: null, rootMargin: "280px 0px", threshold: 0 }
  );
  return state._albumThumbIO;
}

function enqueueVisibleThumbs(list) {
  const h = window.innerHeight || 800;
  list.forEach((img) => {
    if (!img?.isConnected || img.dataset.loaded === "1" || img.dataset.loading === "1") return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.bottom >= -280 && rect.top <= h + 280) albumThumbLoader.enqueue(img);
  });
}

function bindAlbumThumbLazy(imgsOrRoot) {
  const list = Array.isArray(imgsOrRoot)
    ? imgsOrRoot.filter(Boolean)
    : [...(imgsOrRoot?.querySelectorAll?.("img[data-src].js-thumb") || [])];
  if (!list.length) return;
  if (!("IntersectionObserver" in window)) {
    list.forEach((img) => albumThumbLoader.enqueue(img));
    return;
  }
  const io = albumThumbIO();
  list.forEach((img) => io.observe(img));
  // Chrome：局部 IO 易被回收；切到经典模式时首屏也可能还没 layout 完
  requestAnimationFrame(() => enqueueVisibleThumbs(list));
  setTimeout(() => enqueueVisibleThumbs(list), 120);
}

/** @deprecated 兼容旧名 */
const classicThumbLoader = albumThumbLoader;
function bindClassicThumbLazy(imgs) {
  bindAlbumThumbLazy(imgs);
}

function bindImportPreviewLazy(list) {
  const imgs = [...list.querySelectorAll("img.import-preview[data-src]")];
  if (!imgs.length) return;
  if (!("IntersectionObserver" in window)) {
    imgs.forEach((img) => importPreviewLoader.enqueue(img));
    return;
  }
  if (!state._importThumbIO) {
    state._importThumbIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state._importThumbIO.unobserve(entry.target);
          importPreviewLoader.enqueue(entry.target);
        }
      },
      { root: null, rootMargin: "280px 0px", threshold: 0 }
    );
  }
  imgs.forEach((img) => state._importThumbIO.observe(img));
  requestAnimationFrame(() => {
    const h = window.innerHeight || 800;
    imgs.forEach((img) => {
      if (!img.isConnected || img.dataset.loaded === "1") return;
      const rect = img.getBoundingClientRect();
      if (rect.bottom >= -40 && rect.top <= h + 280) importPreviewLoader.enqueue(img);
    });
  });
}

/** 批量编辑时列表可能被卸下 DOM，统一从这里取根节点 */
function importListRoot() {
  return state._detachedImportList || ensureImportListEl();
}

function ensureImportExtraFields(row) {
  if (!row || row.querySelector(".f-description")) return;
  const fields = row.querySelector(".import-fields");
  if (!fields || row.dataset.liveCompanion === "1") return;
  const desc = row.dataset.description || "";
  const loc = row.dataset.location || "";
  const extra = document.createElement("div");
  extra.className = "import-extra-fields";
  extra.innerHTML = `
    <label>描述 <input type="text" class="f-description" value="${escapeAttr(desc)}" /></label>
    <label>地点 <input type="text" class="f-location" value="${escapeAttr(loc)}" /></label>`;
  fields.appendChild(extra);
}

function setImportRowField(row, key, value) {
  if (!row) return;
  const text = value == null ? "" : String(value);
  if (key === "datetime") {
    const el = row.querySelector(".f-datetime");
    if (el) el.value = text;
    row.dataset.datetime = text;
    return;
  }
  if (key === "title") {
    const el = row.querySelector(".f-title");
    if (el) el.value = text;
    row.dataset.title = text;
    return;
  }
  if (key === "description" || key === "location") {
    row.dataset[key] = text;
    ensureImportExtraFields(row);
    const el = row.querySelector(key === "description" ? ".f-description" : ".f-location");
    if (el) el.value = text;
  }
}

function wireImportRow(row, list) {
  const pick = row.querySelector(".pick");
  pick?.addEventListener("change", () => {
    if (pick.checked) ensureImportExtraFields(row);
    const all = $("#check-all");
    const root = list || importListRoot();
    if (all && root) {
      const picks = [...root.querySelectorAll(".import-item .pick:not(:disabled)")];
      all.checked = picks.length > 0 && picks.every((x) => x.checked);
    }
    updateImportSelectionCount();
  });
  // 缩略图点击：预览大图 / 播放视频（不再用来勾选）
  row.querySelector(".import-thumb")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (row.dataset.liveCompanion === "1") return;
    openImportMediaPreview(
      row.dataset.path,
      row.dataset.kind || "image",
      row.querySelector(".import-file-name")?.textContent || "",
      row
    );
  });
  row.querySelectorAll(".dup-jump-thumb").forEach((img) => {
    img.addEventListener("error", () => {
      img.hidden = true;
    });
  });
  row.querySelector(".dup-badge")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const toggle = e.currentTarget;
    const panel = row.querySelector(".dup-where");
    if (!panel) return;
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    panel.classList.toggle("hidden", !open);
    if (open) {
      panel.querySelectorAll("img[data-src]").forEach((img) => {
        if (!img.getAttribute("src")) img.src = img.dataset.src || "";
      });
    }
  });
  row.querySelectorAll(".dup-jump").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const path = btn.dataset.dupPath || "";
      if (!path) return;
      if (btn.dataset.dupKind === "album") {
        openLightbox(path, [path]);
        return;
      }
      const target = importListRoot()?.querySelector(
        `.import-item[data-path="${CSS.escape(path)}"]`
      );
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("dup-flash");
      setTimeout(() => target.classList.remove("dup-flash"), 1600);
    });
  });
}

function rememberImportPreviewSpot(row) {
  const list = importListRoot();
  state._importPreviewRestore = {
    path: row?.dataset?.path || "",
    row,
    thumb: row?.querySelector(".import-preview-btn") || row?.querySelector(".import-thumb"),
    y: window.scrollY,
    listTop: list && list.scrollHeight > list.clientHeight ? list.scrollTop : null,
  };
}

function restoreImportPreviewSpot() {
  const r = state._importPreviewRestore;
  if (!r) return;
  const apply = () => {
    if (r.listTop != null) {
      const list = importListRoot();
      if (list) list.scrollTop = r.listTop;
    }
    window.scrollTo(0, r.y);
    const row =
      (r.row && r.row.isConnected && r.row) ||
      (r.path && importListRoot()?.querySelector(`.import-item[data-path="${CSS.escape(r.path)}"]`));
    const el = row?.querySelector(".import-preview-btn") || row?.querySelector(".import-thumb") || r.thumb;
    if (el?.focus) el.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    setTimeout(apply, 0);
  });
}

async function openImportMediaPreview(path, kind, name, row = null) {
  if (!path) return;
  rememberImportPreviewSpot(
    row || importListRoot()?.querySelector(`.import-item[data-path="${CSS.escape(path)}"]`)
  );
  const opener = state._importPreviewRestore?.thumb;
  if (opener?.focus) opener.focus({ preventScroll: true });
  let dlg = $("#import-media-dlg");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "import-media-dlg";
    dlg.className = "import-media-dlg";
    dlg.innerHTML = `
      <div class="import-media-head">
        <strong id="import-media-title">预览</strong>
        <button type="button" class="import-media-close" id="import-media-close" aria-label="关闭">关闭</button>
      </div>
      <div class="import-media-body" id="import-media-body"></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#import-media-close")?.addEventListener("click", () => closeImportMediaPreview());
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) closeImportMediaPreview();
    });
    dlg.addEventListener("close", () => {
      const body = $("#import-media-body");
      if (body) body.innerHTML = "";
      restoreImportPreviewSpot();
    });
  }
  const title = $("#import-media-title");
  const body = $("#import-media-body");
  if (title) title.textContent = name || path.split("/").pop() || "预览";
  if (!body) return;
  body.innerHTML = "";
  const isVid = kind === "video" || isVideoName(path);
  if (isVid) {
    const tip = document.createElement("p");
    tip.className = "import-media-tip";
    tip.textContent = "正在准备播放…";
    body.appendChild(tip);
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    body.appendChild(video);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "open");
    const ok = await bindLightboxVideo(video, path, "import");
    tip.remove();
    if (!ok) {
      const err = document.createElement("p");
      err.className = "import-media-tip";
      err.textContent = "无法播放该视频（格式不兼容、损坏或未传完）";
      body.appendChild(err);
    } else {
      video.play?.().catch(() => {});
    }
    return;
  }
  const img = document.createElement("img");
  img.alt = name || "";
  const importPreview = (size) =>
    `/api/preview?source=import&path=${encodeURIComponent(path)}&size=${size}`;
  img.src = importPreview(lightboxPreviewSize());
  img.onerror = () => {
    img.onerror = () => {
      img.alt = "这张图暂时打不开";
    };
    img.src = importPreview(640);
  };
  body.appendChild(img);
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "open");
}

function closeImportMediaPreview() {
  const dlg = $("#import-media-dlg");
  if (!dlg) return;
  const video = dlg.querySelector("video");
  if (video) {
    try {
      video.pause();
    } catch (_) {}
  }
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
  const body = $("#import-media-body");
  if (body) body.innerHTML = "";
}

function formatDupLocation(rel, kind) {
  const norm = String(rel || "").replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  const file = parts.length ? parts[parts.length - 1] : norm;
  const folders = parts.slice(0, -1);
  const stem = file.replace(/\.[^.]+$/, "");
  let when = "";
  let title = "";
  const named = stem.match(/^(\d{4}-\d{2}-\d{2})-(\d{6})-(.+)-([0-9a-f]{8})(?:-\d+)?$/i);
  if (named) {
    const t = named[2];
    when = `${named[1]} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
    title = named[3];
  } else {
    const dated = stem.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (dated) {
      when = dated[1];
      title = dated[2].replace(/-\d+$/, "");
    }
  }
  const place = folders.join(" / ");
  if (kind !== "album") {
    return {
      path: norm,
      file,
      headline: place ? `待入库 · ${place}` : "待入库列表",
    };
  }
  const headline = [place, when, title].filter(Boolean).join(" · ") || file;
  return { path: norm, file, headline };
}

function dupJumpButton(kind, rel) {
  const loc = formatDupLocation(rel, kind);
  const thumb =
    kind === "album"
      ? `<img class="dup-jump-thumb" alt="" data-src="/api/preview?source=album&path=${encodeURIComponent(loc.path)}&size=120" />`
      : "";
  const action = kind === "album" ? "在相册中打开" : "定位到这项";
  return `<button type="button" class="dup-jump" data-dup-kind="${kind}" data-dup-path="${escapeAttr(loc.path)}">
    ${thumb}
    <span class="dup-jump-text">
      <strong>${escapeHtml(loc.headline)}</strong>
      <em>${escapeHtml(loc.file)}</em>
      <span class="dup-jump-action">${action}</span>
    </span>
  </button>`;
}

function renderDupBlock(it) {
  const album = Array.isArray(it.duplicate_of) ? it.duplicate_of.filter(Boolean) : [];
  const inbox = Array.isArray(it.inbox_duplicate_of) ? it.inbox_duplicate_of.filter(Boolean) : [];
  if (it.duplicate) {
    const n = album.length;
    const label = n > 1 ? `相册已有相同内容（${n} 处）` : "相册已有相同内容";
    const albumHtml = n
      ? album.map((p) => dupJumpButton("album", p)).join("")
      : `<p class="dup-where-title">已标记为重复，但没读到相册路径。点「重新解析」后再看。</p>`;
    const inboxHtml = inbox.length
      ? `<p class="dup-where-title">待入库里还有</p>${inbox.map((p) => dupJumpButton("inbox", p)).join("")}`
      : "";
    return `<button type="button" class="dup-badge" aria-expanded="false">${escapeHtml(label)}<span class="dup-caret"></span></button>
      <div class="dup-where hidden">
        <p class="dup-where-title">相同内容在相册中的位置</p>
        ${albumHtml}
        ${inboxHtml}
      </div>`;
  }
  if (it.inbox_duplicate) {
    const n = inbox.length;
    const label = n > 1 ? `待入库内重复（${n} 处）` : "待入库内重复";
    const body = n
      ? inbox.map((p) => dupJumpButton("inbox", p)).join("")
      : `<p class="dup-where-title">已标记为重复，但没读到另一项的位置。</p>`;
    return `<button type="button" class="dup-badge inbox" aria-expanded="false">${escapeHtml(label)}<span class="dup-caret"></span></button>
      <div class="dup-where hidden">
        <p class="dup-where-title">待入库里的相同项</p>
        ${body}
      </div>`;
  }
  return "";
}

function buildImportRow(it) {
  const row = document.createElement("div");
  row.className = "import-item";
  row.dataset.path = it.path;
  if (it.live_companion) row.dataset.liveCompanion = "1";
  if (it.content_hash) row.dataset.contentHash = it.content_hash;
  if (it.duplicate) row.dataset.duplicate = "1";
  if (it.inbox_duplicate) row.dataset.inboxDuplicate = "1";
  if (it.duplicate || it.inbox_duplicate) row.classList.add("is-duplicate");
  const meta = it.meta || {};
  row.dataset.datetime = toLocalInput(meta.datetime);
  row.dataset.title = meta.title || "";
  row.dataset.description = meta.description || "";
  row.dataset.location = meta.location || "";
  const kind = it.kind || (isVideoName(it.name) ? "video" : "image");
  row.dataset.kind = kind;
  const heic = isHeicName(it.name || it.path);
  let preview;
  if (it.live_companion) {
    preview = `<div class="import-thumb import-video-ph" title="实况伴生视频">Live</div>`;
  } else if (kind === "video" && isMobileClient()) {
    preview = `<button type="button" class="import-thumb import-video-ph import-preview-btn" title="点击播放">▶</button>`;
  } else {
    const src = `/api/preview?source=import&path=${encodeURIComponent(it.path)}&size=${isMobileClient() ? 120 : 160}`;
    const badge = kind === "video" ? `<span class="import-thumb-play" aria-hidden="true">▶</span>` : "";
    const tip = kind === "video" ? "点击播放" : "点击看大图";
    preview = `<button type="button" class="import-thumb import-preview-btn" title="${tip}">
      <img class="import-preview" loading="lazy" decoding="async" data-src="${src}" alt="" />
      ${badge}
    </button>`;
  }
  const kindBadge = it.live_companion
    ? `<span class="live-badge">实况伴生 · 随同名 HEIC 入库</span>`
    : heic
      ? `<span class="live-badge heic">HEIC 原件</span>`
      : kind === "video"
        ? `<span class="live-badge">视频</span>`
        : "";
  const dupBlock = renderDupBlock(it);
  const outcome = state.importOutcomes?.get(it.path);
  const failBadge =
    outcome && outcome.ok === false
      ? `<span class="import-fail-badge">入库失败</span>`
      : "";
  const failMsg =
    outcome && outcome.ok === false && outcome.message
      ? `<p class="import-fail-msg">${escapeHtml(outcome.message)}</p>`
      : "";
  if (outcome && outcome.ok === false) row.classList.add("is-ingest-fail");
  const badges =
    kindBadge || dupBlock || failBadge
      ? `<div class="import-badges">${kindBadge}${dupBlock}${failBadge}</div>`
      : "";
  const liveDis = it.live_companion ? "disabled" : "";
  row.innerHTML = `
    <label class="import-pick" title="选中入库">
      <input type="checkbox" class="pick" ${liveDis} />
    </label>
    ${preview}
    <div class="import-fields">
      <div class="import-file-name" title="${escapeAttr(it.name)}">${escapeAttr(it.name)}</div>
      ${badges}
      ${failMsg}
      <label>时间 <input type="datetime-local" class="f-datetime" value="${escapeAttr(row.dataset.datetime)}" ${liveDis} /></label>
      <label>简述 <input type="text" class="f-title" maxlength="30" value="${escapeAttr(row.dataset.title)}" ${liveDis} /></label>
    </div>`;
  return row;
}

/** 确保 #import-list 在 DOM 中（批量编辑曾会卸下列表，导致后续按钮全挂） */
function ensureImportListEl() {
  let list = document.getElementById("import-list");
  if (list && list.isConnected) return list;

  // 优先把卸下的列表挂回去
  const ph = document.getElementById("import-list-ph");
  if (state._detachedImportList) {
    const node = state._detachedImportList;
    state._detachedImportList = null;
    state._importListParent = null;
    document.body.classList.remove("is-batch-open");
    if (ph && ph.parentNode) {
      ph.replaceWith(node);
      return node;
    }
    // 占位符已丢：插回进度条后面
    const progress = document.getElementById("ingest-progress");
    if (progress?.parentNode) {
      progress.after(node);
      return node;
    }
  }

  // 仅剩占位符：换成空列表
  if (ph && ph.parentNode) {
    list = document.createElement("div");
    list.id = "import-list";
    list.className = "import-list";
    ph.replaceWith(list);
    document.body.classList.remove("is-batch-open");
    return list;
  }

  // 最后兜底：在入库面板末尾重建
  const pane = document.getElementById("manage-import");
  list = document.createElement("div");
  list.id = "import-list";
  list.className = "import-list";
  if (pane) pane.appendChild(list);
  document.body.classList.remove("is-batch-open");
  return list;
}

function renderImportItems(items) {
  document.body.classList.remove("is-batch-open");
  const list = ensureImportListEl();
  const empty = $("#import-empty");
  importPreviewLoader.reset();
  if (!list) return;
  // 已不在待入库的路径，清掉旧结果，避免 Map 无限涨
  const alive = new Set((items || []).map((it) => it.path));
  if (state.importOutcomes?.size) {
    for (const path of [...state.importOutcomes.keys()]) {
      if (!alive.has(path)) state.importOutcomes.delete(path);
    }
  }
  list.innerHTML = "";
  state.importItemCount = items.length;
  const countEl = $("#import-count");
  const failN = [...(state.importOutcomes?.values() || [])].filter((x) => x && x.ok === false).length;
  if (countEl) {
    countEl.textContent = items.length
      ? `共 ${items.length} 项${failN ? ` · 失败 ${failN}` : ""}`
      : "";
  }
  if (!items.length) {
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");

  const frag = document.createDocumentFragment();
  const rows = [];
  for (const it of items) {
    const row = buildImportRow(it);
    rows.push(row);
    frag.appendChild(row);
  }
  list.appendChild(frag);
  for (const row of rows) wireImportRow(row, list);
  const all = $("#check-all");
  if (all) all.checked = false;
  updateImportSelectionCount();
  bindImportPreviewLazy(list);
}


function collectIngestItems() {
  const items = [];
  const root = importListRoot();
  if (!root) return items;
  root.querySelectorAll(".import-item").forEach((row) => {
    const pick = row.querySelector(".pick");
    if (!pick || !pick.checked || pick.disabled) return;
    if (row.dataset.liveCompanion === "1") return;
    items.push({
      path: row.dataset.path,
      name: row.querySelector(".import-file-name")?.textContent || row.dataset.path,
      datetime: fromLocalInput(row.querySelector(".f-datetime")?.value || row.dataset.datetime || ""),
      title: row.querySelector(".f-title")?.value || row.dataset.title || "",
      description: row.querySelector(".f-description")?.value || row.dataset.description || "",
      location: row.querySelector(".f-location")?.value || row.dataset.location || "",
      content_hash: row.dataset.contentHash || null,
      row,
    });
  });
  return items;
}

function updateImportSelectionCount() {
  const el = $("#import-count");
  if (!el) return;
  const root = importListRoot();
  const total = state.importItemCount || root?.querySelectorAll(".import-item").length || 0;
  const selected = collectIngestItems().length;
  const dupN = root?.querySelectorAll(".import-item.is-duplicate").length || 0;
  if (!total) {
    el.textContent = "";
    return;
  }
  el.textContent =
    `已选 ${selected} / 共 ${total} 项（仅勾选项会入库）` +
    (dupN ? ` · 重复 ${dupN}` : "");
}

const ingestState = {
  running: false,
  cancel: false,
  startedAt: 0,
};
const parseState = { running: false };
const importListState = { loading: false };

function setDropStatus(text, kind = "") {
  const el = $("#drop-status");
  if (el) {
    el.textContent = text || "";
    el.classList.remove("is-busy", "is-ok", "is-warn", "is-error");
    if (kind) el.classList.add(`is-${kind}`);
  }
  const bar = $("#import-status");
  if (!bar) return;
  const msg = (text || "").trim();
  if (!msg) {
    bar.hidden = true;
    bar.textContent = "";
    bar.classList.remove("is-busy", "is-ok", "is-warn", "is-error");
    return;
  }
  bar.hidden = false;
  bar.textContent = msg;
  bar.classList.remove("is-busy", "is-ok", "is-warn", "is-error");
  if (kind) bar.classList.add(`is-${kind}`);
}

function setIngestProgress({ show, title, summary, detail, percent, tone }) {
  const box = $("#ingest-progress");
  const bar = $("#ingest-progress-bar");
  if (!box) return;
  box.classList.remove("is-done-ok", "is-done-fail");
  if (tone === "ok") box.classList.add("is-done-ok");
  if (tone === "fail") box.classList.add("is-done-fail");
  box.classList.toggle("hidden", !show);
  if (title != null && $("#ingest-progress-title")) $("#ingest-progress-title").textContent = title;
  if (summary != null && $("#ingest-progress-summary")) $("#ingest-progress-summary").textContent = summary;
  if (detail != null && $("#ingest-progress-detail")) $("#ingest-progress-detail").textContent = detail;
  if (bar && percent != null) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

/** 进入入库页 / 异常恢复：关掉卡住的弹层，恢复列表与按钮 */
function resetImportUiState() {
  try {
    const batch = $("#batch-dialog");
    if (batch?.open) batch.close();
  } catch (_) {}
  try {
    closeImportMediaPreview();
  } catch (_) {}
  // 强制恢复被卸下的列表（即使 state 丢了也要清掉占位符）
  ensureImportListEl();
  document.body.classList.remove("is-batch-open");
  importPreviewLoader.resume?.();
  if (ingestState.running) {
    const stuckMs = Date.now() - (ingestState.startedAt || 0);
    if (stuckMs > 180000 || !ingestState.startedAt) {
      ingestState.running = false;
      ingestState.cancel = false;
      ingestState.startedAt = 0;
    }
  }
  const btn = $("#btn-ingest");
  const btnCancel = $("#btn-ingest-cancel");
  if (!ingestState.running) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "入库选中项";
    }
    if (btnCancel) btnCancel.classList.add("hidden");
  }
}

async function loadImport({ quiet = false } = {}) {
  ensureImportListEl();
  const empty = $("#import-empty");
  const list = ensureImportListEl();
  const btn = $("#btn-reload-import");
  if (importListState.loading) {
    if (!quiet) setDropStatus("正在刷新待入库列表…", "busy");
    return;
  }
  importListState.loading = true;
  if (btn) btn.disabled = true;
  if (!quiet) setDropStatus("正在刷新待入库列表…", "busy");
  if (list && !list.children.length) {
    if (empty) {
      empty.classList.remove("hidden");
      empty.textContent = "正在读取待入库列表…";
    }
  }
  try {
    const data = await api("/api/import/list");
    if (empty) empty.textContent = "暂无待入库媒体，先拖入或选择文件。";
    const items = data.items || [];
    renderImportItems(items);
    const failN = [...(state.importOutcomes?.values() || [])].filter((x) => x && x.ok === false).length;
    if (!quiet) {
      setDropStatus(
        items.length
          ? `列表已刷新：共 ${items.length} 项${failN ? `，其中入库失败 ${failN} 项仍保留` : ""}`
          : "列表已刷新：暂无待入库媒体",
        failN ? "warn" : "ok"
      );
    }
  } catch (err) {
    if (!quiet) setDropStatus(err?.message || String(err), "error");
    throw err;
  } finally {
    importListState.loading = false;
    if (btn) btn.disabled = false;
  }
}

function selectSameDayImport() {
  const root = importListRoot();
  const rows = [...(root?.querySelectorAll(".import-item") || [])];
  const checked = rows.filter((r) => r.querySelector(".pick")?.checked);
  if (!checked.length) {
    alert("请先勾选一张作为「同日」参考");
    return;
  }
  const ref = (checked[0].querySelector(".f-datetime")?.value || "").slice(0, 10);
  if (!ref) {
    alert("参考项没有日期，请先填写时间或换一张");
    return;
  }
  rows.forEach((row) => {
    const day = (row.querySelector(".f-datetime")?.value || "").slice(0, 10);
    const pick = row.querySelector(".pick");
    if (!pick || pick.disabled) return;
    pick.checked = day === ref;
    if (pick.checked) ensureImportExtraFields(row);
  });
  updateImportSelectionCount();
  const n = collectIngestItems().length;
  $("#drop-status").textContent = `已勾选同日 ${ref} 的照片（${n} 项）`;
}

async function parseImportList(opts = {}) {
  const CHUNK = 40;
  const onlyPaths = Array.isArray(opts.paths)
    ? [...new Set(opts.paths.filter(Boolean))]
    : null;
  if (parseState.running) {
    setDropStatus("正在解析中，请稍候…", "busy");
    return;
  }
  parseState.running = true;
  const btnParse = $("#btn-parse");
  if (btnParse) btnParse.disabled = true;
  try {
    setDropStatus("正在解析元数据并比对相册指纹… 0%", "busy");
    // 先拿轻量列表，解析过程中逐步回填，避免长时间无反馈
    const base = await api("/api/import/list").catch(() => ({ items: [] }));
    let merged = Array.isArray(base.items) ? base.items.slice() : [];
    if (onlyPaths) {
      const want = new Set(onlyPaths);
      merged = merged.filter((it) => want.has(it.path));
    }
    const byPath = new Map(merged.map((it) => [it.path, it]));
    renderImportItems(merged);

    let offset = 0;
    let total = onlyPaths ? onlyPaths.length : merged.length || 0;
    let albumN = 0;
    let inboxN = 0;
    let guard = 0;
    let lastProcessed = -1;
    while (guard++ < 500) {
      const body = { offset, limit: CHUNK };
      if (onlyPaths) body.paths = onlyPaths;
      const data = await api("/api/import/parse", {
        method: "POST",
        body: JSON.stringify(body),
      });
      total = Number(data.total || total || 0);
      const chunk = data.items || [];
      for (const it of chunk) {
        if (byPath.has(it.path)) {
          Object.assign(byPath.get(it.path), it);
        } else {
          byPath.set(it.path, it);
          merged.push(it);
        }
      }
      // 分片内的待入库重复只覆盖本片；全部结束后用 content_hash 再统一标一次
      albumN += Number(data.duplicate_album || 0);
      inboxN += Number(data.duplicate_inbox || 0);
      const processed = Number(data.processed || offset + chunk.length);
      const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      setDropStatus(data.message || `正在解析… ${processed}/${total}（${pct}%）`, "busy");
      // 每片回填 UI，让用户看到进度而不是卡住
      renderImportItems(merged);
      // 防死循环：进度不前进则结束
      if (processed <= lastProcessed && !chunk.length) break;
      lastProcessed = processed;
      offset = processed;
      if (data.done || !chunk.length || processed >= total) break;
      await new Promise((r) => requestAnimationFrame(() => r()));
    }

    // 跨分片待入库内重复
    const hashPeers = new Map();
    for (const it of merged) {
      const h = (it.content_hash || "").toLowerCase();
      if (!h) continue;
      if (!hashPeers.has(h)) hashPeers.set(h, []);
      hashPeers.get(h).push(it.path);
    }
    inboxN = 0;
    albumN = 0;
    for (const it of merged) {
      const h = (it.content_hash || "").toLowerCase();
      const peers = h ? (hashPeers.get(h) || []).filter((p) => p !== it.path) : [];
      it.inbox_duplicate = peers.length > 0;
      it.inbox_duplicate_of = peers;
      if (it.duplicate) albumN += 1;
      else if (it.inbox_duplicate) inboxN += 1;
    }
    renderImportItems(merged);
    const msg =
      albumN || inboxN
        ? `解析完成：相册重复 ${albumN} · 待入库内重复 ${inboxN}`
        : "解析完成：未发现重复";
    setDropStatus(msg, albumN || inboxN ? "warn" : "ok");
  } catch (e) {
    setDropStatus(e.message || String(e), "error");
    alert(e.message);
  } finally {
    parseState.running = false;
    if (btnParse) btnParse.disabled = false;
  }
}

async function discardSelectedImport() {
  const paths = selectedImportPaths();
  if (!paths.length) {
    const msg = "请先勾选要移除的项目（仅从待入库删除，不会进相册）";
    if ($("#drop-status")) $("#drop-status").textContent = msg;
    await askConfirm(msg);
    return;
  }
  const ok = await askConfirm(
    `确定从待入库移除 ${paths.length} 项？\n文件会从导入区删除，不会写入相册。`
  );
  if (!ok) return;
  const r = await api("/api/import/discard", {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
  setDropStatus(`已移除 ${r.removed || 0} 项`, "ok");
  await loadImport({ quiet: true });
}

async function clearAllImport() {
  const n = state.importItemCount || importListRoot()?.querySelectorAll(".import-item").length || 0;
  if (!n) {
    const msg = "待入库列表已空";
    if ($("#drop-status")) $("#drop-status").textContent = msg;
    await askConfirm(msg);
    return;
  }
  const ok = await askConfirm(
    `确定清空全部待入库（约 ${n} 项）？\n文件会从导入区删除，不会写入相册。`
  );
  if (!ok) return;
  const r = await api("/api/import/discard", {
    method: "POST",
    body: JSON.stringify({ clear_all: true }),
  });
  state.importOutcomes?.clear();
  setDropStatus(`已清空待入库（移除 ${r.removed || 0} 项）`, "ok");
  await loadImport({ quiet: true });
}

function bindImportToolbarOnce() {
  if (window.__xiaoshuImportToolbarBound) return;
  window.__xiaoshuImportToolbarBound = true;

  const onErr = (err) => {
    console.error(err);
    const msg = err?.message || String(err);
    setDropStatus(msg, "error");
    askConfirm(msg).catch(() => {});
  };

  $("#btn-reload-import")?.addEventListener("click", () => {
    ensureImportListEl();
    loadImport().catch(onErr);
  });
  $("#btn-parse")?.addEventListener("click", () => {
    ensureImportListEl();
    parseImportList().catch(onErr);
  });
  $("#btn-select-same-day")?.addEventListener("click", () => {
    ensureImportListEl();
    selectSameDayImport();
  });
  $("#btn-batch-import")?.addEventListener("click", () => {
    ensureImportListEl();
    const n = collectIngestItems().length;
    if (!n) {
      alert("请先勾选要批量编辑的照片");
      return;
    }
    openBatchDialog("import", n);
  });
  $("#btn-discard-import")?.addEventListener("click", () => {
    ensureImportListEl();
    discardSelectedImport().catch(onErr);
  });
  $("#btn-clear-import")?.addEventListener("click", () => {
    ensureImportListEl();
    clearAllImport().catch(onErr);
  });
  $("#btn-ingest")?.addEventListener("click", () => {
    if ($("#btn-ingest")?.disabled) return;
    ensureImportListEl();
    runIngestSelected().catch(onErr);
  });
  $("#btn-ingest-cancel")?.addEventListener("click", () => {
    if (!ingestState.running) return;
    ingestState.cancel = true;
    $("#drop-status").textContent = "正在停止（完成当前项后结束）…";
    setIngestProgress({
      show: true,
      title: "正在停止…",
      summary: $("#ingest-progress-summary")?.textContent || "",
      detail: "将在当前文件处理完后停止",
      percent: null,
    });
  });

  $("#check-all")?.addEventListener("change", (e) => {
    const root = importListRoot();
    root?.querySelectorAll(".import-item .pick").forEach((c) => {
      if (c.disabled) return;
      c.checked = e.target.checked;
      if (c.checked) ensureImportExtraFields(c.closest(".import-item"));
    });
    updateImportSelectionCount();
  });
}
bindImportToolbarOnce();

/* Batch edit */
function setBatchUiFrozen(on) {
  // 不再把 #import-list 从 DOM 卸下（会导致刷新/解析/勾选等同款全部失效）
  // 仅暂停缩略图队列，减轻弹窗时 CPU
  if (on) {
    importPreviewLoader.pause();
    importPreviewLoader.queue = [];
    document.body.classList.add("is-batch-open");
  } else {
    document.body.classList.remove("is-batch-open");
    // 清理历史占位符（上一版遗留）
    ensureImportListEl();
    importPreviewLoader.resume();
  }
}

function openBatchDialog(target, count) {
  state.batchTarget = target;
  $("#batch-title").textContent = `批量编辑（${count} 张）`;
  $("#batch-hint").textContent =
    target === "import"
      ? "勾选字段后写入导入列表选中项；未勾选的字段保持各图原值。"
      : "勾选字段后写回相册选中项；改时间/简述会重新排布目录。";
  ["datetime", "title", "description", "location"].forEach((k) => {
    $(`#b-apply-${k}`).checked = false;
  });
  $("#b-datetime").value = "";
  $("#b-title").value = "";
  $("#b-description").value = "";
  $("#b-location").value = "";
  setBatchDialogBusy(false);
  setBatchProgress({ show: false, percent: 0, detail: "" });
  if (target === "import") setBatchUiFrozen(true);
  else importPreviewLoader.pause();
  requestAnimationFrame(() => {
    $("#batch-dialog").showModal();
  });
}

function collectBatchFields() {
  const fields = {};
  const flags = {};
  if ($("#b-apply-datetime").checked) {
    flags.apply_datetime = true;
    fields.datetime = fromLocalInput($("#b-datetime").value);
  }
  if ($("#b-apply-title").checked) {
    flags.apply_title = true;
    fields.title = $("#b-title").value;
  }
  if ($("#b-apply-description").checked) {
    flags.apply_description = true;
    fields.description = $("#b-description").value;
  }
  if ($("#b-apply-location").checked) {
    flags.apply_location = true;
    fields.location = $("#b-location").value;
  }
  return { fields, flags };
}

$("#btn-batch-cancel")?.addEventListener("click", () => {
  $("#batch-dialog")?.close();
});

$("#batch-dialog")?.addEventListener("close", () => {
  setBatchUiFrozen(false);
  setBatchDialogBusy(false);
  setBatchProgress({ show: false });
  importPreviewLoader.resume?.();
});

// 点到输入框就自动勾选对应字段，避免还要点左边小勾
[
  ["#b-datetime", "#b-apply-datetime"],
  ["#b-title", "#b-apply-title"],
  ["#b-description", "#b-apply-description"],
  ["#b-location", "#b-apply-location"],
].forEach(([fieldSel, applySel]) => {
  const field = $(fieldSel);
  const apply = $(applySel);
  if (!field || !apply) return;
  const mark = () => {
    if (!apply.checked) apply.checked = true;
  };
  field.addEventListener("focus", mark);
  field.addEventListener("input", mark);
});

function setBatchProgress({ show, title, summary, detail, percent }) {
  const box = $("#batch-progress");
  const bar = $("#batch-progress-bar");
  if (!box) return;
  box.classList.toggle("hidden", !show);
  if (title != null && $("#batch-progress-title")) $("#batch-progress-title").textContent = title;
  if (summary != null && $("#batch-progress-summary")) $("#batch-progress-summary").textContent = summary;
  if (detail != null && $("#batch-progress-detail")) $("#batch-progress-detail").textContent = detail;
  if (bar && percent != null) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setBatchBusy(on) {
  const dlg = $("#batch-dialog");
  const apply = $("#btn-batch-apply");
  const cancel = $("#btn-batch-cancel");
  dlg?.classList.toggle("is-busy", !!on);
  if (apply) {
    apply.disabled = !!on;
    apply.textContent = on ? "处理中…" : "应用到选中";
  }
  if (cancel) cancel.disabled = !!on;
  dlg?.querySelectorAll("input, textarea").forEach((el) => {
    if (el.id === "btn-batch-apply" || el.id === "btn-batch-cancel") return;
    el.disabled = !!on;
  });
}
const setBatchDialogBusy = setBatchBusy;

$("#btn-batch-apply")?.addEventListener("click", async () => {
  const { fields, flags } = collectBatchFields();
  if (!Object.keys(flags).length) {
    alert("请至少勾选一个要修改的字段");
    return;
  }
  if (flags.apply_datetime && !fields.datetime) {
    alert("已勾选时间，请填写统一时间");
    return;
  }
  try {
    if (state.batchTarget === "import") {
      const root = importListRoot();
      let applied = 0;
      root?.querySelectorAll(".import-item").forEach((row) => {
        const pick = row.querySelector(".pick");
        if (!pick?.checked || pick.disabled) return;
        if (flags.apply_datetime && fields.datetime) {
          setImportRowField(row, "datetime", toLocalInput(fields.datetime));
        }
        if (flags.apply_title) setImportRowField(row, "title", fields.title || "");
        if (flags.apply_description) setImportRowField(row, "description", fields.description || "");
        if (flags.apply_location) setImportRowField(row, "location", fields.location || "");
        applied += 1;
      });
      $("#batch-dialog").close();
      alert(`已应用到导入列表 ${applied} 张`);
      return;
    }
    const paths = [...state.selectedPaths];
    if (!paths.length) {
      alert("未选中照片");
      return;
    }
    const needMove = Boolean(flags.apply_datetime || flags.apply_title);
    // 改时间/简述要重排文件，分片小一些以便进度刷新；只改描述/地点可较大批
    const CHUNK = needMove ? 3 : 15;
    setBatchBusy(true);
    setBatchProgress({
      show: true,
      title: needMove ? "正在改写并重排…" : "正在写入元数据…",
      summary: `0 / ${paths.length}`,
      detail: needMove
        ? "改时间/简述会移动文件，稍候…"
        : "正在批量写入，请稍候…",
      percent: 0,
    });
    let okN = 0;
    let failN = 0;
    const failMsgs = [];
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      setBatchProgress({
        show: true,
        title: needMove ? "正在改写并重排…" : "正在写入元数据…",
        summary: `${Math.min(i, paths.length)} / ${paths.length} · 成功 ${okN} · 失败 ${failN}`,
        detail: `本批 ${chunk.length} 项`,
        percent: (i / paths.length) * 100,
      });
      // 让出主线程，刷新进度条
      await new Promise((r) => requestAnimationFrame(() => r()));
      try {
        const r = await api("/api/photo/meta/batch", {
          method: "POST",
          body: JSON.stringify({
            paths: chunk,
            datetime: fields.datetime ?? null,
            title: fields.title ?? null,
            description: fields.description ?? null,
            location: fields.location ?? null,
            ...flags,
          }),
        });
        const results = r.results || [];
        for (const item of results) {
          if (item.ok) okN += 1;
          else {
            failN += 1;
            if (item.message) failMsgs.push(`${item.path || ""}: ${item.message}`);
          }
        }
        if (!results.length) {
          if (r.ok) okN += chunk.length;
          else failN += chunk.length;
        }
        setBatchProgress({
          show: true,
          summary: `${Math.min(i + chunk.length, paths.length)} / ${paths.length} · 成功 ${okN} · 失败 ${failN}`,
          detail: r.message || `本批完成 ${chunk.length} 项`,
          percent: (Math.min(i + chunk.length, paths.length) / paths.length) * 100,
        });
      } catch (chunkErr) {
        failN += chunk.length;
        failMsgs.push(chunkErr.message || String(chunkErr));
        setBatchProgress({
          show: true,
          summary: `${Math.min(i + chunk.length, paths.length)} / ${paths.length} · 成功 ${okN} · 失败 ${failN}`,
          detail: chunkErr.message || "本批失败，继续下一批…",
          percent: (Math.min(i + chunk.length, paths.length) / paths.length) * 100,
        });
      }
    }
    setBatchProgress({
      show: true,
      title: "处理完成",
      summary: `成功 ${okN} · 失败 ${failN} · 合计 ${paths.length}`,
      detail: failMsgs.length ? failMsgs.slice(0, 3).join("；") : "正在刷新相册列表…",
      percent: 100,
    });
    state.selectedPaths.clear();
    setSelectMode(false);
    // 仅改描述/地点时不必强制重扫大纲；改时间/简述后必须刷新
    await loadTree(needMove).catch(console.error);
    if (needMove) await invalidateMapData().catch(() => {});
    $("#batch-dialog").close();
    alert(
      failN
        ? `批量编辑完成：成功 ${okN}，失败 ${failN}`
        : `批量编辑完成：成功 ${okN} 项`
    );
  } catch (e) {
    setBatchProgress({
      show: true,
      title: "处理失败",
      summary: "",
      detail: e.message || String(e),
      percent: null,
    });
    alert(e.message || String(e));
  } finally {
    setBatchBusy(false);
  }
});

function toggleSelectPath(path, card) {
  if (state.selectedPaths.has(path)) {
    state.selectedPaths.delete(path);
    card.classList.remove("selected");
  } else {
    state.selectedPaths.add(path);
    card.classList.add("selected");
  }
  updateSelectUI();
}

function updateSelectUI() {
  syncScopeBars();
}

function setSelectMode(on, scopeKey = null, paths = null) {
  state.selectMode = on;
  state.selectScope = on ? scopeKey : null;
  state.selectPathsSet = on && paths ? new Set(paths) : null;
  document.body.classList.toggle("select-mode", on);
  document.querySelectorAll(".photo-card").forEach((c) => {
    const ok = on && state.selectPathsSet && state.selectPathsSet.has(c.dataset.path);
    c.classList.toggle("selectable", Boolean(ok));
    if (!ok) c.classList.remove("selected");
  });
  if (!on) {
    state.selectedPaths.clear();
  } else {
    state.selectedPaths.clear();
    const el = document.querySelector(`[data-scope-key="${scopeKey}"]`);
    if (el) el.open = true;
  }
  updateSelectUI();
}

const IMAGE_EXT = /\.(jpe?g|jpe|jfif|png|webp|gif|tiff?|bmp|hei[cf]|avif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|mpe|3gp|3g2|mts|m2ts|flv|f4v|wmv|asf|vob|ogv|rm|rmvb)$/i;
const MEDIA_EXT = /\.(jpe?g|jpe|jfif|png|webp|gif|tiff?|bmp|hei[cf]|avif|mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|mpe|3gp|3g2|mts|m2ts|flv|f4v|wmv|asf|vob|ogv|rm|rmvb)$/i;

/** 浏览器可播地址：能本机解码则直出原件，否则走服务端 remux/转码 */
function mediaPlayUrl(path, source = "album") {
  const qs = new URLSearchParams({ path: path || "" });
  if (source && source !== "album") qs.set("source", source);
  const caps = browserVideoCaps();
  if (caps.hevc) qs.set("client_hevc", "1");
  if (caps.h264) qs.set("client_h264", "1");
  if (isMobileClient()) qs.set("max_h", "720");
  if (state.thumbBust) qs.set("v", String(state.thumbBust));
  return `/api/play?${qs.toString()}`;
}

function mediaFileUrl(path, source = "album") {
  const qs = new URLSearchParams({ path: path || "" });
  if (source && source !== "album") qs.set("source", source);
  if (state.thumbBust) qs.set("v", String(state.thumbBust));
  return `/api/file?${qs.toString()}`;
}

let _videoCapsCache = null;
function browserVideoCaps() {
  if (_videoCapsCache) return _videoCapsCache;
  const v = document.createElement("video");
  const hevc = Boolean(
    (v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') || "").replace("no", "") ||
      (v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') || "").replace("no", "")
  );
  const h264 = Boolean(
    (v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || "").replace("no", "")
  );
  const ua = navigator.userAgent || "";
  const apple = /Safari|iPhone|iPad|iPod/i.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome|Android/i.test(ua);
  _videoCapsCache = {
    h264,
    hevc: hevc || apple,
    apple,
  };
  return _videoCapsCache;
}

function preferDirectVideoFile(path) {
  const ext = String(path || "").split(".").pop()?.toLowerCase() || "";
  const caps = browserVideoCaps();
  if (ext === "webm") return Boolean((document.createElement("video").canPlayType("video/webm") || "").replace("no", ""));
  if (ext === "mp4" || ext === "m4v") return caps.h264;
  // MOV 在 Safari/Apple 上常可直出（含 HEVC）；其它浏览器优先走 /api/play
  if (ext === "mov" || ext === "qt") return caps.hevc || caps.apple;
  return false;
}

function setLbVideoPrep(show, title, detail, mode) {
  const box = $("#lb-video-prep");
  if (!box) return;
  box.classList.toggle("hidden", !show);
  if (title != null && $("#lb-video-prep-title")) $("#lb-video-prep-title").textContent = title;
  if (detail != null && $("#lb-video-prep-detail")) $("#lb-video-prep-detail").textContent = detail;
  const modeEl = $("#lb-video-prep-mode");
  if (modeEl && mode) {
    modeEl.className = `lb-video-prep-mode mode-${mode}`;
    modeEl.textContent =
      mode === "client" ? "本机解码" : mode === "server" ? "服务端转码" : mode === "fail" ? "加载失败" : "准备中";
  }
}

function setLbVideoModeChip(mode, text) {
  const chip = $("#lb-video-mode-chip");
  if (!chip) return;
  if (!mode) {
    chip.classList.add("hidden");
    return;
  }
  chip.className = `lb-video-mode-chip mode-${mode}`;
  chip.textContent =
    text ||
    (mode === "client" ? "本机解码" : mode === "server" ? "服务端转码" : mode === "fail" ? "加载失败" : "");
}

function loadVideoSrc(videoEl, url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!videoEl || !url) return resolve(false);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      videoEl.removeEventListener("loadedmetadata", onOk);
      videoEl.removeEventListener("loadeddata", onOk);
      videoEl.removeEventListener("canplay", onOk);
      videoEl.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(videoEl.readyState >= 2), timeoutMs);
    videoEl.addEventListener("loadedmetadata", onOk, { once: true });
    videoEl.addEventListener("loadeddata", onOk, { once: true });
    videoEl.addEventListener("canplay", onOk, { once: true });
    videoEl.addEventListener("error", onErr, { once: true });
    try {
      videoEl.pause();
    } catch (_) {}
    videoEl.src = url;
    videoEl.load();
  });
}

async function bindLightboxVideo(videoEl, path, source = "album") {
  setLbVideoModeChip(null);
  setLbVideoPrep(true, "正在准备视频…", "优先本机直出，必要时服务端转码", "client");
  const direct = mediaFileUrl(path, source);
  const viaServer = mediaPlayUrl(path, source);
  const caps = browserVideoCaps();
  const mobile = isMobileClient();
  let ok = false;
  let mode = "server";
  // 手机非苹果：直出 HEVC/MOV 常要等超时才失败，直接走服务端更快
  const tryDirect = preferDirectVideoFile(path) && (!mobile || caps.apple);
  if (tryDirect) {
    setLbVideoPrep(true, "尝试本机解码…", "优先直出原件，不经树莓派转码", "client");
    ok = await loadVideoSrc(videoEl, direct, mobile ? 1600 : 8000);
    if (ok) mode = "client";
  }
  if (!ok) {
    setLbVideoPrep(true, "服务端处理中…", "本机无法直出时 remux/转码，请稍候", "server");
    try {
      videoEl.preload = "auto";
    } catch (_) {}
    ok = await loadVideoSrc(videoEl, viaServer, 90000);
    mode = ok ? "server" : "fail";
  }
  setLbVideoPrep(false);
  if (ok) {
    setLbVideoModeChip(mode);
    const hint = $("#lb-hint");
    if (hint) {
      hint.textContent =
        mode === "client"
          ? "播放方式：本机浏览器解码（未转码）"
          : "播放方式：服务端 remux/转码";
    }
  } else {
    setLbVideoModeChip("fail", "加载失败");
    const t = $("#lb-title");
    if (t) t.textContent = (t.textContent || "") + "（视频加载失败）";
  }
  return ok;
}

function isVideoName(name) {
  return VIDEO_EXT.test(name || "");
}

function isHeicName(name) {
  return /\.hei[cf]$/i.test(name || "");
}

function isMobileClient() {
  if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches) {
    return true;
  }
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
}

/** macOS 上的 Safari（不含 iPad 桌面模式、不含 Chrome） */
function isMacSafari() {
  const ua = navigator.userAgent || "";
  if (!/Macintosh|Mac OS X/.test(ua)) return false;
  if (/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/.test(ua)) return false;
  if (navigator.maxTouchPoints > 1) return false;
  return /Safari/.test(ua);
}

/** 手机看图用更小预览，减轻树莓派生成与蜂窝/Wi‑Fi 传输 */
function lightboxPreviewSize() {
  // 手机幻灯片也用已备好的 1600。另要 1280 会现场重解码，画面就停在很小的缩略图上。
  if (isMobileClient()) return 1600;
  if (lb.playing) return 1280;
  return 1600;
}

function isMacDesktop() {
  const ua = navigator.userAgent || "";
  if (!/Macintosh|Mac OS X/.test(ua)) return false;
  if (navigator.maxTouchPoints > 1) return false;
  return true;
}

function albumThumbSize() {
  return isMobileClient() ? 240 : 320;
}

function setupImportMobileUX() {
  const mobile = isMobileClient();
  document.body.classList.toggle("is-mobile", mobile);
  // 手机降低并发，避免缩略图/预览把上行和 CPU 打满
  albumThumbLoader.max = mobile ? 2 : 4;
  importPreviewLoader.max = mobile ? 1 : 2;
  const dirBtn = $("#btn-pick-dir");
  const title = $("#drop-title");
  const sub = $("#drop-sub");
  const hint = $("#import-hint");
  if (mobile) {
    if (dirBtn) dirBtn.classList.add("hidden");
    if (title) title.textContent = "从手机相册选择照片或视频";
    if (sub) {
      sub.textContent =
        "点「从相册选择」可多选；苹果实况请同时选 HEIC 与同名 MOV。原件无损入库。";
    }
    if (hint) {
      hint.textContent =
        "点「从相册选择」多选上传；支持 HEIC / 实况 / MOV。上传后勾选再入库。";
    }
  }
  const fileInput = $("#file-input");
  if (fileInput && isMacDesktop()) {
    // accept 里写 .heic 等扩展名时，Safari 打不开 macOS「照片」图库
    fileInput.setAttribute("accept", "image/*,video/*");
    if (!mobile && sub) {
      sub.textContent =
        "点「从相册选择」：Chrome 会打开「图片」文件夹（照片图库在这里）。Safari 请在窗口左侧点「照片」，即可勾选图片和视频。";
    }
    if (!mobile && hint) {
      hint.textContent =
        "Mac 入库：从相册选择后，在左侧进入「照片」或「图片」里的照片图库，勾选图片/视频再上传。也可直接从「照片」App 拖到这里。";
    }
  }
}

function bindMacPhotoPicker() {
  const btn = $("#btn-pick-files");
  if (!btn || btn.dataset.macPicker === "1" || !isMacDesktop()) return;
  if (typeof window.showOpenFilePicker !== "function") return;
  btn.dataset.macPicker = "1";
  btn.addEventListener(
    "click",
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      let pending;
      try {
        pending = window.showOpenFilePicker({
          multiple: true,
          startIn: "pictures",
          types: [
            {
              description: "照片和视频",
              accept: {
                "image/*": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".avif"],
                "video/*": [".mp4", ".mov", ".m4v", ".webm", ".mkv"],
              },
            },
          ],
        });
      } catch (_) {
        $("#file-input")?.click();
        return;
      }
      pending
        .then(async (handles) => {
          const files = [];
          for (const handle of handles || []) {
            try {
              const file = await handle.getFile();
              if (file) files.push(file);
            } catch (_) {}
          }
          onPicked({ files, value: "" });
        })
        .catch((err) => {
          if (err && err.name === "AbortError") return;
          $("#file-input")?.click();
        });
    },
    true
  );
}

const UPLOAD_HIST_KEY = "xiaoshu_upload_dirs_v1";
const UPLOAD_HIST_MAX = 40;

function loadUploadHist() {
  try {
    const raw = JSON.parse(localStorage.getItem(UPLOAD_HIST_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => x && x.root) : [];
  } catch (_) {
    return [];
  }
}

function saveUploadHist(list) {
  try {
    localStorage.setItem(UPLOAD_HIST_KEY, JSON.stringify(list.slice(0, UPLOAD_HIST_MAX)));
  } catch (_) {}
}

function extractUploadRoots(pairs) {
  const map = new Map(); // root -> {count, bytes}
  for (const { file, path } of pairs || []) {
    const rel = String(path || file?.name || "").replace(/\\/g, "/");
    const parts = rel.split("/").filter(Boolean);
    // 仅记录「目录上传」：相对路径至少含一层目录
    if (parts.length < 2) continue;
    const root = parts[0];
    const cur = map.get(root) || { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += Number(file?.size) || 0;
    map.set(root, cur);
  }
  return [...map.entries()].map(([root, info]) => ({ root, ...info }));
}

function rememberUploadRoots(roots) {
  if (!roots?.length) return;
  const list = loadUploadHist();
  const now = Date.now();
  for (const r of roots) {
    const idx = list.findIndex((x) => x.root === r.root);
    if (idx >= 0) {
      const prev = list[idx];
      list[idx] = {
        ...prev,
        lastAt: now,
        count: Math.max(Number(prev.count) || 0, r.count || 0),
        bytes: Math.max(Number(prev.bytes) || 0, r.bytes || 0),
        uploads: (Number(prev.uploads) || 1) + 1,
      };
    } else {
      list.unshift({
        id: `uh-${now}-${Math.random().toString(36).slice(2, 7)}`,
        root: r.root,
        lastAt: now,
        count: r.count || 0,
        bytes: r.bytes || 0,
        uploads: 1,
        keepForever: false,
      });
    }
  }
  // 非永久保留超限时裁掉最旧
  const pinned = list.filter((x) => x.keepForever);
  const rest = list.filter((x) => !x.keepForever).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  saveUploadHist([...pinned, ...rest].slice(0, UPLOAD_HIST_MAX));
  renderUploadHist();
}

function formatHistTime(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch (_) {
    return "—";
  }
}

function renderUploadHist() {
  const listEl = $("#upload-hist-list");
  const empty = $("#upload-hist-empty");
  const countEl = $("#upload-hist-count");
  if (!listEl) return;
  const list = loadUploadHist().sort((a, b) => {
    if (Boolean(a.keepForever) !== Boolean(b.keepForever)) return a.keepForever ? -1 : 1;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
  if (countEl) countEl.textContent = list.length ? `（${list.length}）` : "";
  listEl.innerHTML = "";
  if (!list.length) {
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");
  list.forEach((it) => {
    const li = document.createElement("li");
    li.className = `upload-hist-item${it.keepForever ? " keep-forever" : ""}`;
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="upload-hist-main">
        <div class="upload-hist-name">${escapeHtml(it.root)}</div>
        <div class="upload-hist-meta">
          最近 ${escapeHtml(formatHistTime(it.lastAt))}
          · ${Number(it.count) || 0} 文件
          · 上传 ${Number(it.uploads) || 1} 次
          ${it.keepForever ? " · 永久保留" : ""}
        </div>
      </div>
      <div class="upload-hist-actions">
        <button type="button" class="btn ghost btn-uh-keep" data-id="${escapeAttr(it.id)}">${
          it.keepForever ? "取消永久" : "永久保留"
        }</button>
        <button type="button" class="btn ghost btn-uh-del" data-id="${escapeAttr(it.id)}">删除</button>
      </div>`;
    listEl.appendChild(li);
  });
}

function wireUploadHist() {
  renderUploadHist();
  $("#upload-hist-list")?.addEventListener("click", (e) => {
    const keepBtn = e.target.closest?.(".btn-uh-keep");
    const delBtn = e.target.closest?.(".btn-uh-del");
    if (keepBtn) {
      const id = keepBtn.dataset.id;
      const list = loadUploadHist();
      const it = list.find((x) => x.id === id);
      if (it) {
        it.keepForever = !it.keepForever;
        saveUploadHist(list);
        renderUploadHist();
      }
      return;
    }
    if (delBtn) {
      const id = delBtn.dataset.id;
      const list = loadUploadHist().filter((x) => x.id !== id);
      saveUploadHist(list);
      renderUploadHist();
    }
  });
}

async function confirmIfKnownUploadDirs(roots) {
  if (!roots?.length) return true;
  const hist = loadUploadHist();
  const hits = roots
    .map((r) => hist.find((h) => h.root === r.root))
    .filter(Boolean);
  if (!hits.length) return true;
  const lines = hits
    .map((h) => `· ${h.root}（${formatHistTime(h.lastAt)}，已传 ${h.uploads || 1} 次）`)
    .join("\n");
  return confirm(
    `以下目录曾上传过，继续可能造成重复：\n${lines}\n\n仍要继续上传吗？`
  );
}

function applyMediaKindFilter() {
  const kind = state.mediaKindFilter || "all";
  document.querySelectorAll(".media-kind-filter .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mediaKind === kind);
  });
  // 分类改为走数据库查询：清缓存并重载当前视图
  clearMonthPhotoCache();
  if (state.viewMode === "journey" && state.outlineCache) {
    renderJourney(state.outlineCache);
  } else if (state.viewMode === "classic") {
    if (state.classicState) state.classicState.built = false;
    const root = $("#classic-root");
    if (root) root.dataset.built = "";
    ensureClassicView(true).catch(console.error);
  } else if (state.viewMode === "map" && state.map) {
    refreshMapClusters().catch(console.error);
  } else if (state.viewMode === "search") {
    const q = ($("#search-q")?.value || "").trim();
    if (q) runSearch(q).catch(console.error);
  }
}

function wireMediaKindFilter() {
  applyMediaKindFilterButtons();
  document.querySelector(".media-kind-filter")?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-media-kind]");
    if (!btn) return;
    const kind = btn.dataset.mediaKind;
    if (!["all", "image", "video"].includes(kind)) return;
    if (state.mediaKindFilter === kind) return;
    state.mediaKindFilter = kind;
    localStorage.setItem("xiaoshu_media_kind", kind);
    applyMediaKindFilterButtons();
    applyMediaKindFilter();
  });
}

function applyMediaKindFilterButtons() {
  const kind = state.mediaKindFilter || "all";
  document.querySelectorAll(".media-kind-filter .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mediaKind === kind);
  });
}

function entryToFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(entry, parent) {
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await entryToFile(entry);
    return MEDIA_EXT.test(file.name) ? [{ file, path }] : [];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  let batch = [];
  do {
    batch = await readEntries(reader);
    for (const child of batch) {
      out.push(...(await walkEntry(child, path)));
    }
  } while (batch.length);
  return out;
}

async function fromDataTransfer(dt) {
  const items = [...(dt.items || [])];
  const hasEntry = items.some((it) => typeof it.webkitGetAsEntry === "function");
  if (hasEntry) {
    const groups = await Promise.all(
      items
        .filter((it) => it.kind === "file")
        .map((it) => it.webkitGetAsEntry())
        .filter(Boolean)
        .map((entry) => walkEntry(entry, ""))
    );
    return groups.flat();
  }
  return [...(dt.files || [])]
    .filter((file) => MEDIA_EXT.test(file.name))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

const uploadQueue = {
  items: [], // {id, file, path, status, error, saved, progress}
  paused: false,
  running: false,
  seq: 0,
  // 已计入总进度的字节（完成/失败项）
  settledBytes: 0,
};

const UPLOAD_LARGE_BYTES = 8 * 1024 * 1024; // 大文件单独传，避免打满 USB
const UPLOAD_BATCH_MAX_FILES = 4;
const UPLOAD_BATCH_MAX_BYTES = 16 * 1024 * 1024;

function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  if (x < 1024 * 1024 * 1024) return `${(x / 1024 / 1024).toFixed(1)} MB`;
  return `${(x / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function uploadConcurrency() {
  // 树莓派 USB 盘 + 千兆网同时写时，过高并发会把 SSH/整机打卡
  return 1;
}

function setUploadProgress({ show, title, summary, detail, percent }) {
  const box = $("#upload-progress");
  const bar = $("#upload-progress-bar");
  if (!box) return;
  box.classList.toggle("hidden", !show);
  if (title != null && $("#upload-progress-title")) $("#upload-progress-title").textContent = title;
  if (summary != null && $("#upload-progress-summary")) $("#upload-progress-summary").textContent = summary;
  if (detail != null && $("#upload-progress-detail")) $("#upload-progress-detail").textContent = detail;
  if (bar && percent != null) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function uploadQueueTotals() {
  const items = uploadQueue.items;
  let totalBytes = 0;
  let settled = uploadQueue.settledBytes || 0;
  let inflight = 0;
  for (const it of items) {
    const sz = Number(it.file?.size) || 0;
    totalBytes += sz;
    if (it.status === "uploading") {
      inflight += Math.max(0, Math.min(sz, Number(it.loaded) || 0));
    }
  }
  const doneFiles = items.filter((x) => x.status === "done").length;
  const failFiles = items.filter((x) => x.status === "error").length;
  const pendingFiles = items.filter((x) => x.status === "pending" || x.status === "uploading").length;
  const sent = Math.min(totalBytes, settled + inflight);
  const percent = totalBytes ? (sent / totalBytes) * 100 : 0;
  return { totalBytes, sent, percent, doneFiles, failFiles, pendingFiles, totalFiles: items.length };
}

function refreshUploadProgress(detail) {
  const t = uploadQueueTotals();
  const active = t.pendingFiles > 0 && !uploadQueue.paused;
  const show = t.totalFiles > 0 && (active || t.doneFiles + t.failFiles < t.totalFiles || t.sent > 0);
  setUploadProgress({
    show: show && (active || uploadQueue.running || uploadQueue.paused),
    title: uploadQueue.paused ? "上传已暂停" : active ? "正在上传…" : "上传完成",
    summary: `${t.doneFiles + t.failFiles}/${t.totalFiles} · ${formatBytes(t.sent)} / ${formatBytes(t.totalBytes)}`,
    detail: detail || $("#upload-progress-detail")?.textContent || "",
    percent: t.percent,
  });
}

function renderUploadQueue() {
  const box = $("#upload-queue");
  const list = $("#upload-queue-list");
  const sum = $("#upload-queue-summary");
  if (!box || !list) return;
  const items = uploadQueue.items;
  box.classList.toggle("hidden", !items.length);
  const t = uploadQueueTotals();
  if (sum) {
    sum.textContent = `${t.totalFiles} 项 · 完成 ${t.doneFiles} · 失败 ${t.failFiles} · 等待 ${t.pendingFiles}${
      uploadQueue.paused ? " · 已暂停" : ""
    }`;
  }
  // 仅渲染前 40 + 当前上传中，避免大队列 DOM 卡顿
  const uploading = items.filter((x) => x.status === "uploading");
  const rest = items.filter((x) => x.status !== "uploading").slice(0, 36);
  const view = [...uploading, ...rest];
  list.innerHTML = view
    .map((it) => {
      const st =
        it.status === "uploading"
          ? "上传中"
          : it.status === "done"
            ? "完成"
            : it.status === "error"
              ? "失败"
              : "等待";
      const pct = it.status === "uploading" ? Math.round(Number(it.progress) || 0) : it.status === "done" ? 100 : 0;
      const bar =
        it.status === "uploading" || it.status === "done"
          ? `<div class="uq-item-bar"><i style="width:${pct}%"></i></div>`
          : "";
      return `<li class="uq-item uq-${it.status}" data-id="${it.id}">
        <span class="uq-name" title="${escapeAttr(it.path || it.file?.name || "")}">${escapeHtml(it.file?.name || it.path || "")}</span>
        <span class="uq-meta muted">${formatBytes(it.file?.size)} · ${st}${
          it.status === "uploading" && pct ? ` ${pct}%` : ""
        }${it.error ? " · " + escapeHtml(it.error) : ""}</span>
        ${bar}
      </li>`;
    })
    .join("");
  const pauseBtn = $("#btn-queue-pause");
  const resumeBtn = $("#btn-queue-resume");
  pauseBtn?.classList.toggle("hidden", uploadQueue.paused || !t.pendingFiles);
  resumeBtn?.classList.toggle("hidden", !uploadQueue.paused);
  refreshUploadProgress();
}

function takeUploadBatch(pending) {
  if (!pending.length) return [];
  const first = pending[0];
  const firstSize = Number(first.file?.size) || 0;
  if (firstSize >= UPLOAD_LARGE_BYTES) return [first];
  const batch = [];
  let bytes = 0;
  for (const it of pending) {
    const sz = Number(it.file?.size) || 0;
    if (sz >= UPLOAD_LARGE_BYTES) break;
    if (batch.length && (batch.length >= UPLOAD_BATCH_MAX_FILES || bytes + sz > UPLOAD_BATCH_MAX_BYTES)) {
      break;
    }
    batch.push(it);
    bytes += sz;
  }
  return batch;
}

function xhrUploadForm(form, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import/upload");
    xhr.withCredentials = true;
    xhr.responseType = "json";
    const abort = () => {
      try {
        xhr.abort();
      } catch (_) {}
      reject(new Error("已取消"));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      const status = xhr.status;
      let data = xhr.response;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (_) {
          data = null;
        }
      }
      if (status >= 200 && status < 300) {
        resolve(data || { ok: true, count: 0, saved: [], skipped: [] });
        return;
      }
      const msg =
        (data && (data.detail || data.message)) ||
        xhr.statusText ||
        `上传失败（${status}）`;
      reject(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)));
    };
    xhr.onerror = () => reject(new Error("网络错误，上传中断"));
    xhr.ontimeout = () => reject(new Error("上传超时"));
    xhr.timeout = 0;
    xhr.send(form);
  });
}

async function uploadBatchItems(batch) {
  batch.forEach((it) => {
    it.status = "uploading";
    it.progress = 0;
    it.loaded = 0;
    it.error = "";
  });
  renderUploadQueue();
  const names = batch.map((it) => it.file?.name || it.path).join("、");
  $("#drop-status").textContent =
    batch.length > 1 ? `正在上传本批 ${batch.length} 项…` : `正在上传：${names}`;
  refreshUploadProgress(batch.length > 1 ? `本批 ${batch.length} 项：${names.slice(0, 80)}` : names);

  const form = new FormData();
  const batchBytes = batch.reduce((n, it) => n + (Number(it.file?.size) || 0), 0);
  for (const it of batch) {
    form.append("files", it.file, it.file.name);
    form.append("paths", it.path || it.file.name);
  }
  try {
    const data = await xhrUploadForm(form, {
      onProgress: (loaded, total) => {
        const ratio = total ? loaded / total : 0;
        let assigned = 0;
        batch.forEach((it, idx) => {
          const sz = Number(it.file?.size) || 0;
          const share = batchBytes ? sz / batchBytes : 1 / batch.length;
          const est =
            idx === batch.length - 1 ? Math.max(0, loaded - assigned) : Math.floor(loaded * share);
          assigned += est;
          it.loaded = Math.min(sz, est);
          it.progress = sz ? Math.min(100, (it.loaded / sz) * 100) : ratio * 100;
        });
        refreshUploadProgress(
          batch.length > 1 ? `本批 ${batch.length} 项 · ${formatBytes(loaded)}` : names
        );
        batch.forEach((it) => {
          const li = document.querySelector(`.uq-item[data-id="${it.id}"]`);
          if (!li) return;
          const bar = li.querySelector(".uq-item-bar > i");
          const meta = li.querySelector(".uq-meta");
          if (bar) bar.style.width = `${Math.round(it.progress || 0)}%`;
          if (meta) {
            meta.textContent = `${formatBytes(it.file?.size)} · 上传中 ${Math.round(it.progress || 0)}%`;
          }
        });
      },
    });
    const saved = data.saved || [];
    const skipped = data.skipped || [];
    const count = Number(data.count) || saved.length || 0;
    batch.forEach((it) => {
      const rel = it.path || it.file?.name || "";
      const name = it.file?.name || "";
      const wasSkipped = skipped.some(
        (s) => s === rel || String(s).endsWith(name) || String(s) === name
      );
      const savedPath = saved.find(
        (s) => s === rel || String(s).endsWith(name) || String(s) === name
      );
      if (savedPath) it.savedPath = savedPath;
      if (wasSkipped && count < batch.length) {
        it.status = "error";
        it.error = "服务端跳过";
        it.progress = 0;
        it.loaded = 0;
      } else if (count > 0 || saved.length) {
        it.status = "done";
        it.saved = 1;
        it.progress = 100;
        it.loaded = Number(it.file?.size) || 0;
        it.error = "";
      } else {
        it.status = "error";
        it.error = "上传失败";
        it.progress = 0;
      }
      uploadQueue.settledBytes += Number(it.file?.size) || 0;
    });
  } catch (err) {
    batch.forEach((it) => {
      it.status = "error";
      it.error = err.message || String(err);
      it.progress = 0;
      uploadQueue.settledBytes += Number(it.file?.size) || 0;
    });
  }
  renderUploadQueue();
}

async function pumpUploadQueue() {
  if (uploadQueue.running) return;
  uploadQueue.running = true;
  importPreviewLoader.pause();
  const workers = uploadConcurrency();
  try {
    const runOne = async () => {
      while (!uploadQueue.paused) {
        const pending = uploadQueue.items.filter((x) => x.status === "pending");
        if (!pending.length) return;
        // 原子领取一批：先标 uploading 占位，避免多 worker 抢同一批
        const batch = takeUploadBatch(pending);
        if (!batch.length) return;
        let claimed = true;
        for (const it of batch) {
          if (it.status !== "pending") {
            claimed = false;
            break;
          }
        }
        if (!claimed) continue;
        batch.forEach((it) => {
          it.status = "uploading";
          it.progress = 0;
          it.loaded = 0;
        });
        await uploadBatchItems(batch);
      }
    };
    await Promise.all(Array.from({ length: workers }, () => runOne()));
  } finally {
    uploadQueue.running = false;
  }
  const saved = uploadQueue.items.filter((x) => x.status === "done").reduce((n, x) => n + (x.saved || 1), 0);
  const failed = uploadQueue.items.filter((x) => x.status === "error").length;
  const pending = uploadQueue.items.filter((x) => x.status === "pending" || x.status === "uploading").length;
  if (uploadQueue.paused && pending) {
    importPreviewLoader.resume();
    $("#drop-status").textContent = "上传已暂停";
    refreshUploadProgress("已暂停，点「继续」恢复");
    return;
  }
  refreshUploadProgress(failed ? `成功 ${saved}，失败 ${failed}` : `成功 ${saved} 项`);
  $("#drop-status").textContent = `队列完成：成功 ${saved}，失败 ${failed}`;
  if (saved) {
    $("#drop-status").textContent = `队列完成：成功 ${saved}，失败 ${failed}；正在解析并查重…`;
    const newPaths = uploadQueue.items
      .filter((x) => x.status === "done")
      .map((x) => x.savedPath || x.path)
      .filter(Boolean);
    const parseOpts = newPaths.length ? { paths: newPaths } : {};
    await parseImportList(parseOpts).catch(() => loadImport().catch(console.error));
  }
  importPreviewLoader.resume();
  $("#manage-import")?.classList.remove("is-uploading");
  // 全部结束后收起进度条（保留队列列表）
  if (!pending) {
    setTimeout(() => {
      if (!uploadQueue.running && !uploadQueue.items.some((x) => x.status === "pending" || x.status === "uploading")) {
        setUploadProgress({ show: false });
      }
    }, 1600);
  }
}

async function uploadPairs(pairs) {
  revealImportUploadView();
  if (!pairs.length) {
    $("#drop-status").textContent = "没有可导入的图片或视频";
    $("#manage-import")?.classList.remove("is-uploading");
    return;
  }
  const roots = extractUploadRoots(pairs);
  if (!(await confirmIfKnownUploadDirs(roots))) {
    $("#drop-status").textContent = "已取消上传（目录曾上传过）";
    $("#manage-import")?.classList.remove("is-uploading");
    return;
  }
  pairs.forEach(({ file, path }) => {
    uploadQueue.items.push({
      id: `uq-${++uploadQueue.seq}`,
      file,
      path: path || file.name,
      status: "pending",
      error: "",
      saved: 0,
      progress: 0,
      loaded: 0,
    });
  });
  uploadQueue.paused = false;
  // settledBytes 只统计本轮已结算；保留历史完成项的体积已在 items 里，重算
  uploadQueue.settledBytes = uploadQueue.items
    .filter((x) => x.status === "done" || x.status === "error")
    .reduce((n, x) => n + (Number(x.file?.size) || 0), 0);
  renderUploadQueue();
  setUploadProgress({
    show: true,
    title: "正在上传…",
    summary: `0/${pairs.length}`,
    detail: "准备上传…",
    percent: 0,
  });
  await pumpUploadQueue();
  // 本批有成功项才记入历史上传目录
  const savedN = uploadQueue.items.filter((x) => x.status === "done").length;
  if (savedN && roots.length) rememberUploadRoots(roots);
}

function wireUploadQueueControls() {
  $("#btn-queue-pause")?.addEventListener("click", () => {
    uploadQueue.paused = true;
    renderUploadQueue();
    $("#drop-status").textContent = "上传已暂停";
    refreshUploadProgress("已暂停");
  });
  $("#btn-queue-resume")?.addEventListener("click", () => {
    uploadQueue.paused = false;
    renderUploadQueue();
    pumpUploadQueue().catch(console.error);
  });
  $("#btn-queue-retry")?.addEventListener("click", () => {
    uploadQueue.items.forEach((x) => {
      if (x.status === "error") {
        // 失败项曾计入 settledBytes，重试前扣回
        uploadQueue.settledBytes = Math.max(0, uploadQueue.settledBytes - (Number(x.file?.size) || 0));
        x.status = "pending";
        x.error = "";
        x.progress = 0;
        x.loaded = 0;
      }
    });
    uploadQueue.paused = false;
    renderUploadQueue();
    pumpUploadQueue().catch(console.error);
  });
  $("#btn-queue-clear")?.addEventListener("click", () => {
    uploadQueue.items = uploadQueue.items.filter((x) => x.status !== "done");
    uploadQueue.settledBytes = uploadQueue.items
      .filter((x) => x.status === "error")
      .reduce((n, x) => n + (Number(x.file?.size) || 0), 0);
    renderUploadQueue();
    if (!uploadQueue.items.length) setUploadProgress({ show: false });
  });
}

const zone = $("#drop-zone");
if (zone) {
  ["dragenter", "dragover"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
    });
  });
  zone.addEventListener("drop", async (e) => {
    try {
      const pairs = await fromDataTransfer(e.dataTransfer);
      await uploadPairs(pairs);
    } catch (err) {
      $("#drop-status").textContent = err.message;
    }
  });
}

function revealImportUploadView() {
  const switched = state.section !== "manage" || state.manageTab !== "import";
  if (switched) {
    state.section = "manage";
    state.manageTab = "import";
    applySection();
  }
  const pane = $("#manage-import");
  pane?.classList.add("is-uploading");
  const q = $("#upload-queue");
  q?.classList.remove("hidden");
  requestAnimationFrame(() => {
    q?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function onPicked(input) {
  const files = Array.from(input.files || []);
  input.value = "";
  revealImportUploadView();
  const n = files.length;
  if ($("#drop-status")) {
    $("#drop-status").textContent = n ? `已选择 ${n} 项，正在加入上传队列…` : "没有选中文件";
  }
  setUploadProgress({
    show: true,
    title: "正在准备上传…",
    summary: n ? `${n} 项` : "0 项",
    detail: "相册已关闭，正在加入队列，请稍候",
    percent: 0,
  });
  const run = async () => {
    const pairs = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file || !MEDIA_EXT.test(file.name)) continue;
      pairs.push({ file, path: file.webkitRelativePath || file.name });
      if (i > 0 && i % 50 === 0) {
        setUploadProgress({
          show: true,
          title: "正在准备上传…",
          summary: `${pairs.length}/${n}`,
          detail: `加入队列 ${i + 1}/${n}`,
          percent: n ? (i / n) * 100 : 0,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await uploadPairs(pairs);
  };
  run().catch((err) => {
    if ($("#drop-status")) $("#drop-status").textContent = err.message;
    $("#manage-import")?.classList.remove("is-uploading");
  });
}
$("#file-input")?.addEventListener("change", (e) => onPicked(e.target));
$("#dir-input")?.addEventListener("change", (e) => onPicked(e.target));

async function runIngestSelected() {
  // 若正在入库：只提示，不要改成「已取消」
  if (ingestState.running) {
    const stuckMs = Date.now() - (ingestState.startedAt || 0);
    if (stuckMs < 180000) {
      setDropStatus("正在入库中…可点右侧「取消入库」停止", "busy");
      setIngestProgress({ show: true });
      return;
    }
    ingestState.running = false;
  }
  if (state._detachedImportList) {
    setBatchUiFrozen(false);
  }

  const items = collectIngestItems();
  if (!items.length) {
    const msg = "请先勾选要入库的项目（未勾选的不会入库）";
    setDropStatus(msg, "warn");
    alert(msg);
    return;
  }

  // 不再弹 confirm：点「入库选中项」直接开始，进度条立刻出现
  const totalAll = state.importItemCount || importListRoot()?.querySelectorAll(".import-item").length || 0;
  const skipped = Math.max(0, totalAll - items.length);

  ingestState.running = true;
  ingestState.cancel = false;
  ingestState.startedAt = Date.now();
  const btn = $("#btn-ingest");
  const btnCancel = $("#btn-ingest-cancel");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "入库中…";
  }
  if (btnCancel) btnCancel.classList.remove("hidden");

  const results = [];
  let okN = 0;
  let failN = 0;
  const BATCH = 4;
  setIngestProgress({
    show: true,
    title: "正在入库…",
    summary: `0 / ${items.length}`,
    detail:
      (skipped ? `未勾选 ${skipped} 项将跳过。` : "") +
      `本批准备处理 ${Math.min(BATCH, items.length)} 项`,
    percent: 2,
  });
  setDropStatus(`正在入库 0/${items.length}…`, "busy");
  try {
    $("#ingest-progress")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    $("#import-status")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  } catch (_) {}

  try {
    for (let start = 0; start < items.length; start += BATCH) {
      if (ingestState.cancel) {
        for (let j = start; j < items.length; j++) {
          results.push({ ok: false, path: items[j].path, message: "已取消（未处理）" });
        }
        break;
      }
      const batch = items.slice(start, start + BATCH);
      importListRoot()?.querySelectorAll(".import-item").forEach((r) => r.classList.remove("is-ingesting"));
      batch.forEach((it) => it.row?.classList.add("is-ingesting"));
      const label = batch.map((it) => it.name || it.path).join("、");
      setIngestProgress({
        show: true,
        title: "正在入库…",
        summary: `${Math.min(start + batch.length, items.length)} / ${items.length}`,
        detail: `本批 ${batch.length} 项：${label.slice(0, 80)}${label.length > 80 ? "…" : ""}`,
        percent: (start / items.length) * 100,
      });
      setDropStatus(`正在入库 ${start + 1}-${start + batch.length}/${items.length}`, "busy");
      try {
        const data = await api("/api/import/ingest", {
          method: "POST",
          body: JSON.stringify({
            items: batch.map((it) => ({
              path: it.path,
              datetime: it.datetime,
              title: it.title,
              description: it.description,
              location: it.location,
              content_hash: it.content_hash || null,
              skip_meta_read: Boolean(it.datetime && (it.title != null)),
            })),
          }),
        });
        const batchResults = data.results || [];
        for (let bi = 0; bi < batch.length; bi++) {
          const it = batch[bi];
          const r = batchResults[bi] || { ok: false, path: it.path, message: "无返回" };
          // 保证失败结果带上来源 path，刷新后还能对上
          if (!r.path) r.path = it.path;
          results.push(r);
          if (r.ok) {
            okN += 1;
            it.row?.classList.add("is-ingest-done");
            if (r.duplicate || r.skipped) it.row?.classList.add("is-duplicate");
          } else {
            failN += 1;
            it.row?.classList.add("is-ingest-fail");
          }
        }
      } catch (e) {
        for (const it of batch) {
          failN += 1;
          results.push({ ok: false, path: it.path, message: e.message || String(e) });
          it.row?.classList.add("is-ingest-fail");
        }
      }
      setIngestProgress({
        show: true,
        title: ingestState.cancel ? "入库已停止" : "正在入库…",
        summary: `${Math.min(start + batch.length, items.length)} / ${items.length} · 成功 ${okN} · 失败 ${failN}`,
        detail: `本批：${label.slice(0, 80)}`,
        percent: (Math.min(start + batch.length, items.length) / items.length) * 100,
      });
    }

    const log = $("#import-log");
    if (log) {
      log.classList.remove("hidden");
      log.textContent = results
        .map((r) => (r.ok ? `✓ ${r.path} ${r.message || ""}` : `✗ ${r.path || ""} ${r.message || ""}`))
        .join("\n");
    }
    const cancelled = ingestState.cancel;
    if (!state.importOutcomes) state.importOutcomes = new Map();
    // results 与 items 同序；成功时 r.path 是相册路径，失败标记必须用待入库源路径
    for (let i = 0; i < results.length; i++) {
      const srcPath = items[i]?.path || "";
      if (!srcPath) continue;
      const r = results[i] || {};
      if (r.ok) state.importOutcomes.delete(srcPath);
      else {
        state.importOutcomes.set(srcPath, {
          ok: false,
          message: r.message || "入库失败",
        });
      }
    }
    const tone = failN ? "fail" : "ok";
    setIngestProgress({
      show: true,
      title: cancelled ? "入库已停止" : failN ? "入库完成（有失败）" : "入库完成",
      summary: `成功 ${okN} · 失败 ${failN} · 合计 ${results.length}`,
      detail: cancelled
        ? "已停止后续项目；成功的已写入相册，失败/未处理项仍在待入库列表。"
        : failN
          ? "失败项仍留在待入库，列表已标红并可重试；详情见下方日志。"
          : "选中项已全部处理。",
      percent: 100,
      tone,
    });
    setDropStatus(
      cancelled
        ? `入库已停止：成功 ${okN}，未处理/失败 ${results.length - okN}`
        : failN
          ? `入库完成：成功 ${okN}，失败 ${failN}（失败项仍在列表中）`
          : `入库完成：成功 ${okN}`,
      failN || cancelled ? "warn" : "ok"
    );

    // 先刷新待入库（保留失败标记），浏览树放到后台，避免像「刷新一直不结束」
    setDropStatus(
      failN
        ? `正在刷新待入库列表（保留 ${failN} 项失败标记）…`
        : "正在刷新待入库列表…",
      "busy"
    );
    await loadImport({ quiet: true });
    const leftFail = [...(state.importOutcomes?.values() || [])].filter((x) => x && x.ok === false).length;
    setDropStatus(
      cancelled
        ? `入库已停止：成功 ${okN} · 待入库仍有失败/未处理项`
        : leftFail
          ? `入库完成：成功 ${okN}，失败 ${leftFail}（已标红，可改完再入库）`
          : `入库完成：成功 ${okN}，待入库已更新`,
      leftFail || cancelled ? "warn" : "ok"
    );
    loadTree(false).catch(console.error);
    invalidateMapData().catch(() => {});
  } catch (e) {
    alert(e.message);
    setDropStatus(e.message || String(e), "error");
    setIngestProgress({
      show: true,
      title: "入库中断",
      summary: "",
      detail: e.message || String(e),
      percent: 0,
      tone: "fail",
    });
  } finally {
    ingestState.running = false;
    ingestState.cancel = false;
    ingestState.startedAt = 0;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "入库选中项";
    }
    if (btnCancel) btnCancel.classList.add("hidden");
    importListRoot()?.querySelectorAll(".import-item").forEach((r) => r.classList.remove("is-ingesting"));
  }
}

function selectedImportPaths() {
  const paths = [];
  importListRoot()?.querySelectorAll(".import-item").forEach((row) => {
    if (!row.querySelector(".pick")?.checked) return;
    if (row.dataset.liveCompanion === "1") return;
    if (row.dataset.path) paths.push(row.dataset.path);
  });
  return paths;
}

/* Viewer: zoom / pan / crop */
const viewer = $("#viewer");
const stage = $("#viewer-stage");
const imgEl = $("#detail-img");
const videoEl = $("#detail-video");
const cropMask = $("#crop-mask");
const cropRect = $("#crop-rect");

function applyViewerTransform() {
  const rot = state.pendingRotate;
  stage.style.transform = `translate(calc(-50% + ${state.panX}px), calc(-50% + ${state.panY}px)) scale(${state.zoom}) rotate(${rot}deg)`;
  imgEl.style.transform = "";
  syncCropRect();
}

function computeFit() {
  const box = viewer.getBoundingClientRect();
  if (!state.naturalW || !state.naturalH || !box.width || !box.height) return;
  const pad = 16;
  state.fitScale = Math.min(
    (box.width - pad) / state.naturalW,
    (box.height - pad) / state.naturalH,
    1
  );
  imgEl.style.width = `${state.naturalW * state.fitScale}px`;
  imgEl.style.height = `${state.naturalH * state.fitScale}px`;
}

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  computeFit();
  applyViewerTransform();
}

function setZoom(next, cx, cy) {
  const box = viewer.getBoundingClientRect();
  const centerX = cx == null ? box.width / 2 : cx - box.left;
  const centerY = cy == null ? box.height / 2 : cy - box.top;
  const prev = state.zoom;
  const clamped = Math.min(8, Math.max(0.2, next));
  if (clamped === prev) return;
  const ratio = clamped / prev;
  state.panX = (state.panX - (centerX - box.width / 2)) * ratio + (centerX - box.width / 2);
  state.panY = (state.panY - (centerY - box.height / 2)) * ratio + (centerY - box.height / 2);
  state.zoom = clamped;
  applyViewerTransform();
}

function syncCropRect() {
  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  if (!w || !h) return;
  const { left, top, right, bottom } = state.crop;
  const x = left * w;
  const y = top * h;
  const rw = (right - left) * w;
  const rh = (bottom - top) * h;
  cropRect.style.left = `${x}px`;
  cropRect.style.top = `${y}px`;
  cropRect.style.width = `${rw}px`;
  cropRect.style.height = `${rh}px`;

  const st = cropMask.querySelector(".crop-shade-t");
  const sb = cropMask.querySelector(".crop-shade-b");
  const sl = cropMask.querySelector(".crop-shade-l");
  const sr = cropMask.querySelector(".crop-shade-r");
  if (!st) return;
  st.style.cssText = `left:0;top:0;width:100%;height:${y}px;`;
  sb.style.cssText = `left:0;top:${y + rh}px;width:100%;height:${Math.max(0, h - y - rh)}px;`;
  sl.style.cssText = `left:0;top:${y}px;width:${x}px;height:${rh}px;`;
  sr.style.cssText = `left:${x + rw}px;top:${y}px;width:${Math.max(0, w - x - rw)}px;height:${rh}px;`;
}

function setCropEnabled(on) {
  state.cropEnabled = on;
  cropMask.classList.toggle("hidden", !on);
  $("#btn-crop-toggle").classList.toggle("is-active", on);
  $("#btn-crop-toggle").classList.remove("primary");
  if (on) {
    state.crop = { left: 0.12, top: 0.12, right: 0.88, bottom: 0.88 };
    syncCropRect();
  }
}

imgEl.addEventListener("load", () => {
  state.naturalW = imgEl.naturalWidth;
  state.naturalH = imgEl.naturalHeight;
  resetView();
  if (state.cropEnabled) syncCropRect();
});

viewer.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom(state.zoom * factor, e.clientX, e.clientY);
  },
  { passive: false }
);

let panDrag = null;
viewer.addEventListener("pointerdown", (e) => {
  if (state.cropEnabled && e.target.closest(".crop-rect")) return;
  if (e.button !== 0) return;
  panDrag = { x: e.clientX, y: e.clientY, ox: state.panX, oy: state.panY };
  viewer.classList.add("panning");
  viewer.setPointerCapture(e.pointerId);
});
viewer.addEventListener("pointermove", (e) => {
  if (!panDrag) return;
  state.panX = panDrag.ox + (e.clientX - panDrag.x);
  state.panY = panDrag.oy + (e.clientY - panDrag.y);
  applyViewerTransform();
});
viewer.addEventListener("pointerup", () => {
  panDrag = null;
  viewer.classList.remove("panning");
});
viewer.addEventListener("pointercancel", () => {
  panDrag = null;
  viewer.classList.remove("panning");
});

let cropDrag = null;
cropRect.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  const handle = e.target.dataset.handle || "move";
  const box = imgEl.getBoundingClientRect();
  cropDrag = {
    handle,
    startX: e.clientX,
    startY: e.clientY,
    start: { ...state.crop },
    imgW: box.width,
    imgH: box.height,
  };
  cropRect.setPointerCapture(e.pointerId);
});
cropRect.addEventListener("pointermove", (e) => {
  if (!cropDrag) return;
  const dx = (e.clientX - cropDrag.startX) / cropDrag.imgW;
  const dy = (e.clientY - cropDrag.startY) / cropDrag.imgH;
  const s = cropDrag.start;
  let { left, top, right, bottom } = s;
  const minSize = 0.05;
  const h = cropDrag.handle;
  if (h === "move") {
    const w = right - left;
    const ht = bottom - top;
    left = Math.min(Math.max(0, left + dx), 1 - w);
    top = Math.min(Math.max(0, top + dy), 1 - ht);
    right = left + w;
    bottom = top + ht;
  } else {
    if (h.includes("w")) left = Math.min(right - minSize, Math.max(0, s.left + dx));
    if (h.includes("e")) right = Math.max(left + minSize, Math.min(1, s.right + dx));
    if (h.includes("n")) top = Math.min(bottom - minSize, Math.max(0, s.top + dy));
    if (h.includes("s")) bottom = Math.max(top + minSize, Math.min(1, s.bottom + dy));
  }
  state.crop = { left, top, right, bottom };
  syncCropRect();
});
cropRect.addEventListener("pointerup", () => {
  cropDrag = null;
});
cropRect.addEventListener("pointercancel", () => {
  cropDrag = null;
});

$("#btn-zoom-in").addEventListener("click", () => setZoom(state.zoom * 1.25));
$("#btn-zoom-out").addEventListener("click", () => setZoom(state.zoom / 1.25));
$("#btn-zoom-reset").addEventListener("click", () => resetView());

let _detailReq = 0;

function formatTrimTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

function syncTrimHiddenInputs() {
  const startEl = $("#d-trim-start");
  const endEl = $("#d-trim-end");
  if (startEl) startEl.value = String(state.trimStart || 0);
  if (endEl) endEl.value = String(state.trimEnd || 0);
}

function syncTrimTimelineUI() {
  const dur = Number(state.videoDuration) || 0;
  if (dur <= 0) return;
  const t0 = Math.max(0, Math.min(state.trimStart, dur));
  const t1 = Math.max(t0 + 0.2, Math.min(state.trimEnd || dur, dur));
  state.trimStart = t0;
  state.trimEnd = t1;
  const left = (t0 / dur) * 100;
  const right = (t1 / dur) * 100;
  const range = $("#trim-range");
  const shadeL = $("#trim-shade-l");
  const shadeR = $("#trim-shade-r");
  if (range) {
    range.style.left = `${left}%`;
    range.style.width = `${Math.max(0, right - left)}%`;
  }
  if (shadeL) shadeL.style.width = `${left}%`;
  if (shadeR) shadeR.style.width = `${Math.max(0, 100 - right)}%`;
  const cur = videoEl && !videoEl.paused ? videoEl.currentTime : videoEl?.currentTime || t0;
  const ph = $("#trim-playhead");
  if (ph) ph.style.left = `${(Math.min(Math.max(cur, 0), dur) / dur) * 100}%`;
  const keep = t1 - t0;
  if ($("#trim-label-in")) $("#trim-label-in").textContent = formatTrimTime(t0);
  if ($("#trim-label-out")) $("#trim-label-out").textContent = formatTrimTime(t1);
  if ($("#trim-label-span")) $("#trim-label-span").textContent = `保留 ${formatTrimTime(keep)}`;
  if ($("#trim-keep-label")) {
    $("#trim-keep-label").textContent =
      Math.abs(t0) < 0.05 && Math.abs(t1 - dur) < 0.05
        ? "拖动两端裁切时长"
        : `已裁切 · 保留 ${formatTrimTime(keep)}`;
  }
  syncTrimHiddenInputs();
}

function resetTrimTimeline(duration) {
  const dur = Number(duration) || 0;
  state.videoDuration = dur;
  state.trimStart = 0;
  state.trimEnd = dur;
  state.trimDirty = false;
  syncTrimTimelineUI();
}

function timeFromTrimPointer(clientX) {
  const track = $("#trim-track");
  const dur = Number(state.videoDuration) || 0;
  if (!track || dur <= 0) return 0;
  const rect = track.getBoundingClientRect();
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  return (x / rect.width) * dur;
}

function bindTrimTimeline() {
  if (state._trimBound) return;
  state._trimBound = true;
  const track = $("#trim-track");
  const handleIn = $("#trim-handle-in");
  const handleOut = $("#trim-handle-out");
  if (!track) return;

  let mode = null; // in | out | seek

  const onMove = (e) => {
    if (!mode) return;
    const t = timeFromTrimPointer(e.clientX);
    const dur = Number(state.videoDuration) || 0;
    const minGap = Math.min(0.2, dur);
    if (mode === "in") {
      state.trimStart = Math.min(t, state.trimEnd - minGap);
      state.trimDirty = true;
      if (videoEl) videoEl.currentTime = state.trimStart;
    } else if (mode === "out") {
      state.trimEnd = Math.max(t, state.trimStart + minGap);
      state.trimDirty = true;
      if (videoEl) videoEl.currentTime = state.trimEnd;
    } else if (mode === "seek") {
      if (videoEl) videoEl.currentTime = Math.min(Math.max(t, state.trimStart), state.trimEnd);
    }
    syncTrimTimelineUI();
  };
  const onUp = () => {
    mode = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  handleIn?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    mode = "in";
    handleIn.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  handleOut?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    mode = "out";
    handleOut.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  track.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".trim-handle")) return;
    e.preventDefault();
    mode = "seek";
    onMove(e);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  videoEl?.addEventListener("timeupdate", () => {
    if (state.mediaKind !== "video") return;
    const ph = $("#trim-playhead");
    const dur = Number(state.videoDuration) || 0;
    if (!ph || dur <= 0) return;
    ph.style.left = `${(videoEl.currentTime / dur) * 100}%`;
    // 播放超出保留段时停在出点
    if (!videoEl.paused && videoEl.currentTime > state.trimEnd + 0.05) {
      videoEl.pause();
      videoEl.currentTime = state.trimEnd;
    }
  });
}

async function buildTrimFilmstrip() {
  const film = $("#trim-film");
  if (!film || !videoEl?.src) return;
  const src = videoEl.currentSrc || videoEl.src;
  if (!src) return;
  film.innerHTML = "";
  const probe = document.createElement("video");
  probe.muted = true;
  probe.preload = "auto";
  probe.src = src;
  await new Promise((resolve) => {
    probe.addEventListener("loadeddata", resolve, { once: true });
    probe.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 4000);
  });
  const dur = probe.duration || state.videoDuration || 0;
  if (!dur || !Number.isFinite(dur)) return;
  const frames = 16;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 56;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (let i = 0; i < frames; i++) {
    const t = (dur * (i + 0.5)) / frames;
    await new Promise((resolve) => {
      const done = () => resolve();
      probe.addEventListener("seeked", done, { once: true });
      try {
        probe.currentTime = Math.min(t, Math.max(dur - 0.05, 0));
      } catch (_) {
        resolve();
      }
      setTimeout(done, 400);
    });
    try {
      ctx.drawImage(probe, 0, 0, 64, 56);
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/jpeg", 0.62);
      img.alt = "";
      film.appendChild(img);
    } catch (_) {}
  }
  probe.removeAttribute("src");
  probe.load();
}

function setMediaMode(kind, duration) {
  state.mediaKind = kind === "video" ? "video" : "image";
  state.videoDuration = duration || 0;
  const isVid = state.mediaKind === "video";
  imgEl.classList.toggle("hidden", isVid);
  videoEl.classList.toggle("hidden", !isVid);
  $("#edit-tools-image")?.classList.toggle("hidden", isVid);
  $("#edit-tools-video")?.classList.toggle("hidden", !isVid);
  $("#narration-block")?.classList.toggle("hidden", isVid);
  viewer?.classList.toggle("is-video", isVid);
  $("#detail-dialog")?.classList.toggle("is-video", isVid);
  if (isVid) {
    setCropEnabled(false);
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    stage.style.transform = "";
    videoEl.style.width = "100%";
    videoEl.style.height = "100%";
    resetTrimTimeline(duration || 0);
    bindTrimTimeline();
    $("#viewer-hint").textContent =
      "拖动时间轴两端裁切；点轴预览当前帧，可「设为封面」；旋转后点右侧保存。";
  } else {
    videoEl.style.width = "";
    videoEl.style.height = "";
    videoEl.style.transform = "";
    const heic = isHeicName(state.currentPath || "");
    $("#viewer-hint").textContent = heic
      ? "HEIC 原件已无损保存；此处为预览图。暂不支持旋转裁剪写回（以免损伤画质）。点右侧可改信息与旁白。"
      : "滚轮缩放，按住拖动平移；开启裁剪后拖动绿色框。点右侧「保存」会一并写入信息与画面修改。";
    if (heic) {
      $("#btn-rot-left")?.setAttribute("disabled", "disabled");
      $("#btn-rot-right")?.setAttribute("disabled", "disabled");
      $("#btn-crop-toggle")?.setAttribute("disabled", "disabled");
    } else {
      $("#btn-rot-left")?.removeAttribute("disabled");
      $("#btn-rot-right")?.removeAttribute("disabled");
      $("#btn-crop-toggle")?.removeAttribute("disabled");
    }
  }
}

/* —— 沉浸式看图 lightbox —— */
const lbDialog = $("#lightbox");
const lbViewport = $("#lb-viewport");
const lbFx = $("#lb-fx");
const lbStage = $("#lb-stage");
const lbImg = $("#lb-img");
const lbVideo = $("#lb-video");
const lbLiveVideo = $("#lb-live-video");
let lbLivePath = null;
let lbLivePlaying = false;

const lb = {
  zoom: 1,
  panX: 0,
  panY: 0,
  kind: "image",
  pointers: new Map(),
  pinchStartDist: 0,
  pinchStartZoom: 1,
  pan: null,
  swipe: null,
  lastTap: 0,
  moved: false,
  playing: false,
  timer: null,
  progressRaf: null,
  progressStart: 0,
  progressMs: 0,
  lastDelta: 1,
  hasAudio: false,
  audioUrl: null,
  audioDuration: null,
  audioEl: null,
};

function lbPlaySettings() {
  let mode = localStorage.getItem("xiaoshu_lb_mode") || "fade";
  let duration = Number(localStorage.getItem("xiaoshu_lb_duration") || 3);
  let loop = localStorage.getItem("xiaoshu_lb_loop");
  let narration = localStorage.getItem("xiaoshu_lb_narration");
  if (!["fade", "slide", "zoom", "wipe", "flip", "cut"].includes(mode)) mode = "fade";
  if (![2, 3, 5, 8, 10, 15].includes(duration)) duration = 3;
  return {
    mode,
    duration,
    loop: loop == null ? true : loop === "1",
    narration: narration == null ? true : narration === "1",
  };
}

function lbSavePlaySettings() {
  const mode = $("#lb-play-mode")?.value || "fade";
  const duration = Number($("#lb-play-duration")?.value || 3);
  const loop = Boolean($("#lb-play-loop")?.checked);
  const narration = Boolean($("#lb-play-narration")?.checked);
  localStorage.setItem("xiaoshu_lb_mode", mode);
  localStorage.setItem("xiaoshu_lb_duration", String(duration));
  localStorage.setItem("xiaoshu_lb_loop", loop ? "1" : "0");
  localStorage.setItem("xiaoshu_lb_narration", narration ? "1" : "0");
  return { mode, duration, loop, narration };
}

function lbLoadPlaySettingsUI() {
  const s = lbPlaySettings();
  if ($("#lb-play-mode")) $("#lb-play-mode").value = s.mode;
  if ($("#lb-play-duration")) $("#lb-play-duration").value = String(s.duration);
  if ($("#lb-play-loop")) $("#lb-play-loop").checked = s.loop;
  if ($("#lb-play-narration")) $("#lb-play-narration").checked = s.narration;
}

function lbClearFx() {
  if (!lbFx) return;
  lbFx.className = "lb-fx";
  lbFx.style.opacity = "";
  lbFx.style.transform = "";
}

function lbFxOutClass(mode, dir) {
  if (mode === "slide") return dir > 0 ? "fx-slide-out-left" : "fx-slide-out-right";
  if (mode === "zoom") return "fx-zoom-out";
  if (mode === "wipe") return dir > 0 ? "fx-wipe-out-up" : "fx-wipe-out-down";
  if (mode === "flip") return "fx-flip-out";
  return "fx-fade-out";
}

function lbFxInClass(mode, dir) {
  if (mode === "slide") return dir > 0 ? "fx-slide-in-left" : "fx-slide-in-right";
  if (mode === "zoom") return "fx-zoom-in";
  if (mode === "wipe") return dir > 0 ? "fx-wipe-in-up" : "fx-wipe-in-down";
  if (mode === "flip") return "fx-flip-in";
  return "fx-fade-in";
}

function lbFxMs(mode) {
  if (mode === "flip" || mode === "zoom") return 480;
  if (mode === "wipe" || mode === "slide") return 420;
  return 400;
}

function lbRunFxPrep(dir) {
  const { mode } = lbPlaySettings();
  if (!lbFx || mode === "cut") {
    lbClearFx();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    lbClearFx();
    lbFx.classList.add(lbFxOutClass(mode, dir));
    const done = () => {
      lbFx.removeEventListener("animationend", done);
      resolve();
    };
    lbFx.addEventListener("animationend", done, { once: true });
    setTimeout(done, lbFxMs(mode));
  });
}

function lbRunFxIn(dir) {
  const { mode } = lbPlaySettings();
  if (!lbFx || mode === "cut") {
    lbClearFx();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    lbFx.className = "lb-fx";
    void lbFx.offsetWidth;
    lbFx.classList.add(lbFxInClass(mode, dir));
    const done = () => {
      lbFx.removeEventListener("animationend", done);
      lbClearFx();
      resolve();
    };
    lbFx.addEventListener("animationend", done, { once: true });
    setTimeout(done, lbFxMs(mode) + 40);
  });
}

function lbStopProgress() {
  if (lb.progressRaf) {
    cancelAnimationFrame(lb.progressRaf);
    lb.progressRaf = null;
  }
  const bar = $("#lb-progress-bar");
  const wrap = $("#lb-progress");
  if (bar) bar.style.width = "0%";
  wrap?.classList.add("hidden");
}

function lbStartProgress(ms) {
  lbStopProgress();
  const wrap = $("#lb-progress");
  const bar = $("#lb-progress-bar");
  if (!wrap || !bar || ms <= 0) return;
  wrap.classList.remove("hidden");
  lb.progressStart = performance.now();
  lb.progressMs = ms;
  const tick = (now) => {
    if (!lb.playing) return;
    const p = Math.min(1, (now - lb.progressStart) / lb.progressMs);
    bar.style.width = `${p * 100}%`;
    if (p < 1) lb.progressRaf = requestAnimationFrame(tick);
  };
  lb.progressRaf = requestAnimationFrame(tick);
}

function lbNarrationEl() {
  return $("#lb-narration-el");
}

function narrationFetchUrl(photoPath) {
  if (!photoPath) return "";
  return `/api/photo/audio?path=${encodeURIComponent(photoPath)}&_=${Date.now()}`;
}

const _narrEngine = { ctx: null, source: null, token: 0, unlocked: false, path: "" };

function narrationPreviewEl() {
  return $("#d-narration-audio");
}

function stopPreviewNarration() {
  const audio = narrationPreviewEl();
  if (!audio) return;
  try {
    audio.pause();
    if (Number.isFinite(audio.currentTime)) audio.currentTime = 0;
  } catch (_) {}
  if (audio._obj) {
    try {
      URL.revokeObjectURL(audio._obj);
    } catch (_) {}
    audio._obj = null;
  }
}

function lbUnlockNarration() {
  _narrEngine.unlocked = true;
  const el = lbNarrationEl();
  if (!el) return;
  el.muted = false;
  el.volume = 1;
  try {
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "true");
    el.playsInline = true;
  } catch (_) {}
  const url = lb.audioUrl || (lb.hasAudio && state.currentPath ? narrationFetchUrl(state.currentPath) : "");
  if (!url) return;
  try {
    if (el.src !== url && !String(el.src || "").includes(encodeURIComponent(state.currentPath || ""))) {
      el.src = url;
    }
    const kick = el.play();
    if (kick && kick.catch) kick.catch(() => {});
  } catch (_) {}
}

function lbHardStopHtmlAudio(el) {
  if (!el) return;
  try {
    el.onended = null;
    el.onerror = null;
    el.pause();
    el.removeAttribute("src");
    el.load();
  } catch (_) {}
}

function lbStopNarration(opts = {}) {
  const hard = Boolean(opts.hard);
  _narrEngine.token += 1;
  _narrEngine.path = "";
  if (_narrEngine.source) {
    try {
      _narrEngine.source.onended = null;
    } catch (_) {}
    try {
      _narrEngine.source.stop();
    } catch (_) {}
    try {
      _narrEngine.source.disconnect();
    } catch (_) {}
    _narrEngine.source = null;
  }
  const el = lbNarrationEl() || lb.audioEl;
  lb.audioEl = el || null;
  if (hard) {
    lbHardStopHtmlAudio(el);
    stopPreviewNarration();
  } else if (el) {
    try {
      el.onended = null;
      el.onerror = null;
      el.pause();
    } catch (_) {}
  }
}

function lbPlayNarrationNow() {
  const path = state.currentPath;
  const url = lb.audioUrl || narrationFetchUrl(path);
  if (!path || !url) return;
  const token = ++_narrEngine.token;
  _narrEngine.path = path;
  const knownMs = (Number(lb.audioDuration) || 0) * 1000;
  const { duration } = lbPlaySettings();
  const settingMs = Math.max(1, duration) * 1000;
  let advanced = false;
  stopPreviewNarration();

  const stillThisSlide = () =>
    token === _narrEngine.token &&
    lb.playing &&
    _narrEngine.path === path &&
    state.currentPath === path &&
    (state.galleryPaths || [])[state.galleryIndex] === path;

  const advance = () => {
    if (advanced || !stillThisSlide()) return;
    advanced = true;
    if (lb.timer) {
      clearTimeout(lb.timer);
      lb.timer = null;
    }
    const elNow = lbNarrationEl();
    if (elNow) elNow.onended = null;
    lbStopNarration({ hard: false });
    if (!lb.playing) return;
    lbGo(1, { autoplay: true });
  };

  const armEndWatch = (narrMs) => {
    const wait = Math.max(400, Number(narrMs) || 0);
    lbStartProgress(wait);
    if (lb.timer) clearTimeout(lb.timer);
    lb.timer = setTimeout(() => {
      if (!stillThisSlide()) return;
      advance();
    }, wait + 1200);
  };

  const el = lbNarrationEl();
  lb.audioEl = el || null;
  if (!el) {
    if (lb.timer) clearTimeout(lb.timer);
    lb.timer = setTimeout(advance, settingMs);
    lbStartProgress(settingMs);
    return;
  }
  el.muted = false;
  el.volume = 1;
  try {
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "true");
    el.playsInline = true;
  } catch (_) {}
  try {
    el.pause();
  } catch (_) {}
  el.onended = () => advance();
  el.onerror = () => {
    if (!stillThisSlide()) return;
    if (lb.timer) clearTimeout(lb.timer);
    lb.timer = setTimeout(advance, settingMs);
    lbStartProgress(settingMs);
  };
  el.src = url;
  const kick = el.play();
  if (kick && kick.catch) {
    kick.catch(() => {
      if (!stillThisSlide()) return;
      if (lb.timer) clearTimeout(lb.timer);
      lb.timer = setTimeout(advance, settingMs);
      lbStartProgress(settingMs);
    });
  }
  const applyDur = () => {
    if (!stillThisSlide()) return;
    const d = Number(el.duration);
    if (Number.isFinite(d) && d > 0) armEndWatch(d * 1000);
    else if (knownMs) armEndWatch(knownMs);
  };
  if (el.readyState >= 1) applyDur();
  else el.addEventListener("loadedmetadata", applyDur, { once: true });
  if (knownMs) lbStartProgress(knownMs);
}

function lbStopAutoplay() {
  lb.playing = false;
  if (lb.timer) {
    clearTimeout(lb.timer);
    lb.timer = null;
  }
  lbStopNarration({ hard: true });
  lbStopProgress();
  const btn = $("#lb-play");
  if (btn) {
    btn.textContent = "播放";
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("is-on");
  }
  lbDialog?.classList.remove("is-playing");
}

function lbScheduleNext() {
  if (!lb.playing) return;
  if (lb.timer) {
    clearTimeout(lb.timer);
    lb.timer = null;
  }
  lbStopNarration({ hard: false });
  const { duration, narration: playNarration } = lbPlaySettings();
  const ms = Math.max(1, duration) * 1000;

  if (lb.kind === "video" && lbVideo) {
    const advance = () => {
      lbVideo.removeEventListener("ended", advance);
      if (lb.timer) {
        clearTimeout(lb.timer);
        lb.timer = null;
      }
      if (!lb.playing) return;
      lbGo(1, { autoplay: true });
    };
    lbVideo.removeEventListener("ended", advance);
    const tryPlay = () => {
      const vidMs = (Number(lbVideo.duration) || 0) * 1000;
      // 视频：严格按视频时长（至少等 ended）；设置时长仅作下限兜底
      const wait = vidMs > 0 ? Math.max(ms, vidMs) : Math.max(ms, 8000);
      lbStartProgress(wait);
      lbVideo.play?.().catch(() => {});
      lbVideo.addEventListener("ended", advance, { once: true });
      lb.timer = setTimeout(advance, wait + 400);
    };
    if (lbVideo.readyState >= 1) tryPlay();
    else lbVideo.addEventListener("loadedmetadata", tryPlay, { once: true });
    return;
  }

  // 图片有旁白且开启「播放旁白」：等旁白播完再切
  if (playNarration && lb.hasAudio && (lb.audioUrl || state.currentPath)) {
    lbPlayNarrationNow();
    return;
  }

  lbStartProgress(ms);
  lb.timer = setTimeout(() => {
    if (!lb.playing) return;
    lbGo(1, { autoplay: true });
  }, ms);
}

function lbStartAutoplay() {
  if ((state.galleryPaths || []).length < 2) {
    alert("当前范围内不足 2 张，无法自动播放");
    return;
  }
  lb.playing = true;
  const btn = $("#lb-play");
  if (btn) {
    btn.textContent = "暂停";
    btn.setAttribute("aria-pressed", "true");
    btn.classList.add("is-on");
  }
  lbDialog?.classList.add("is-playing");
  $("#lb-play-panel")?.classList.add("hidden");
  lbResetView();
  stopPreviewNarration();
  lbUnlockNarration();
  lbScheduleNext();
}

function lbToggleAutoplay() {
  if (lb.playing) lbStopAutoplay();
  else lbStartAutoplay();
}

/** 手机浏览器的可视区域比 100vh 矮，且页面滚动后 dialog 会整框上移，顶栏被推出屏幕 */
function lbSyncFrame() {
  if (!lbDialog) return;
  if (!lbDialog.open || !isMobileClient()) {
    lbDialog.style.top = "";
    lbDialog.style.left = "";
    lbDialog.style.width = "";
    lbDialog.style.height = "";
    lbDialog.style.maxWidth = "";
    lbDialog.style.maxHeight = "";
    lbDialog.style.removeProperty("--lb-h");
    return;
  }
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const left = vv ? vv.offsetLeft : 0;
  const width = vv ? vv.width : window.innerWidth;
  const height = vv ? vv.height : window.innerHeight;
  lbDialog.style.top = `${top}px`;
  lbDialog.style.left = `${left}px`;
  lbDialog.style.width = `${width}px`;
  lbDialog.style.height = `${height}px`;
  lbDialog.style.maxWidth = `${width}px`;
  lbDialog.style.maxHeight = `${height}px`;
  lbDialog.style.setProperty("--lb-h", `${height}px`);
}

let lbViewportBound = false;
function lbBindViewport() {
  lbSyncFrame();
  if (lbViewportBound) return;
  lbViewportBound = true;
  window.visualViewport?.addEventListener("resize", lbSyncFrame);
  window.visualViewport?.addEventListener("scroll", lbSyncFrame);
  window.addEventListener("orientationchange", lbSyncFrame);
}

function lbUnbindViewport() {
  window.visualViewport?.removeEventListener("resize", lbSyncFrame);
  window.visualViewport?.removeEventListener("scroll", lbSyncFrame);
  window.removeEventListener("orientationchange", lbSyncFrame);
  lbViewportBound = false;
  if (!lbDialog) return;
  lbDialog.style.top = "";
  lbDialog.style.left = "";
  lbDialog.style.width = "";
  lbDialog.style.height = "";
  lbDialog.style.maxWidth = "";
  lbDialog.style.maxHeight = "";
  lbDialog.style.removeProperty("--lb-h");
}

function lbApplyTransform() {
  if (!lbStage) return;
  const fit = isMobileClient() && lb.zoom <= 1.01 && !lb.panX && !lb.panY;
  lbDialog?.classList.toggle("is-fit", fit);
  if (fit) {
    lbStage.style.left = "0";
    lbStage.style.top = "0";
    lbStage.style.width = "100%";
    lbStage.style.height = "100%";
    lbStage.style.transform = "none";
    return;
  }
  lbStage.style.left = "";
  lbStage.style.top = "";
  lbStage.style.width = "";
  lbStage.style.height = "";
  lbStage.style.transform = `translate(calc(-50% + ${lb.panX}px), calc(-50% + ${lb.panY}px)) scale(${lb.zoom})`;
}

function lbResetView() {
  lb.zoom = 1;
  lb.panX = 0;
  lb.panY = 0;
  lbApplyTransform();
}

function lbSetZoom(next, cx, cy) {
  if (!lbViewport || lb.kind === "video") return;
  const box = lbViewport.getBoundingClientRect();
  const centerX = cx == null ? box.width / 2 : cx - box.left;
  const centerY = cy == null ? box.height / 2 : cy - box.top;
  const prev = lb.zoom;
  const clamped = Math.min(5, Math.max(1, next));
  if (Math.abs(clamped - prev) < 0.001) return;
  const ratio = clamped / prev;
  lb.panX = (lb.panX - (centerX - box.width / 2)) * ratio + (centerX - box.width / 2);
  lb.panY = (lb.panY - (centerY - box.height / 2)) * ratio + (centerY - box.height / 2);
  lb.zoom = clamped;
  if (clamped <= 1.01) {
    lb.zoom = 1;
    lb.panX = 0;
    lb.panY = 0;
  }
  lbApplyTransform();
}

function lbDist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function lbUpdateChrome() {
  const paths = state.galleryPaths || [];
  const i = state.galleryIndex || 0;
  const path = paths[i] || "";
  const name = path.split("/").pop() || "媒体";
  $("#lb-title").textContent = name;
  $("#lb-counter").textContent = paths.length
    ? `${i + 1} / ${paths.length}`
    : "";
  const prev = $("#lb-prev");
  const next = $("#lb-next");
  if (prev) prev.disabled = i <= 0;
  if (next) next.disabled = i >= paths.length - 1;
}

async function lbShowCurrent(hintMeta = null, opts = {}) {
  const paths = state.galleryPaths || [];
  const i = Math.max(0, Math.min(state.galleryIndex || 0, paths.length - 1));
  state.galleryIndex = i;
  const path = paths[i];
  if (!path) return;
  state.currentPath = path;
  lbUpdateChrome();
  lbResetView();
  lbStopLive();
  lbStopNarration({ hard: !lb.playing });
  lb.hasAudio = false;
  lb.audioUrl = null;
  lb.audioDuration = null;

  const hint = hintMeta || {};
  const hintVid = hint.kind === "video" || isVideoName(path);
  lb.kind = hintVid ? "video" : "image";
  lbDialog?.classList.toggle("is-video", hintVid);
  lbImg.classList.toggle("hidden", lb.kind === "video");
  lbVideo.classList.toggle("hidden", lb.kind !== "video");
  $("#lb-hint").textContent = lb.playing
    ? "自动播放中 · 点「暂停」停止 ·「设置」可改模式与时长"
    : lb.kind === "video"
      ? "左右滑动翻图 · 点右上角编辑可剪辑与设封面"
      : "左右滑动翻图 · 双击放大 · 捏合 / 滚轮缩放";

  const dir = opts.dir || lb.lastDelta || 1;
  if (opts.withFx) await lbRunFxPrep(dir);

  const bust = state.thumbBust || 0;
  const previewSize = lightboxPreviewSize();
  const thumbUrl = `/api/thumb?path=${encodeURIComponent(path)}&size=${albumThumbSize()}&_=${bust}`;
  const midUrl = `/api/thumb?path=${encodeURIComponent(path)}&size=${isMobileClient() ? 480 : 640}&_=${bust}`;
  const previewUrl = `/api/preview?path=${encodeURIComponent(path)}&size=${previewSize}&_=${bust}`;
  const imgToken = (lb.imgToken = (lb.imgToken || 0) + 1);

  // 先在屏幕外解码，成功后再换到画面上。直接改 img.src 时，手机常把上一次被中断的请求当成失败。
  const applyUrl = (url) =>
    new Promise((resolve) => {
      if (!lbImg || !url) return resolve(false);
      try {
        const abs = new URL(url, location.origin).href;
        if (lbImg.src === abs && lbImg.complete && lbImg.naturalWidth > 0) {
          lbImg.style.opacity = "1";
          return resolve(true);
        }
      } catch (_) {}
      const im = new Image();
      im.onload = () => {
        if (imgToken !== lb.imgToken || state.galleryPaths[state.galleryIndex] !== path) {
          resolve(false);
          return;
        }
        lbImg.src = url;
        lbImg.style.opacity = "1";
        resolve(true);
      };
      im.onerror = () => resolve(false);
      im.src = url;
    });

  if (!hintVid) {
    lbImg.style.opacity = "0.55";
    const cached = lbPreviewCacheGet(previewUrl) || lbPreviewCacheGet(midUrl);
    if (cached) {
      lbImg.src = cached;
      lbImg.style.opacity = "1";
    } else {
      lbImg.src = thumbUrl;
    }
  }

  // 幻灯片翻页时先预取邻居，和下方解码并行
  lbPrefetchNeighbors({ deep: Boolean(lb.playing) });

  try {
    const photoPromise = api(`/api/photo?path=${encodeURIComponent(path)}`);
    const videoBindP = hintVid ? bindLightboxVideo(lbVideo, path, "album") : null;
    if (!hintVid && imgToken === lb.imgToken) {
      const sharpen = async () => {
        if (imgToken !== lb.imgToken || state.galleryPaths[state.galleryIndex] !== path) return;
        if (isMobileClient() || lbPreviewCacheGet(previewUrl)) {
          const okPrev = await applyUrl(previewUrl);
          if (okPrev) {
            lbPreviewCachePut(previewUrl);
            return;
          }
        }
        if (!lbPreviewCacheGet(midUrl)) {
          const okMid = await applyUrl(midUrl);
          if (okMid) lbPreviewCachePut(midUrl);
        }
        if (imgToken !== lb.imgToken || state.galleryPaths[state.galleryIndex] !== path) return;
        const okPrev = await applyUrl(previewUrl);
        if (okPrev) lbPreviewCachePut(previewUrl);
      };
      void sharpen();
    }

    const data = await photoPromise;
    if (state.galleryPaths[state.galleryIndex] !== path) return;

    const kind = data.kind || (isVideoName(data.name || path) ? "video" : "image");
    lb.kind = kind;
    lb.hasAudio = Boolean(data.has_audio && (data.audio_path || data.has_audio));
    lb.audioUrl = lb.hasAudio ? narrationFetchUrl(path) : null;
    lb.audioDuration = data.audio_duration != null ? Number(data.audio_duration) : null;
    lbDialog?.classList.toggle("is-video", kind === "video");
    lbImg.classList.toggle("hidden", kind === "video");
    lbVideo.classList.toggle("hidden", kind !== "video");
    $("#lb-title").textContent =
      (data.meta && data.meta.title) || data.name || path.split("/").pop();
    const fileUrl = kind === "video" ? null : `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;

    if (kind === "video") {
      lbImg.removeAttribute("src");
      lbImg.style.opacity = "";
      await (videoBindP || bindLightboxVideo(lbVideo, path, "album"));
    } else {
      setLbVideoPrep(false);
      setLbVideoModeChip(null);
      lbVideo.pause();
      lbVideo.removeAttribute("src");
      lbVideo.load();
      if (!(lbImg.complete && lbImg.naturalWidth > 0)) {
        const okMid = await applyUrl(midUrl);
        const okPrev = okMid ? true : await applyUrl(previewUrl);
        // 手机放不下单反原片，塞进图片标签会解码失败，看图只用预览档
        if (!okMid && !okPrev && !isMobileClient()) {
          const okFile = await applyUrl(fileUrl);
          if (!okFile) {
            $("#lb-title").textContent = "图片加载失败";
            lbImg.style.opacity = "1";
          }
        } else if (!okMid && !okPrev) {
          $("#lb-title").textContent = "图片加载失败";
          lbImg.style.opacity = "1";
        }
      }
      lbSetupLive(data);
    }

    if (opts.withFx) await lbRunFxIn(dir);
    else lbClearFx();
    if (lb.playing) {
      const playNarration = lbPlaySettings().narration;
      $("#lb-hint").textContent =
        playNarration && lb.hasAudio
          ? "自动播放中 · 本张按旁白时长切换"
          : "自动播放中 · 点「暂停」停止 ·「设置」可改模式与时长";
    }
    lbPrefetchNeighbors({ deep: true });
  } catch (e) {
    $("#lb-title").textContent = e.message || "加载失败";
    lbImg.style.opacity = "1";
    lbClearFx();
  }

  if (lb.playing) {
    // 幻灯片：有中图/大图任一显示即可开计时，勿死等 2.5s
    if (lb.kind !== "video" && lbImg && !(lbImg.complete && lbImg.naturalWidth > 0)) {
      await Promise.race([
        new Promise((resolve) => {
          const done = () => resolve();
          lbImg.addEventListener("load", done, { once: true });
          lbImg.addEventListener("error", done, { once: true });
        }),
        new Promise((resolve) => setTimeout(resolve, 900)),
      ]);
      if (state.galleryPaths[state.galleryIndex] !== path) return;
    }
    lbScheduleNext();
  }
}

const lbPreviewCache = new Map(); // url -> true（浏览器 HTTP 缓存已热）
function lbPreviewCachePut(url) {
  if (!url) return;
  lbPreviewCache.set(url, true);
  if (lbPreviewCache.size > 40) {
    const first = lbPreviewCache.keys().next().value;
    lbPreviewCache.delete(first);
  }
}
function lbPreviewCacheGet(url) {
  return lbPreviewCache.has(url) ? url : null;
}
function lbPreloadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    if (lbPreviewCache.has(url)) return resolve(true);
    const im = new Image();
    im.decoding = "async";
    im.onload = () => resolve(true);
    im.onerror = () => resolve(false);
    im.src = url;
  });
}

function lbPrefetchNeighbors(opts = {}) {
  const paths = state.galleryPaths || [];
  const i = state.galleryIndex || 0;
  const bust = state.thumbBust || 0;
  const deep = Boolean(opts.deep);
  const mobile = isMobileClient();
  // 手机少预取，避免 Wi‑Fi/树莓派被邻居大图占满
  const span = mobile ? (deep || lb.playing ? 1 : 0) : deep || lb.playing ? 4 : 1;
  const previewSize = lightboxPreviewSize();
  const midSize = mobile ? 480 : 640;
  const run = (idx, heavy) => {
    if (idx < 0 || idx >= paths.length) return;
    const p = paths[idx];
    if (!p) return;
    if (isVideoName(p)) {
      if (!mobile) {
        const u = mediaPlayUrl(p);
        fetch(u, { method: "GET", headers: { Range: "bytes=0-1" } }).catch(() => {});
      }
      return;
    }
    const preview = `/api/preview?path=${encodeURIComponent(p)}&size=${previewSize}&_=${bust}`;
    const mid = `/api/thumb?path=${encodeURIComponent(p)}&size=${midSize}&_=${bust}`;
    const th = `/api/thumb?path=${encodeURIComponent(p)}&size=${albumThumbSize()}&_=${bust}`;
    void lbPreloadImage(th);
    void lbPreloadImage(mid).then((ok) => {
      if (ok) lbPreviewCachePut(mid);
    });
    // 手机只预热中图；大图等真正滑到再拉
    if (heavy && !mobile) {
      void lbPreloadImage(preview).then((ok) => {
        if (ok) lbPreviewCachePut(preview);
      });
    }
  };
  if (span <= 0) return;
  if (deep || lb.playing) {
    for (let d = 1; d <= span; d++) {
      run(i + d, true);
      if (d <= (mobile ? 1 : 2)) run(i - d, false);
    }
    return;
  }
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 50));
  idle(() => {
    run(i + 1, !mobile);
    if (!mobile) run(i - 1, false);
  });
}


function downloadAlbumPath(path, source = "album") {
  if (!path) {
    alert("没有可下载的文件");
    return;
  }
  const url =
    `/api/download?path=${encodeURIComponent(path)}&source=${encodeURIComponent(source)}&t=${Date.now()}`;
  // 用隐藏 a[download] + credentials：同域 cookie 会话可带上
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  // 不设 download 属性名：由服务端 Content-Disposition 决定文件名（含中文）
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function lbDownloadCurrent() {
  const path = (state.galleryPaths || [])[state.galleryIndex] || state.currentPath;
  downloadAlbumPath(path, "album");
}

function openLightbox(path, paths = null, hintMeta = null) {
  path = canonicalizeAlbumPath(path);
  const list = (Array.isArray(paths) && paths.length ? paths.slice() : [path]).map(
    canonicalizeAlbumPath
  );
  state.galleryPaths = list;
  state.galleryIndex = list.indexOf(path);
  if (state.galleryIndex < 0) {
    state.galleryPaths = [path];
    state.galleryIndex = 0;
  }
  state.currentPath = path;
  state.editReturnPath = path;
  state.reopenLightbox = false;
  lbStopAutoplay();
  $("#lb-play-panel")?.classList.add("hidden");
  if (!lbDialog.open) lbDialog.showModal();
  lbBindViewport();
  requestAnimationFrame(() => {
    lbSyncFrame();
    requestAnimationFrame(lbSyncFrame);
  });
  lbShowCurrent(hintMeta).catch(console.error);
}

function lbGo(delta, opts = {}) {
  const paths = state.galleryPaths || [];
  if (!paths.length) return;
  let next = (state.galleryIndex || 0) + delta;
  const { loop } = lbPlaySettings();
  if (next < 0) {
    if (opts.autoplay && loop) next = paths.length - 1;
    else return;
  } else if (next >= paths.length) {
    if (opts.autoplay && loop) next = 0;
    else {
      if (opts.autoplay) lbStopAutoplay();
      return;
    }
  }
  if (lb.zoom > 1.05) lbResetView();
  lb.lastDelta = delta >= 0 ? 1 : -1;
  state.galleryIndex = next;
  if (lb.timer) {
    clearTimeout(lb.timer);
    lb.timer = null;
  }
  lbStopProgress();
  lbShowCurrent(null, {
    withFx: Boolean(opts.autoplay) || Boolean(opts.withFx),
    dir: lb.lastDelta,
  }).catch(console.error);
}

function lbOpenEdit() {
  const path = (state.galleryPaths || [])[state.galleryIndex];
  if (!path) return;
  lbStopAutoplay();
  state.reopenLightbox = true;
  const open = () => {
    openDetail(path).catch((e) => alert(e.message || e));
  };
  if (lbDialog?.open) {
    lbDialog.close();
    // Safari 在同一轮事件里关掉幻灯片再 showModal，编辑框高度会算错、下半截被裁掉
    setTimeout(open, 0);
    return;
  }
  open();
}

$("#lb-close")?.addEventListener("click", () => {
  lbStopAutoplay();
  lbVideo?.pause();
  setLbVideoPrep(false);
  setLbVideoModeChip(null);
  lbDialog?.close();
});
$("#lb-prev")?.addEventListener("click", () => {
  if (lb.playing) lbStopAutoplay();
  lbGo(-1, { withFx: true });
});
$("#lb-next")?.addEventListener("click", () => {
  if (lb.playing) lbStopAutoplay();
  lbGo(1, { withFx: true });
});
$("#lb-edit")?.addEventListener("click", () => lbOpenEdit());
$("#lb-download")?.addEventListener("click", () => lbDownloadCurrent());
$("#btn-detail-download")?.addEventListener("click", () => {
  downloadAlbumPath(state.currentPath, "album");
});
$("#lb-play")?.addEventListener("click", () => lbToggleAutoplay());
$("#lb-play-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const panel = $("#lb-play-panel");
  if (!panel) return;
  if (panel.classList.contains("hidden")) {
    lbLoadPlaySettingsUI();
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
});
$("#lb-play-panel-close")?.addEventListener("click", () => {
  lbSavePlaySettings();
  $("#lb-play-panel")?.classList.add("hidden");
  if (lb.playing) lbScheduleNext();
});
["lb-play-mode", "lb-play-duration", "lb-play-loop", "lb-play-narration"].forEach((id) => {
  $(`#${id}`)?.addEventListener("change", () => {
    lbSavePlaySettings();
    if (lb.playing) lbScheduleNext();
  });
});

lbDialog?.addEventListener("cancel", () => {
  lbStopAutoplay();
  lbVideo?.pause();
});
lbDialog?.addEventListener("close", () => {
  lbStopAutoplay();
  lbUnbindViewport();
  $("#lb-play-panel")?.classList.add("hidden");
});

document.addEventListener("keydown", (e) => {
  if (!lbDialog?.open) return;
  if ($("#detail-dialog")?.open) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (lb.playing) lbStopAutoplay();
    lbGo(-1, { withFx: true });
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (lb.playing) lbStopAutoplay();
    lbGo(1, { withFx: true });
  } else if (e.key === " " || e.code === "Space") {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) return;
    e.preventDefault();
    lbToggleAutoplay();
  }
});

lbViewport?.addEventListener(
  "wheel",
  (e) => {
    if (lb.kind === "video") return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    lbSetZoom(lb.zoom * factor, e.clientX, e.clientY);
  },
  { passive: false }
);

lbViewport?.addEventListener("pointerdown", (e) => {
  if (e.target.closest("video")) return;
  lb.moved = false;
  lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lbViewport.setPointerCapture?.(e.pointerId);
  if (lb.pointers.size === 2) {
    const pts = [...lb.pointers.values()];
    lb.pinchStartDist = lbDist(pts[0], pts[1]);
    lb.pinchStartZoom = lb.zoom;
    lb.pan = null;
    lb.swipe = null;
  } else if (lb.pointers.size === 1) {
    if (lb.zoom > 1.05) {
      lb.pan = { x: e.clientX, y: e.clientY, ox: lb.panX, oy: lb.panY };
      lbViewport.classList.add("is-panning");
    } else {
      lb.swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
    }
  }
});

lbViewport?.addEventListener("pointermove", (e) => {
  if (!lb.pointers.has(e.pointerId)) return;
  lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lb.pointers.size === 2 && lb.kind !== "video") {
    const pts = [...lb.pointers.values()];
    const d = lbDist(pts[0], pts[1]);
    if (lb.pinchStartDist > 0) {
      lbSetZoom((lb.pinchStartZoom * d) / lb.pinchStartDist, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      lb.moved = true;
    }
    return;
  }
  if (lb.pan) {
    const dx = e.clientX - lb.pan.x;
    const dy = e.clientY - lb.pan.y;
    if (Math.hypot(dx, dy) > 4) lb.moved = true;
    lb.panX = lb.pan.ox + dx;
    lb.panY = lb.pan.oy + dy;
    lbApplyTransform();
    return;
  }
  if (lb.swipe) {
    const dx = e.clientX - lb.swipe.x;
    const dy = e.clientY - lb.swipe.y;
    if (Math.hypot(dx, dy) > 8) lb.moved = true;
  }
});

function lbEndPointer(e) {
  if (!lb.pointers.has(e.pointerId)) return;
  lb.pointers.delete(e.pointerId);
  if (lb.pointers.size < 2) {
    lb.pinchStartDist = 0;
  }
  if (lb.pointers.size === 0) {
    lbViewport.classList.remove("is-panning");
    // 双击放大
    if (!lb.moved && lb.kind !== "video" && !lb.swipe?.swiped) {
      const now = Date.now();
      if (now - lb.lastTap < 320) {
        if (lb.zoom > 1.2) lbResetView();
        else lbSetZoom(2.4, e.clientX, e.clientY);
        lb.lastTap = 0;
      } else {
        lb.lastTap = now;
      }
    }
    // 滑动翻图
    if (lb.swipe && lb.zoom <= 1.05) {
      const dx = e.clientX - lb.swipe.x;
      const dy = e.clientY - lb.swipe.y;
      const dt = Date.now() - lb.swipe.t;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 800) {
        if (lb.playing) lbStopAutoplay();
        lbGo(dx < 0 ? 1 : -1, { withFx: true });
      }
    }
    lb.pan = null;
    lb.swipe = null;
  }
}

lbViewport?.addEventListener("pointerup", lbEndPointer);
lbViewport?.addEventListener("pointercancel", lbEndPointer);
lbViewport?.addEventListener("pointerleave", (e) => {
  if (lb.pointers.has(e.pointerId)) lbEndPointer(e);
});

$("#detail-dialog")?.addEventListener("close", () => {
  stopPreviewNarration();
  stopNarrationMeter();
  try {
    if (_narrationRecorder && _narrationRecorder.state !== "inactive") {
      _narrationRecorder.stop();
    }
  } catch (_) {}
  stopNarrationTracks().catch(() => {});
  lbStopNarration({ hard: true });
  if (!state.reopenLightbox) return;
  state.reopenLightbox = false;
  const path = canonicalizeAlbumPath(
    state.editReturnPath || state.currentPath || (state.galleryPaths || [])[state.galleryIndex]
  );
  if (!path) return;
  const list = (state.galleryPaths || []).map(canonicalizeAlbumPath).filter(Boolean);
  setTimeout(() => {
    openLightbox(path, list.length ? list : [path]);
  }, 0);
});

function setDetailPreview(path) {
  const rel = encodeURIComponent(path);
  const bust = Date.now();
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = `/api/preview?path=${rel}&size=640&t=${bust}`;
  };
  imgEl.src = `/api/preview?path=${rel}&size=1600&t=${bust}`;
}

async function openDetail(path, hintMeta = null) {
  const req = ++_detailReq;
  stopPreviewNarration();
  if (lb.playing) lbStopAutoplay();
  else lbStopNarration({ hard: true });
  path = canonicalizeAlbumPath(path);
  state.currentPath = path;
  state.editReturnPath = path;
  state.pendingRotate = 0;
  state.trimDirty = false;
  setCropEnabled(false);

  const hint = hintMeta || {};
  const hintIsVideo = hint.kind === "video" || isVideoName(path);
  setMediaMode(hintIsVideo ? "video" : "image", hint.duration);
  $("#detail-title").textContent = hint.title || String(path).split("/").pop() || "媒体";
  $("#d-datetime").value = toLocalInput(hint.datetime || "");
  $("#d-title").value = hint.title || "";
  $("#d-description").value = hint.description || "";
  $("#d-location").value = hint.location || "";
  updateLocationHint(hint.location || "");
  $("#detail-msg").textContent = path;
  $("#detail-dialog").showModal();

  try {
    const data = await api(`/api/photo?path=${encodeURIComponent(path)}`);
    if (req !== _detailReq || state.currentPath !== path) return;
    const m = data.meta || {};
    const kind = data.kind || (isVideoName(data.name || path) ? "video" : "image");
    setMediaMode(kind, data.duration);
    $("#detail-title").textContent = m.title || data.name;
    $("#d-datetime").value = toLocalInput(m.datetime);
    $("#d-title").value = m.title || "";
    $("#d-description").value = m.description || "";
    $("#d-location").value = m.location || hint.location || "";
    updateLocationHint($("#d-location").value);
    $("#detail-msg").textContent = path;
    updateNarrationUI(data);
    const url = kind === "video" ? null : `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    if (kind === "video") {
      await bindLightboxVideo(videoEl, path, "album");
      stage.style.transform = "";
      updateCoverHint(data.cover_time, data.has_cover);
      const onMeta = () => {
        const dur = videoEl.duration || data.duration || 0;
        state.videoDuration = dur;
        resetTrimTimeline(dur);
        videoEl.style.width = "100%";
        videoEl.style.height = "100%";
        // 若已有封面时间，跳到该帧便于对照
        const ct = Number(data.cover_time);
        if (Number.isFinite(ct) && ct >= 0) {
          try {
            videoEl.currentTime = Math.min(ct, Math.max(dur - 0.05, 0));
          } catch (_) {}
        }
        buildTrimFilmstrip().catch(() => {});
      };
      videoEl.addEventListener("loadedmetadata", onMeta, { once: true });
      if (videoEl.readyState >= 1) onMeta();
    } else {
      updateCoverHint(null, false);
      videoEl.removeAttribute("src");
      videoEl.load();
      // 统一用预览 JPEG（落盘缓存）；原件仅下载时走 /api/file
      setDetailPreview(path);
      requestAnimationFrame(() => {
        computeFit();
        applyViewerTransform();
      });
    }
  } catch (e) {
    if (req !== _detailReq) return;
    $("#detail-msg").textContent = e.message || String(e);
  }
}

let _locHintTimer = null;
async function updateLocationHint(text) {
  const el = $("#d-location-hint");
  if (!el) return;
  const q = (text || "").trim();
  if (!q) {
    el.textContent = "写到区县名可定位更准；只写省/市会落在省会或市中心。";
    return;
  }
  try {
    const r = await api(`/api/geo/resolve?q=${encodeURIComponent(q)}`);
    if (!r.ok) {
      el.textContent = "未匹配到地点库，保存后地图可能不显示该点。";
      return;
    }
    el.textContent = `将定位到${r.level_label}：${r.full_name || r.name}（${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}）`;
  } catch (_) {
    el.textContent = "写到区县名可定位更准；只写省/市会落在省会或市中心。";
  }
}

$("#d-location")?.addEventListener("input", () => {
  clearTimeout(_locHintTimer);
  _locHintTimer = setTimeout(() => updateLocationHint($("#d-location").value), 280);
});

$("#btn-rot-left").addEventListener("click", () => {
  state.pendingRotate = (state.pendingRotate - 90) % 360;
  applyViewerTransform();
});
$("#btn-rot-right").addEventListener("click", () => {
  state.pendingRotate = (state.pendingRotate + 90) % 360;
  applyViewerTransform();
});
$("#btn-v-rot-left")?.addEventListener("click", () => {
  state.pendingRotate = (state.pendingRotate - 90) % 360;
  videoEl.style.transform = `rotate(${state.pendingRotate}deg)`;
});
$("#btn-v-rot-right")?.addEventListener("click", () => {
  state.pendingRotate = (state.pendingRotate + 90) % 360;
  videoEl.style.transform = `rotate(${state.pendingRotate}deg)`;
});

function updateCoverHint(coverTime, hasCover) {
  const el = $("#cover-status");
  if (!el) return;
  if (hasCover && coverTime != null && Number.isFinite(Number(coverTime))) {
    el.textContent = `当前封面：${formatTrimTime(Number(coverTime))}`;
    el.classList.remove("hidden");
    el.classList.add("is-ok");
  } else if (hasCover) {
    el.textContent = "已设置自定义封面";
    el.classList.remove("hidden");
    el.classList.add("is-ok");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("is-ok");
  }
}

$("#btn-v-set-cover")?.addEventListener("click", async () => {
  if (!state.currentPath || state.mediaKind !== "video") return;
  const btn = $("#btn-v-set-cover");
  const t = Number(videoEl?.currentTime) || 0;
  btn.disabled = true;
  $("#detail-msg").textContent = `正在设封面（${formatTrimTime(t)}）…`;
  try {
    const r = await api(`/api/photo/cover?path=${encodeURIComponent(state.currentPath)}`, {
      method: "POST",
      body: JSON.stringify({ at_time: t }),
    });
    updateCoverHint(r.cover_time, true);
    $("#detail-msg").textContent = r.message || "封面已更新";
    state.thumbBust = Date.now();
    queueMicrotask(() => {
      loadTree().catch(console.error);
      invalidateMapData().catch(console.error);
    });
  } catch (e) {
    alert(e.message || String(e));
    $("#detail-msg").textContent = e.message || "设封面失败";
  } finally {
    btn.disabled = false;
  }
});

$("#btn-crop-toggle").addEventListener("click", () => {
  setCropEnabled(!state.cropEnabled);
});

async function saveMetaOnly(opts = {}) {
  const { refreshViews = true } = opts;
  const body = {
    datetime: fromLocalInput($("#d-datetime").value),
    title: $("#d-title").value,
    description: $("#d-description").value,
    location: $("#d-location").value,
  };
  const r = await api(`/api/photo/meta?path=${encodeURIComponent(state.currentPath)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  state.currentPath = canonicalizeAlbumPath(r.path || state.currentPath);
  state.editReturnPath = state.currentPath;
  // 同步 gallery 路径（另存后可能改名）
  if (state.galleryPaths?.length && state.galleryIndex >= 0) {
    state.galleryPaths[state.galleryIndex] = state.currentPath;
  }
  $("#detail-msg").textContent = r.message || "已保存";
  if (state.mediaKind === "video") {
    videoEl.src = mediaPlayUrl(state.currentPath);
    videoEl.load();
  } else {
    setDetailPreview(state.currentPath);
  }
  if (refreshViews) {
    // 整库扫描较慢，放到微任务后，避免卡住弹窗确认按钮
    queueMicrotask(() => {
      loadTree().catch(console.error);
      invalidateMapData().catch(console.error);
    });
  }
  return r;
}

function closeDetailAfterSave() {
  try {
    $("#save-mode-dialog")?.close();
  } catch (_) {}
  const dlg = $("#detail-dialog");
  if (dlg?.open) dlg.close();
}

function hasMediaEdits() {
  if (state.mediaKind === "video") {
    const dur = Number(state.videoDuration) || 0;
    const t0 = Number(state.trimStart) || 0;
    const t1 = Number(state.trimEnd) || dur;
    const trimmed =
      state.trimDirty || t0 > 0.05 || (dur > 0 && t1 < dur - 0.05);
    return Boolean(state.pendingRotate) || trimmed;
  }
  return Boolean(state.pendingRotate) || state.cropEnabled;
}

function syncSaveModeWarn() {
  const overwrite = document.querySelector('input[name="save-mode"]:checked')?.value === "overwrite";
  $("#save-overwrite-warn")?.classList.toggle("hidden", !overwrite);
}

document.querySelectorAll('input[name="save-mode"]').forEach((el) => {
  el.addEventListener("change", syncSaveModeWarn);
});

$("#btn-save").addEventListener("click", async () => {
  if (!state.currentPath) return;
  if (hasMediaEdits()) {
    $("#save-mode-status").textContent = "";
    syncSaveModeWarn();
    $("#save-mode-dialog").showModal();
    return;
  }
  const btn = $("#btn-save");
  btn.disabled = true;
  $("#detail-msg").textContent = "保存中…";
  try {
    await saveMetaOnly();
    closeDetailAfterSave();
  } catch (e) {
    alert(e.message);
    $("#detail-msg").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$("#btn-save-cancel").addEventListener("click", () => {
  if ($("#btn-save-confirm")?.dataset.busy === "1") return;
  $("#save-mode-dialog").close();
});

$("#btn-save-confirm").addEventListener("click", async () => {
  const btn = $("#btn-save-confirm");
  const cancel = $("#btn-save-cancel");
  const status = $("#save-mode-status");
  if (btn.dataset.busy === "1") return;

  const mode = document.querySelector('input[name="save-mode"]:checked')?.value || "save_as";
  const payload = {
    mode,
    rotate: state.pendingRotate,
    delete_old: $("#delete-old").checked,
  };
  if (state.mediaKind === "video") {
    payload.trim_start = Number(state.trimStart) || 0;
    payload.trim_end = Number(state.trimEnd) || Number(state.videoDuration) || 0;
  } else if (state.cropEnabled) {
    payload.crop = { ...state.crop };
  }

  btn.dataset.busy = "1";
  btn.disabled = true;
  cancel.disabled = true;
  status.textContent =
    state.mediaKind === "video"
      ? "正在处理视频（可能较久）…"
      : mode === "overwrite"
        ? "正在覆盖写回原图…"
        : "正在另存并写回…";

  try {
    const r = await api(`/api/photo/edit?path=${encodeURIComponent(state.currentPath)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.pendingRotate = 0;
    state.trimDirty = false;
    videoEl.style.transform = "";
    setCropEnabled(false);
    state.currentPath = canonicalizeAlbumPath(r.path || state.currentPath);
    state.thumbBust = r.thumb_bust || Date.now();
    status.textContent = "已写回，正在同步信息…";
    await saveMetaOnly({ refreshViews: false });
    if (state.mediaKind === "video") {
      videoEl.src = mediaPlayUrl(state.currentPath);
      videoEl.load();
    } else {
      setDetailPreview(state.currentPath);
    }
    $("#save-mode-dialog").close();
    $("#detail-msg").textContent = (r.message || "已保存") + "；信息已同步";
    queueMicrotask(() => {
      loadTree().catch(console.error);
      invalidateMapData().catch(console.error);
    });
    closeDetailAfterSave();
  } catch (e) {
    status.textContent = e.message || "写回失败";
    alert(e.message);
  } finally {
    btn.dataset.busy = "0";
    btn.disabled = false;
    cancel.disabled = false;
  }
});

/* Settings + theme */
function applyTheme(theme) {
  const allowed = { fresh: 1, cyber: 1 };
  const t = allowed[theme] ? theme : "fresh";
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("xiaoshu_theme", t);
  const radio = document.querySelector(`input[name="theme"][value="${t}"]`);
  if (radio) radio.checked = true;
}

applyTheme(localStorage.getItem("xiaoshu_theme") || "fresh");

function applyMapSettingsForm(cfg) {
  const sel = $("#input-map-provider");
  if (sel) {
    const v = cfg.map_provider || "auto";
    sel.value = ["auto", "amap", "offline"].includes(v) ? v : "auto";
  }
}

async function loadSettings() {
  refreshAuthSettingsUI();
  const cfg = await api("/api/config");
  const form = $("#settings-form");
  if (form?.album_root) form.album_root.value = cfg.album_root || "";
  if (form?.thumb_root) form.thumb_root.value = cfg.thumb_root || "";
  const titleInput = $("#input-album-title");
  if (titleInput) titleInput.value = cfg.album_title || "小树时光相册";
  applyBrand(cfg);
  applyMapSettingsForm(cfg);
  updateAlbumRootStatus(cfg);
  updateThumbRootStatus(cfg);
  applyTheme(localStorage.getItem("xiaoshu_theme") || "fresh");
  renderShareYearChips(cfg.album_years || []);
  if (state.me?.can_settings) {
    loadShares().catch(console.error);
    refreshIndexStatus().catch(console.error);
    refreshMapPackStatus().catch(console.error);
    api("/api/config?stats=1")
      .then((full) => {
        updateAlbumRootStatus(full);
        updateThumbRootStatus(full);
        applyMapSettingsForm(full);
      })
      .catch(console.error);
  }
}

function refreshAuthSettingsUI() {
  const me = state.me || {};
  const setup = $("#auth-setup-box");
  const admin = $("#auth-admin-box");
  const shares = $("#settings-shares");
  const indexBox = $("#settings-index");
  setup?.classList.toggle("hidden", !me.needs_setup);
  admin?.classList.toggle("hidden", !me.can_settings);
  shares?.classList.toggle("hidden", !me.can_settings);
  indexBox?.classList.toggle("hidden", !me.can_settings);
  const st = $("#auth-admin-status");
  if (st && me.can_settings) {
    st.textContent = me.is_admin
      ? `已登录超级用户：${me.username || "admin"}`
      : "请先在右上角登录超级用户";
  }
}

function passwordScore(pw) {
  const s = String(pw || "");
  let score = 0;
  if (s.length >= 8) score += 1;
  if (s.length >= 12) score += 1;
  let classes = 0;
  if (/[a-z]/.test(s)) classes += 1;
  if (/[A-Z]/.test(s)) classes += 1;
  if (/\d/.test(s)) classes += 1;
  if (/[^A-Za-z0-9]/.test(s)) classes += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  return Math.min(4, score);
}

function passwordChecks(pw, confirm) {
  const s = String(pw || "");
  const classes =
    (/[a-z]/.test(s) ? 1 : 0) +
    (/[A-Z]/.test(s) ? 1 : 0) +
    (/\d/.test(s) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(s) ? 1 : 0);
  return {
    len: s.length >= 8,
    classes: classes >= 2,
    space: s.length > 0 && s.trim() === s,
    match: s.length > 0 && s === String(confirm || ""),
  };
}

function bindPasswordField({ inputId, confirmId, meterId, rulesId }) {
  const input = $(`#${inputId}`);
  const confirm = confirmId ? $(`#${confirmId}`) : null;
  const meter = meterId ? $(`#${meterId}`) : null;
  const rules = rulesId ? $(`#${rulesId}`) : null;
  const paint = () => {
    const pw = input?.value || "";
    const checks = passwordChecks(pw, confirm?.value);
    if (meter) {
      meter.className = "";
      const lv = passwordScore(pw);
      if (pw) meter.classList.add(`lv${lv}`);
    }
    if (rules) {
      rules.querySelectorAll("[data-rule]").forEach((li) => {
        const ok = checks[li.dataset.rule];
        li.classList.toggle("ok", Boolean(ok));
        li.classList.toggle("bad", pw.length > 0 && !ok);
      });
    }
  };
  input?.addEventListener("input", paint);
  confirm?.addEventListener("input", paint);
  paint();
}

document.querySelectorAll(".pw-toggle").forEach((btn) => {
  let hideTimer = null;
  const setShown = (input, shown) => {
    input.type = shown ? "text" : "password";
    btn.setAttribute("aria-pressed", shown ? "true" : "false");
    btn.setAttribute("aria-label", shown ? "隐藏密码" : "显示密码");
    btn.title = shown ? "隐藏密码" : "显示密码";
    const open = btn.querySelector(".pw-eye-open");
    const off = btn.querySelector(".pw-eye-off");
    if (open) open.hidden = shown;
    if (off) off.hidden = !shown;
  };
  btn.addEventListener("click", () => {
    const id = btn.dataset.for;
    const input = id ? document.getElementById(id) : null;
    if (!input) return;
    const show = input.type === "password";
    clearTimeout(hideTimer);
    setShown(input, show);
    if (show) {
      // 延时自动隐藏，避免密码长时间明文
      hideTimer = setTimeout(() => {
        if (input.type === "text") setShown(input, false);
      }, 2500);
    }
  });
});

bindPasswordField({
  inputId: "auth-setup-pass",
  confirmId: "auth-setup-pass2",
  meterId: "auth-setup-meter",
  rulesId: "auth-setup-hint",
});
bindPasswordField({
  inputId: "auth-new-pass",
  confirmId: "auth-new-pass2",
  meterId: "auth-pass-meter",
  rulesId: "auth-pass-hint",
});

function renderShareYearChips(years) {
  const box = $("#share-year-chips");
  if (!box) return;
  const list = (years || []).slice().sort().reverse();
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<span class="muted">暂无年份相册</span>`;
    return;
  }
  list.forEach((y) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "share-chip" + (state.shareYears.has(y) ? " active" : "");
    b.textContent = y;
    b.dataset.year = y;
    b.addEventListener("click", () => {
      if (state.shareYears.has(y)) state.shareYears.delete(y);
      else state.shareYears.add(y);
      b.classList.toggle("active", state.shareYears.has(y));
    });
    box.appendChild(b);
  });
}

function setShareMode(mode) {
  const allowed = ["years", "media", "search"];
  state.shareMode = allowed.includes(mode) ? mode : "years";
  document.querySelectorAll("[data-share-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.shareMode === state.shareMode);
  });
  $("#share-years-box")?.classList.toggle("hidden", state.shareMode !== "years");
  $("#share-media-box")?.classList.toggle("hidden", state.shareMode !== "media");
  $("#share-search-box")?.classList.toggle("hidden", state.shareMode !== "search");
  if (state.shareMode === "media" && !state.shareMediaLoaded) {
    loadShareMediaPicker().catch(console.error);
  }
  updateShareMediaCount();
}

document.querySelectorAll("[data-share-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setShareMode(btn.dataset.shareMode));
});

function updateShareMediaCount() {
  const n = state.shareMediaPaths.size;
  const el = $("#share-media-count");
  if (el) el.textContent = `已选 ${n}`;
  const s = $("#share-search-count");
  if (s && state.shareMode === "search") {
    const hit = state.shareSearchItems.filter((p) => state.shareMediaPaths.has(p.path)).length;
    s.textContent = state.shareSearchItems.length
      ? `结果 ${state.shareSearchItems.length} · 已勾 ${hit} · 合计已选 ${n}`
      : `合计已选 ${n}`;
  }
}

function shareThumbUrl(path) {
  const size = isMobileClient() ? 120 : 160;
  return `/api/thumb?path=${encodeURIComponent(path)}&size=${size}&_=${state.thumbBust || 0}`;
}

function syncShareMediaItemActive() {
  document.querySelectorAll(".share-media-item").forEach((btn) => {
    const p = btn.dataset.path;
    btn.classList.toggle("active", Boolean(p && state.shareMediaPaths.has(p)));
  });
  updateShareMediaCount();
}

function toggleShareMediaPath(path) {
  if (!path) return;
  if (state.shareMediaPaths.has(path)) state.shareMediaPaths.delete(path);
  else state.shareMediaPaths.add(path);
  syncShareMediaItemActive();
}

function shareSelectPaths(paths, on) {
  (paths || []).forEach((p) => {
    if (!p) return;
    if (on) state.shareMediaPaths.add(p);
    else state.shareMediaPaths.delete(p);
  });
  syncShareMediaItemActive();
}

function appendShareMediaItem(grid, p) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "share-media-item" + (state.shareMediaPaths.has(p.path) ? " active" : "");
  btn.dataset.path = p.path;
  const title = (p.meta && p.meta.title) || p.name || String(p.path || "").split("/").pop();
  const vid = p.kind === "video" || isVideoName(p.path || p.name || "");
  btn.innerHTML = `<span class="share-media-inner"><img loading="lazy" decoding="async" src="${shareThumbUrl(
    p.path
  )}" alt="" />${vid ? `<i class="kind-tag">视频</i>` : ""}<span class="share-media-name">${escapeHtml(
    title
  )}</span></span>`;
  btn.addEventListener("click", () => toggleShareMediaPath(p.path));
  grid.appendChild(btn);
}

async function loadShareMediaPicker() {
  const grid = $("#share-media-grid");
  if (!grid) return;
  grid.innerHTML = `<p class="muted share-month-head">加载中…</p>`;
  state.shareMediaVisible = [];
  const outline = await api("/api/timeline/outline");
  const months = outlineMonthList(outline).slice(0, 24);
  grid.innerHTML = "";
  if (!months.length) {
    grid.innerHTML = `<p class="muted share-month-head">相册为空</p>`;
    state.shareMediaLoaded = true;
    updateShareMediaCount();
    return;
  }
  const hint = document.createElement("p");
  hint.className = "muted share-month-head";
  hint.textContent = "按月加载最近相册（可滚动加载更多月份）";
  grid.appendChild(hint);
  let mi = 0;
  const loadNextMonths = async (n = 2) => {
    for (let i = 0; i < n && mi < months.length; i += 1, mi += 1) {
      const m = months[mi];
      const head = document.createElement("div");
      head.className = "share-month-head muted";
      head.textContent = `${m.month} · ${m.photo_count} 张`;
      grid.appendChild(head);
      let offset = 0;
      let hasMore = true;
      while (hasMore && offset < 160) {
        const page = await fetchMonthPhotos(m.month, offset, 60);
        (page.photos || []).forEach((p) => {
          state.shareMediaVisible.push(p);
          appendShareMediaItem(grid, p);
        });
        hasMore = Boolean(page.has_more);
        offset = (page.offset || 0) + (page.photos || []).length;
        if (!(page.photos || []).length) break;
      }
    }
  };
  await loadNextMonths(2);
  if (mi < months.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn ghost share-month-head";
    more.textContent = "加载更多月份";
    more.addEventListener("click", async () => {
      more.disabled = true;
      await loadNextMonths(2);
      more.disabled = false;
      if (mi >= months.length) more.remove();
    });
    grid.appendChild(more);
  }
  state.shareMediaLoaded = true;
  updateShareMediaCount();
}

$("#btn-share-media-reload")?.addEventListener("click", () => {
  state.shareMediaLoaded = false;
  loadShareMediaPicker().catch((e) => alert(e.message || String(e)));
});

$("#btn-share-media-all")?.addEventListener("click", () => {
  const paths = state.shareMediaVisible.map((p) => p.path).filter(Boolean);
  if (!paths.length) return;
  const allOn = paths.every((p) => state.shareMediaPaths.has(p));
  shareSelectPaths(paths, !allOn);
});

async function runShareSearch(q, offset = 0) {
  const grid = $("#share-search-grid");
  const text = String(q || "").trim();
  if (!grid) return;
  if (!text) {
    grid.innerHTML = `<p class="muted share-month-head">输入关键词后搜索</p>`;
    state.shareSearchItems = [];
    updateShareMediaCount();
    return;
  }
  const appending = offset > 0;
  if (!appending) {
    grid.innerHTML = `<p class="muted share-month-head">搜索中…</p>`;
    state.shareSearchItems = [];
  }
  const qs = new URLSearchParams({ q: text, limit: "200", offset: String(offset) });
  const data = await api(`/api/search?${qs.toString()}`);
  const items = data.items || [];
  const total = Number(data.total || 0);
  if (!appending) {
    state.shareSearchItems = items;
    grid.innerHTML = "";
  } else {
    state.shareSearchItems = state.shareSearchItems.concat(items);
    grid.querySelector("#share-search-more")?.remove();
  }
  if (!state.shareSearchItems.length) {
    grid.innerHTML = `<p class="muted share-month-head">没有匹配「${escapeHtml(text)}」的内容</p>`;
    updateShareMediaCount();
    return;
  }
  let head = grid.querySelector(".share-month-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "share-month-head muted";
    grid.prepend(head);
  }
  const shown = state.shareSearchItems.length;
  head.textContent = `找到 ${total} 项，已显示 ${shown} 项`;
  items.forEach((p) => appendShareMediaItem(grid, p));
  if (items.length && (data.has_more || shown < total)) {
    const more = document.createElement("button");
    more.type = "button";
    more.id = "share-search-more";
    more.className = "btn ghost search-more";
    more.textContent = `加载更多（已 ${shown} / ${total}）`;
    more.addEventListener("click", () => {
      more.disabled = true;
      runShareSearch(text, shown).catch((err) => alert(err.message || err));
    });
    grid.appendChild(more);
  }
  updateShareMediaCount();
}

function bindShareSearch() {
  const run = () => {
    runShareSearch($("#share-search-q")?.value || "").catch((err) => alert(err.message || err));
  };
  $("#btn-share-search")?.addEventListener("click", run);
  $("#share-search-q")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
}
bindShareSearch();
$("#btn-share-search-all")?.addEventListener("click", () => {
  shareSelectPaths(
    state.shareSearchItems.map((p) => p.path),
    true
  );
});
$("#btn-share-search-clear")?.addEventListener("click", () => {
  shareSelectPaths(
    state.shareSearchItems.map((p) => p.path),
    false
  );
});

async function refreshIndexStatus() {
  const el = $("#index-status");
  if (!el) return;
  try {
    const s = await api("/api/index/status");
    el.textContent = s.rebuilding
      ? `正在重建… 当前 ${s.count || 0} 条`
      : `已索引 ${s.count || 0} 条` +
        (s.last_ok ? ` · 上次完成 ${s.last_ok}` : "") +
        (s.last_error ? ` · 错误：${s.last_error}` : "");
  } catch (e) {
    el.textContent = e.message || String(e);
  }
}

$("#btn-index-rebuild")?.addEventListener("click", async () => {
  const el = $("#index-status");
  const ok = window.confirm(
    "重建索引只重写数据库里的目录，不会删除或修改相册里的照片和视频。进行时浏览会变慢，可能要几分钟。确定开始？"
  );
  if (!ok) return;
  try {
    const r = await api("/api/index/rebuild", { method: "POST" });
    if (el) el.textContent = r.message || "已开始重建";
    const poll = setInterval(() => {
      refreshIndexStatus()
        .then(() => api("/api/index/status"))
        .then((s) => {
          if (!s.rebuilding) clearInterval(poll);
        })
        .catch(() => clearInterval(poll));
    }, 1500);
  } catch (e) {
    if (el) el.textContent = e.message || String(e);
  }
});

async function loadShares() {
  const list = $("#share-list");
  if (!list) return;
  const data = await api("/api/shares");
  list.innerHTML = "";
  (data.items || []).forEach((it) => {
    const card = document.createElement("div");
    card.className = "share-card";
    const mediaN = (it.media_paths || []).length;
    const scopes =
      mediaN > 0
        ? `指定 ${mediaN} 个文件`
        : (it.album_scopes || []).join(", ") || "（无范围）";
    const flags = [
      it.can_edit ? "可编辑" : "只读",
      it.can_upload ? "可入库" : null,
      it.enabled ? null : "已停用",
      it.expires_at ? `到期 ${it.expires_at}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    card.innerHTML = `
      <img loading="lazy" decoding="async" src="/api/shares/${it.id}/qr" alt="二维码" />
      <div class="share-card-meta">
        <strong>${escapeAttr(it.label || "分享")}</strong>
        <p class="muted">${escapeAttr(flags)}</p>
        <p class="muted">范围：${escapeAttr(scopes)}</p>
        <p><code>${escapeAttr(location.origin + "/?share=" + it.token)}</code></p>
        <div class="share-card-actions">
          <button type="button" class="btn ghost btn-share-copy" data-token="${escapeAttr(it.token)}">复制链接</button>
          <button type="button" class="btn ghost btn-share-toggle" data-id="${it.id}" data-enabled="${it.enabled ? 1 : 0}">${it.enabled ? "停用" : "启用"}</button>
          <button type="button" class="btn ghost btn-share-del" data-id="${it.id}">删除</button>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

$("#btn-share-create")?.addEventListener("click", async () => {
  const msg = $("#share-msg");
  const album_scopes =
    state.shareMode === "years" ? [...state.shareYears].sort() : [];
  const media_paths =
    state.shareMode === "years" ? [] : [...state.shareMediaPaths];
  if (!album_scopes.length && !media_paths.length) {
    if (msg) {
      msg.textContent =
        state.shareMode === "search"
          ? "请先搜索并勾选图片或视频"
          : state.shareMode === "media"
          ? "请至少勾选一张图片或视频"
          : "请至少选择一个年份相册";
    }
    return;
  }
  const expiresRaw = $("#share-expires")?.value;
  const expires_days =
    expiresRaw === "" || expiresRaw == null ? null : Number(expiresRaw);
  try {
    const r = await api("/api/shares", {
      method: "POST",
      body: JSON.stringify({
        label: $("#share-label")?.value || "访客分享",
        can_edit: Boolean($("#share-can-edit")?.checked),
        can_upload: Boolean($("#share-can-upload")?.checked),
        album_scopes,
        media_paths,
        expires_days:
          Number.isFinite(expires_days) && expires_days > 0
            ? expires_days
            : null,
      }),
    });
    if (msg) msg.textContent = "已生成分享";
    await loadShares();
    if (r.item?.url) {
      try {
        await navigator.clipboard.writeText(r.item.url);
        if (msg) msg.textContent = "已生成并复制链接";
      } catch (_) {}
    }
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  }
});

$("#share-list")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  try {
    if (btn.classList.contains("btn-share-copy")) {
      const url = `${location.origin}/?share=${btn.dataset.token}`;
      await navigator.clipboard.writeText(url);
      const msg = $("#share-msg");
      if (msg) msg.textContent = "链接已复制";
    } else if (btn.classList.contains("btn-share-toggle")) {
      await api(`/api/shares/${btn.dataset.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: btn.dataset.enabled !== "1" }),
      });
      await loadShares();
    } else if (btn.classList.contains("btn-share-del")) {
      if (!confirm("确定删除此分享？")) return;
      await api(`/api/shares/${btn.dataset.id}`, { method: "DELETE" });
      await loadShares();
    }
  } catch (err) {
    alert(err.message || String(err));
  }
});

$("#btn-auth-setup")?.addEventListener("click", async () => {
  const msg = $("#auth-setup-msg");
  const pw = $("#auth-setup-pass")?.value || "";
  const pw2 = $("#auth-setup-pass2")?.value || "";
  const checks = passwordChecks(pw, pw2);
  if (!checks.len || !checks.classes || !checks.space) {
    if (msg) msg.textContent = "请按规则设置密码";
    return;
  }
  if (!checks.match) {
    if (msg) msg.textContent = "两次密码不一致";
    return;
  }
  try {
    const r = await api("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({
        username: $("#auth-setup-user")?.value || "admin",
        password: pw,
      }),
    });
    applyCapabilities(r.me);
    refreshAuthSettingsUI();
    if (msg) msg.textContent = r.message || "已创建";
    await loadShares().catch(() => {});
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  }
});

$("#btn-auth-pass")?.addEventListener("click", async () => {
  const msg = $("#auth-pass-msg");
  const btn = $("#btn-auth-pass");
  const pw = $("#auth-new-pass")?.value || "";
  const pw2 = $("#auth-new-pass2")?.value || "";
  const checks = passwordChecks(pw, pw2);
  if (!checks.len || !checks.classes || !checks.space) {
    if (msg) msg.textContent = "请按规则设置新密码";
    return;
  }
  if (!checks.match) {
    if (msg) msg.textContent = "两次新密码不一致";
    return;
  }
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "正在验证并保存…";
  try {
    const r = await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        old_password: $("#auth-old-pass")?.value || "",
        new_password: pw,
      }),
    });
    if (msg) msg.textContent = r.message || "已更新";
    ["auth-old-pass", "auth-new-pass", "auth-new-pass2"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("#btn-auth-logout")?.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch (_) {}
  // 下次登录固定回时光浏览，避免恢复地图/管理页加重首屏
  localStorage.setItem("xiaoshu_section", "browse");
  localStorage.setItem("xiaoshu_view", "journey");
  location.replace("/login");
});

function applyBrand(cfg) {
  const title = (cfg && cfg.album_title) || "小树时光相册";
  const iconUrl = `${(cfg && cfg.album_icon_url) || "/api/brand/icon"}?t=${Date.now()}`;
  const h1 = $("#brand-title");
  if (h1) h1.textContent = title;
  const docTitle = $("#doc-title");
  if (docTitle) docTitle.textContent = title;
  else document.title = title;
  const icon = $("#brand-icon");
  if (icon) icon.src = iconUrl;
  const preview = $("#settings-brand-preview");
  if (preview) preview.src = iconUrl;
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) fav.href = iconUrl;
}

$("#btn-album-title-save")?.addEventListener("click", async () => {
  const msg = $("#brand-msg");
  const title = String($("#input-album-title")?.value || "").trim();
  try {
    const r = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ album_title: title || "小树时光相册" }),
    });
    applyBrand(r);
    if (msg) msg.textContent = "名称已保存";
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  }
});

$("#input-album-icon")?.addEventListener("change", async () => {
  const input = $("#input-album-icon");
  const msg = $("#brand-msg");
  const file = input?.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    if (msg) msg.textContent = "上传图标中…";
    const r = await api("/api/brand/icon", { method: "POST", body: fd });
    applyBrand({ ...r, album_title: $("#brand-title")?.textContent });
    if (msg) msg.textContent = r.message || "图标已更新";
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  } finally {
    if (input) input.value = "";
  }
});

$("#btn-album-icon-reset")?.addEventListener("click", async () => {
  const msg = $("#brand-msg");
  try {
    const r = await api("/api/brand/icon", { method: "DELETE" });
    applyBrand({ ...r, album_title: $("#input-album-title")?.value || $("#brand-title")?.textContent });
    if (msg) msg.textContent = r.message || "已恢复默认图标";
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  }
});

/* 旁白录音 */
let _narrationRecorder = null;
let _narrationChunks = [];
let _narrationStream = null;
let _narrationAudioCtx = null;
let _narrationAnalyser = null;
let _narrationRaf = null;

function updateNarrationUI(data) {
  const audio = $("#d-narration-audio");
  const btnDel = $("#btn-narration-del");
  const status = $("#narration-status");
  const block = $("#narration-block");
  stopNarrationMeter();
  block?.classList.remove("is-recording");
  $("#narration-meter")?.classList.add("hidden");
  $("#btn-narration-rec")?.classList.remove("hidden");
  $("#btn-narration-stop")?.classList.add("hidden");
  if (!audio) return;
  if (data && data.has_audio && (data.audio_path || data.has_audio)) {
    audio.classList.remove("hidden");
    btnDel?.classList.remove("hidden");
    const dur = data.audio_duration;
    status.textContent = dur
      ? `已有旁白，约 ${Number(dur).toFixed(1)} 秒`
      : "已有旁白";
    const url = narrationFetchUrl(state.currentPath);
    try {
      audio.pause();
    } catch (_) {}
    if (audio._obj) {
      try {
        URL.revokeObjectURL(audio._obj);
      } catch (_) {}
      audio._obj = null;
    }
    audio.src = url;
  } else {
    audio.removeAttribute("src");
    audio.classList.add("hidden");
    btnDel?.classList.add("hidden");
    if (status) status.textContent = "";
  }
}

$("#d-narration-audio")?.addEventListener("play", () => {
  if (lb.playing) lbStopAutoplay();
});

window.addEventListener("pagehide", () => {
  stopPreviewNarration();
  if (lb.playing) lbStopAutoplay();
  else lbStopNarration({ hard: true });
});

function stopNarrationMeter() {
  if (_narrationRaf) {
    cancelAnimationFrame(_narrationRaf);
    _narrationRaf = null;
  }
  if (_narrationAudioCtx) {
    try {
      _narrationAudioCtx.close();
    } catch (_) {}
    _narrationAudioCtx = null;
  }
  _narrationAnalyser = null;
  const canvas = $("#narration-spectrum");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  const level = $("#narration-level");
  if (level) level.textContent = "录音中";
}

function startNarrationMeter(stream) {
  stopNarrationMeter();
  const meter = $("#narration-meter");
  const canvas = $("#narration-spectrum");
  const levelEl = $("#narration-level");
  if (!meter || !canvas || !stream) return;
  meter.classList.remove("hidden");
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    _narrationAudioCtx = new AudioCtx();
    const source = _narrationAudioCtx.createMediaStreamSource(stream);
    _narrationAnalyser = _narrationAudioCtx.createAnalyser();
    _narrationAnalyser.fftSize = 256;
    _narrationAnalyser.smoothingTimeConstant = 0.72;
    source.connect(_narrationAnalyser);
  } catch (_) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const bins = new Uint8Array(_narrationAnalyser.frequencyBinCount);

  const draw = () => {
    if (!_narrationAnalyser) return;
    _narrationAnalyser.getByteFrequencyData(bins);
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8, 16, 28, 0.35)";
    ctx.fillRect(0, 0, w, h);

    const barCount = 40;
    const step = Math.max(1, Math.floor(bins.length / barCount));
    const gap = 2;
    const barW = (w - gap * (barCount - 1)) / barCount;
    let sum = 0;
    for (let i = 0; i < barCount; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) v += bins[i * step + j] || 0;
      v /= step;
      sum += v;
      const bh = Math.max(2, (v / 255) * (h - 8));
      const x = i * (barW + gap);
      const y = (h - bh) / 2;
      const grad = ctx.createLinearGradient(0, y + bh, 0, y);
      grad.addColorStop(0, "rgba(14, 159, 191, 0.55)");
      grad.addColorStop(1, "rgba(126, 231, 245, 0.95)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      const r = Math.min(3, barW / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + barW, y, x + barW, y + bh, r);
      ctx.arcTo(x + barW, y + bh, x, y + bh, r);
      ctx.arcTo(x, y + bh, x, y, r);
      ctx.arcTo(x, y, x + barW, y, r);
      ctx.closePath();
      ctx.fill();
    }
    const avg = sum / barCount / 255;
    if (levelEl) {
      if (avg < 0.04) levelEl.textContent = "几乎无声 · 请靠近麦克风";
      else if (avg < 0.12) levelEl.textContent = "音量偏小";
      else levelEl.textContent = "录音正常";
    }
    _narrationRaf = requestAnimationFrame(draw);
  };
  draw();
}

async function stopNarrationTracks() {
  stopNarrationMeter();
  if (_narrationStream) {
    _narrationStream.getTracks().forEach((t) => t.stop());
    _narrationStream = null;
  }
}

function pickNarrationMime() {
  const types = [
    "audio/mp4",
    "audio/aac",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  try {
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
  } catch (_) {}
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(fr.error || new Error("读取录音失败"));
    fr.readAsDataURL(blob);
  });
}

async function uploadNarrationBlob(path, blob, mime) {
  const name = narrationFilename(mime);
  const q = `/api/photo/audio?path=${encodeURIComponent(path)}`;
  try {
    const res = await fetch(q, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": mime || blob.type || "application/octet-stream",
        "X-Narration-Filename": name,
      },
      body: blob,
    });
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return res.json();
      return { ok: true, has_audio: true, audio_path: true, message: "旁白已保存" };
    }
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.detail || JSON.stringify(j);
    } catch (_) {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  } catch (e) {
    const data_b64 = await blobToBase64(blob);
    if (!data_b64) throw e;
    return await api(q, {
      method: "POST",
      body: JSON.stringify({ filename: name, mime: mime || "", data_b64 }),
    });
  }
}

function narrationFilename(mime) {
  const t = String(mime || "").toLowerCase();
  if (t.includes("mp4") || t.includes("aac") || t.includes("m4a")) return "narration.m4a";
  if (t.includes("mpeg") || t.includes("mp3")) return "narration.mp3";
  if (t.includes("ogg")) return "narration.ogg";
  return "narration.webm";
}

function narrationMicError(e) {
  const name = e && (e.name || e.code);
  const msg = String((e && e.message) || e || "");
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "未获得麦克风权限。请在系统设置里允许当前浏览器使用麦克风，并在弹出框点「允许」。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "没有找到麦克风";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "麦克风被其它应用占用，请关掉通话/录音后再试";
  }
  if (name === "SecurityError") {
    return "当前页面未视为安全环境，请用 https 打开并信任证书后再录音";
  }
  return msg || "无法打开麦克风";
}

$("#btn-narration-rec")?.addEventListener("click", async () => {
  const status = $("#narration-status");
  if (!state.currentPath || state.mediaKind === "video") return;
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!gum || typeof MediaRecorder === "undefined") {
    alert("当前浏览器不支持录音。iPhone 请用 Safari，并允许麦克风。");
    return;
  }
  try {
    _narrationChunks = [];
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    };
    try {
      _narrationStream = await gum(constraints);
    } catch (_) {
      _narrationStream = await gum({ audio: true });
    }
    const mime = pickNarrationMime();
    try {
      _narrationRecorder = mime
        ? new MediaRecorder(_narrationStream, { mimeType: mime })
        : new MediaRecorder(_narrationStream);
    } catch (_) {
      _narrationRecorder = new MediaRecorder(_narrationStream);
    }
    _narrationRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) _narrationChunks.push(e.data);
    };
    _narrationRecorder.onstop = () => {
      const rec = _narrationRecorder;
      const type = rec?.mimeType || mime || "audio/webm";
      _narrationRecorder = null;
      window.setTimeout(async () => {
        const blob = new Blob(_narrationChunks, { type: type || "application/octet-stream" });
        _narrationChunks = [];
        await stopNarrationTracks();
        $("#narration-block")?.classList.remove("is-recording");
        $("#narration-meter")?.classList.add("hidden");
        $("#btn-narration-rec")?.classList.remove("hidden");
        $("#btn-narration-stop")?.classList.add("hidden");
        if (!blob.size) {
          if (status) status.textContent = "没有录到声音，请多录一两秒再保存";
          return;
        }
        try {
          if (status) status.textContent = "正在保存旁白…";
          const r = await uploadNarrationBlob(state.currentPath, blob, type);
          updateNarrationUI(r);
          if (status) status.textContent = r.message || "旁白已保存";
        } catch (err) {
          if (status) status.textContent = "保存失败：" + (err.message || String(err));
        }
      }, 180);
    };
    try {
      _narrationRecorder.start(1000);
    } catch (_) {
      _narrationRecorder.start();
    }
    startNarrationMeter(_narrationStream);
    $("#narration-block")?.classList.add("is-recording");
    $("#btn-narration-rec")?.classList.add("hidden");
    $("#btn-narration-stop")?.classList.remove("hidden");
    if (status) status.textContent = "录音中…点击「停止并保存」结束";
  } catch (e) {
    await stopNarrationTracks();
    if (status) status.textContent = narrationMicError(e);
  }
});

$("#btn-narration-stop")?.addEventListener("click", () => {
  const rec = _narrationRecorder;
  if (!rec || rec.state === "inactive") return;
  try {
    rec.requestData();
  } catch (_) {}
  try {
    rec.stop();
  } catch (_) {}
});

$("#btn-narration-del")?.addEventListener("click", async () => {
  if (!state.currentPath) return;
  if (!confirm("确定删除这段旁白？")) return;
  const status = $("#narration-status");
  try {
    const r = await api(`/api/photo/audio?path=${encodeURIComponent(state.currentPath)}`, {
      method: "DELETE",
    });
    updateNarrationUI({ has_audio: false });
    if (status) status.textContent = r.message || "已删除";
  } catch (e) {
    if (status) status.textContent = e.message || String(e);
  }
});

function updateAlbumRootStatus(cfg) {
  const el = $("#album-root-status");
  if (!el || !cfg) return;
  if (!cfg.album_root) {
    el.textContent = "当前账号无权查看路径设置";
    return;
  }
  const n = cfg.album_year_count || 0;
  const years = (cfg.album_years || []).join("、") || "无";
  el.textContent = `当前生效：${cfg.album_root}\n已归档年份 ${n} 个${n ? `（${years}）` : ""}`;
}

async function applyAlbumRoot() {
  const input = $("#input-album-root") || document.querySelector('input[name="album_root"]');
  const btn = $("#btn-album-root-apply");
  const msg = $("#album-root-msg");
  if (!input) return;

  const next = String(input.value || "").trim();
  if (!next) {
    if (msg) msg.textContent = "请填写相册根目录路径";
    return;
  }

  let cfg;
  try {
    cfg = await api("/api/config?stats=1");
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    return;
  }

  const cur = cfg.album_root || "";
  const n = cfg.album_year_count || 0;
  if (next === cur) {
    if (msg) {
      msg.textContent =
        n > 0
          ? `路径未改，无需迁移（当前已有 ${n} 个年份在此目录）`
          : "路径未改；当前目录下还没有年份相册";
    }
    updateAlbumRootStatus(cfg);
    return;
  }

  const tip =
    n > 0
      ? `将把 ${n} 个年份目录：\n${(cfg.album_years || []).join("、")}\n\n从：\n${cur}\n\n搬到：\n${next}\n\n相对路径不变，缩略图可继续用。确定迁移？`
      : `将相册根目录改为：\n${next}\n\n当前没有年份目录可搬，仅更新配置。确定？`;
  if (!confirm(tip)) {
    if (msg) msg.textContent = "已取消";
    return;
  }

  if (btn) btn.disabled = true;
  if (msg) msg.textContent = n > 0 ? "正在迁移年份目录…" : "正在保存…";
  try {
    const r = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ album_root: next }),
    });
    input.value = r.album_root || next;
    updateAlbumRootStatus(r);
    const mig = r.migration || {};
    if (mig.changed && mig.moved && mig.moved.length) {
      msg.textContent = mig.message || `已迁移 ${mig.moved.length} 个年份`;
    } else if (mig.message) {
      msg.textContent = mig.message;
    } else {
      msg.textContent = r.message || "已保存";
    }
    if (mig.errors && mig.errors.length) {
      msg.textContent += `（警告：${mig.errors.join("；")}）`;
    }
    state.mapPoints = null;
    state.mapSummary = null;
    state.timelineCache = null;
    state.outlineCache = null;
    state.monthPhotoCache = {};
    state.classicState = null;
    queueMicrotask(() => {
      loadTree(true).catch(console.error);
      invalidateMapData().catch(console.error);
    });
  } catch (err) {
    if (msg) msg.textContent = err.message || String(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$("#btn-album-root-apply")?.addEventListener("click", () => {
  applyAlbumRoot().catch((e) => {
    const msg = $("#album-root-msg");
    if (msg) msg.textContent = e.message || String(e);
  });
});

function updateThumbRootStatus(cfg) {
  const el = $("#thumb-root-status");
  if (!el || !cfg) return;
  if (!cfg.thumb_root) {
    el.textContent = "当前账号无权查看路径设置";
    return;
  }
  const n = cfg.thumb_count || 0;
  const size = formatBytes(cfg.thumb_bytes || 0);
  el.textContent = `当前生效：${cfg.thumb_root}\n缓存文件 ${n} 个（约 ${size}）`;
}

async function applyThumbRoot() {
  const input = $("#input-thumb-root") || document.querySelector('input[name="thumb_root"]');
  const btn = $("#btn-thumb-root-apply");
  const msg = $("#thumb-root-msg");
  if (!input) return;

  const next = String(input.value || "").trim();
  if (!next) {
    if (msg) msg.textContent = "请填写缩略图缓存目录路径";
    return;
  }

  let cfg;
  try {
    cfg = await api("/api/config?stats=1");
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    return;
  }

  const cur = cfg.thumb_root || "";
  const n = cfg.thumb_count || 0;
  if (next === cur) {
    if (msg) {
      msg.textContent =
        n > 0
          ? `路径未改，无需迁移（当前约 ${n} 个缓存文件）`
          : "路径未改；当前目录下还没有缩略图缓存";
    }
    updateThumbRootStatus(cfg);
    return;
  }

  const tip =
    n > 0
      ? `将把约 ${n} 个缩略图（${formatBytes(cfg.thumb_bytes || 0)}）：\n\n从：\n${cur}\n\n搬到：\n${next}\n\n确定迁移？`
      : `将缩略图缓存目录改为：\n${next}\n\n当前没有缓存可搬，仅更新配置。确定？`;
  if (!confirm(tip)) {
    if (msg) msg.textContent = "已取消";
    return;
  }

  if (btn) btn.disabled = true;
  if (msg) msg.textContent = n > 0 ? "正在迁移缩略图…" : "正在保存…";
  try {
    const r = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ thumb_root: next }),
    });
    input.value = r.thumb_root || next;
    updateThumbRootStatus(r);
    const mig = r.thumb_migration || {};
    if (mig.message) {
      msg.textContent = mig.message;
    } else {
      msg.textContent = r.message || "已保存";
    }
    if (mig.errors && mig.errors.length) {
      msg.textContent += `（警告：${mig.errors.slice(0, 3).join("；")}）`;
    }
    state.thumbBust = Date.now();
  } catch (err) {
    if (msg) msg.textContent = err.message || String(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$("#btn-thumb-root-apply")?.addEventListener("click", () => {
  applyThumbRoot().catch((e) => {
    const msg = $("#thumb-root-msg");
    if (msg) msg.textContent = e.message || String(e);
  });
});

function _visitorTable(headers, rows) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  const th = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const td = (c) => {
    if (c && typeof c === "object") {
      const cls = c.action ? "visitor-td-action" : "visitor-td-ellipsis";
      const title =
        c.title != null
          ? ` title="${escapeAttr(c.title)}" data-full="${escapeAttr(c.title)}"`
          : "";
      return `<td class="${cls}"${title}>${c.html != null ? c.html : escapeHtml(c.text || "")}</td>`;
    }
    const s = String(c ?? "");
    if (s.includes("<button")) return `<td class="visitor-td-action">${s}</td>`;
    const plain = s.replace(/<[^>]*>/g, "");
    return `<td class="visitor-td-ellipsis" title="${escapeAttr(plain)}" data-full="${escapeAttr(plain)}">${s}</td>`;
  };
  const tr = rows.map((cells) => `<tr>${cells.map(td).join("")}</tr>`).join("");
  return `<table class="visitor-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function bindVisitorExpand() {
  const root = $("#manage-visitors");
  if (!root || root.dataset.expandBound === "1") return;
  root.dataset.expandBound = "1";
  root.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select, .btn")) return;
    const el = e.target.closest(
      ".visitor-td-ellipsis, .visitor-summary-note, .visitor-pie-legend-text, .visitor-stat strong"
    );
    if (!el) return;
    const willOpen = !el.classList.contains("is-open");
    root.querySelectorAll(".is-open").forEach((n) => n.classList.remove("is-open"));
    if (willOpen) el.classList.add("is-open");
  });
}

async function loadVisitorStats() {
  const box = $("#manage-visitors") || $("#visitors-page");
  if (!box || box.classList.contains("hidden")) return;
  bindVisitorExpand();
  const msg = $("#visitor-msg");
  try {
    const sumEl0 = $("#visitor-summary");
    if (sumEl0 && !sumEl0.querySelector(".visitor-stat")) {
      sumEl0.className = "visitor-summary";
      sumEl0.innerHTML = `<p class="muted">正在汇总…</p>`;
    }
    const sum = await api("/api/visitors/summary");
    const paintSummary = (uploadTotal) => {
      const sumEl = $("#visitor-summary");
      if (!sumEl) return;
      const stats = [
        ["总访问", sum.total_visits || 0],
        ["独立 IP", sum.unique_ips || 0],
        ["今日", sum.today_visits || 0],
        ["入库", uploadTotal != null ? uploadTotal : sum.ingest_count || 0],
        ["黑名单", sum.blacklist_count || 0],
      ];
      sumEl.className = "visitor-summary";
      sumEl.innerHTML =
        stats
          .map(
            ([k, v]) =>
              `<span class="visitor-stat"><em>${escapeHtml(String(k))}</em><strong>${escapeHtml(String(v))}</strong></span>`
          )
          .join("") +
        (sum.mac_note
          ? `<p class="muted visitor-summary-note">${escapeHtml(sum.mac_note)}</p>`
          : "");
    };
    paintSummary(null);
    const [cur, hist, curve, hot, bl, uploadStats, uploads] = await Promise.all([
      api("/api/visitors/current"),
      api("/api/visitors/history?limit=80"),
      api("/api/visitors/curve?days=14"),
      api("/api/visitors/hot-media?limit=20"),
      api("/api/visitors/blacklist"),
      api("/api/visitors/uploads/stats"),
      api("/api/visitors/uploads?limit=60"),
    ]);
    paintSummary(uploadStats.total || sum.ingest_count || 0);
    const pieEl = $("#visitor-upload-pie");
    const legendEl = $("#visitor-upload-legend");
    if (pieEl) renderUploadPie(pieEl, legendEl, uploadStats.items || [], uploadStats.total || 0);
    const upEl = $("#visitor-uploads");
    if (upEl) {
      upEl.innerHTML = _visitorTable(
        ["时间", "用户", "类型", "文件", "路径"],
        (uploads.items || []).map((it) => [
          escapeHtml((it.ts || "").replace("T", " ").slice(0, 19)),
          escapeHtml(it.actor_label || ""),
          escapeHtml(it.kind === "video" ? "视频" : "图片"),
          escapeHtml(it.name || it.title || "—"),
          escapeHtml(it.path || ""),
        ])
      );
    }
    const curEl = $("#visitor-current");
    if (curEl) {
      curEl.innerHTML = _visitorTable(
        ["IP", "MAC", "来源", "最近路径", "次数", "最后活跃", "操作"],
        (cur.items || []).map((it) => [
          escapeHtml(it.ip || ""),
          escapeHtml(it.mac || "—"),
          escapeHtml(it.source || ""),
          escapeHtml(it.last_path || ""),
          String(it.hits || 0),
          escapeHtml((it.last_seen || "").replace("T", " ").slice(0, 19)),
          `<button type="button" class="btn ghost btn-bl-ip" data-ip="${escapeAttr(it.ip || "")}">拉黑IP</button>`,
        ])
      );
    }
    const histEl = $("#visitor-history");
    if (histEl) {
      histEl.innerHTML = _visitorTable(
        ["时间", "IP", "MAC", "来源", "路径", "媒资"],
        (hist.items || []).map((it) => [
          escapeHtml((it.ts || "").replace("T", " ").slice(0, 19)),
          escapeHtml(it.ip || ""),
          escapeHtml(it.mac || "—"),
          escapeHtml(it.source || ""),
          escapeHtml(it.path || ""),
          escapeHtml(it.media_path || "—"),
        ])
      );
    }
    const hotEl = $("#visitor-hot");
    if (hotEl) {
      hotEl.innerHTML = _visitorTable(
        ["图片路径", "访问次数", "访客数", "最近"],
        (hot.items || []).map((it) => [
          escapeHtml(it.path || ""),
          String(it.hits || 0),
          String(it.visitors || 0),
          escapeHtml((it.last_seen || "").replace("T", " ").slice(0, 19)),
        ])
      );
    }
    const curveEl = $("#visitor-curve");
    if (curveEl) renderVisitorCurve(curveEl, curve.points || []);
    const blEl = $("#visitor-blacklist");
    if (blEl) {
      blEl.innerHTML = _visitorTable(
        ["类型", "值", "原因", "时间", "操作"],
        (bl.items || []).map((it) => [
          escapeHtml(it.kind || ""),
          escapeHtml(it.value || ""),
          escapeHtml(it.reason || "—"),
          escapeHtml((it.created_at || "").replace("T", " ").slice(0, 19)),
          `<button type="button" class="btn ghost btn-bl-del" data-id="${escapeAttr(String(it.id))}">移除</button>`,
        ])
      );
    }
    if (msg) msg.textContent = "";
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  }
}

const UPLOAD_PIE_COLORS = [
  "#0e9fbf",
  "#3d7dff",
  "#2bb673",
  "#f0a202",
  "#e4572e",
  "#7b68ee",
  "#5c6b73",
  "#d81159",
];

function smoothCurvePath(xy) {
  if (!xy.length) return "";
  if (xy.length === 1) return `M${xy[0].x.toFixed(1)},${xy[0].y.toFixed(1)}`;
  let d = `M${xy[0].x.toFixed(1)},${xy[0].y.toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i += 1) {
    const p0 = xy[i - 1] || xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderUploadPie(el, legendEl, items, total) {
  if (!el) return;
  if (!items.length || !total) {
    el.innerHTML = `<p class="muted" style="margin:0;padding:1rem 0">暂无入库记录</p>`;
    if (legendEl) legendEl.innerHTML = "";
    return;
  }
  const R = 74;
  const r = 46;
  const cx = 90;
  const cy = 90;
  let angle = -Math.PI / 2;
  const slices = [];
  items.forEach((it, i) => {
    const frac = (Number(it.count) || 0) / total;
    const sweep = Math.max(0.001, frac * Math.PI * 2);
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const x0o = cx + R * Math.cos(a0);
    const y0o = cy + R * Math.sin(a0);
    const x1o = cx + R * Math.cos(a1);
    const y1o = cy + R * Math.sin(a1);
    const x0i = cx + r * Math.cos(a1);
    const y0i = cy + r * Math.sin(a1);
    const x1i = cx + r * Math.cos(a0);
    const y1i = cy + r * Math.sin(a0);
    const color = UPLOAD_PIE_COLORS[i % UPLOAD_PIE_COLORS.length];
    const d =
      frac >= 0.999
        ? `M ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx - 0.01} ${cy - R} L ${cx - 0.01} ${cy - r} A ${r} ${r} 0 1 0 ${cx} ${cy - r} Z`
        : `M ${x0o.toFixed(2)} ${y0o.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)} L ${x0i.toFixed(2)} ${y0i.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${x1i.toFixed(2)} ${y1i.toFixed(2)} Z`;
    slices.push(
      `<path class="visitor-pie-slice" d="${d}" fill="${color}"><title>${escapeHtml(
        it.label || ""
      )}: ${it.count}（${it.share}%）</title></path>`
    );
  });
  el.innerHTML = `<svg class="visitor-pie-svg" viewBox="0 0 180 180" role="img" aria-label="入库占比">
    <defs>
      <filter id="pie-soft" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(14,159,191,0.22)"/>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${R + 6}" class="visitor-pie-halo" />
    <g filter="url(#pie-soft)">${slices.join("")}</g>
    <circle cx="${cx}" cy="${cy}" r="${r - 1}" class="visitor-pie-hole" />
    <text class="visitor-pie-center-num" x="${cx}" y="${cy - 4}" text-anchor="middle">${total}</text>
    <text class="visitor-pie-center-cap" x="${cx}" y="${cy + 14}" text-anchor="middle">项入库</text>
  </svg>`;
  if (legendEl) {
    legendEl.innerHTML = items
      .map((it, i) => {
        const color = UPLOAD_PIE_COLORS[i % UPLOAD_PIE_COLORS.length];
        const share = Math.max(0, Math.min(100, Number(it.share) || 0));
        return `<div class="visitor-pie-legend-row">
          <span class="visitor-pie-swatch" style="background:${color}"></span>
          <span class="visitor-pie-legend-text" title="${escapeAttr(`${it.label || "未知"} · ${it.count} 项（${share}%）`)}">${escapeHtml(
            it.label || "未知"
          )}</span>
          <span class="visitor-pie-legend-num">${it.count} · ${share}%</span>
          <i class="visitor-pie-legend-bar"><b style="width:${share}%;background:${color}"></b></i>
        </div>`;
      })
      .join("");
  }
}

/** 近 N 天访问：平滑曲线 + 渐变面积 */
function renderVisitorCurve(el, rawPts) {
  const pts = Array.isArray(rawPts) ? rawPts : [];
  if (!pts.length) {
    el.innerHTML = '<p class="muted" style="margin:0.5rem 0">暂无访问记录，浏览相册后会出现曲线</p>';
    return;
  }
  const maxV = Math.max(...pts.map((p) => Number(p.visits) || 0), 1);
  const w = Math.max(520, pts.length * 36);
  const h = 248;
  const padL = 36;
  const padR = 16;
  const padT = 22;
  const padB = 36;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const n = pts.length;
  const step = n > 1 ? chartW / (n - 1) : 0;
  const xy = pts.map((p, i) => {
    const v = Number(p.visits) || 0;
    const x = padL + (n === 1 ? chartW / 2 : i * step);
    const y = padT + chartH - (v / maxV) * chartH;
    return { x, y, v, day: String(p.day || ""), visitors: Number(p.visitors) || 0 };
  });
  const line = smoothCurvePath(xy);
  const base = padT + chartH;
  const areaPath =
    `${line} L${xy[xy.length - 1].x.toFixed(1)},${base.toFixed(1)} L${xy[0].x.toFixed(1)},${base.toFixed(1)} Z`;
  const labels = xy
    .map((p, i) => {
      if (n > 10 && i % 2 === 1 && i !== n - 1 && i !== 0) return "";
      const label = p.day.slice(5) || p.day;
      return `<text class="visitor-curve-label" x="${p.x.toFixed(1)}" y="${h - 10}" text-anchor="middle">${escapeHtml(label)}</text>`;
    })
    .join("");
  const yTicks = [0, Math.round(maxV / 2), maxV]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((v) => {
      const y = padT + chartH - (v / maxV) * chartH;
      return `<text class="visitor-curve-ytick" x="${padL - 8}" y="${y + 3}" text-anchor="end">${v}</text><line class="visitor-curve-grid" x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" />`;
    })
    .join("");
  const dots = xy
    .map(
      (p) =>
        `<circle class="visitor-curve-dot-halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7"/><circle class="visitor-curve-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2"><title>${escapeHtml(p.day)}：${p.v} 次 / ${p.visitors} IP</title></circle>`
    )
    .join("");
  el.innerHTML = `<svg class="visitor-curve-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="近 ${n} 天访问曲线">
    <defs>
      <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--leaf, #0e9fbf)" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="var(--leaf, #0e9fbf)" stop-opacity="0.02"/>
      </linearGradient>
      <linearGradient id="curve-stroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#5eead4"/>
        <stop offset="55%" stop-color="var(--leaf, #0e9fbf)"/>
        <stop offset="100%" stop-color="#3d7dff"/>
      </linearGradient>
    </defs>
    ${yTicks}
    <path class="visitor-curve-area" d="${areaPath}" fill="url(#curve-fill)" />
    <path class="visitor-curve-line" d="${line}" />
    ${dots}${labels}
  </svg><p class="muted visitor-curve-cap">峰值 ${maxV} 次/天 · 共 ${n} 天</p>`;
}

$("#btn-visitors-refresh")?.addEventListener("click", () => {
  loadVisitorStats().catch(console.error);
});

document.querySelectorAll("[data-bl-kind]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.blKind || "ip";
    const hidden = $("#bl-kind");
    if (hidden) hidden.value = kind;
    document.querySelectorAll("[data-bl-kind]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    const input = $("#bl-value");
    if (input) {
      input.placeholder = kind === "mac" ? "输入 MAC，如 aa:bb:cc:dd:ee:ff" : "输入 IP，如 192.168.1.8";
    }
  });
});

$("#btn-bl-add")?.addEventListener("click", async () => {
  const msg = $("#visitor-msg");
  const kind = $("#bl-kind")?.value || "ip";
  const value = String($("#bl-value")?.value || "").trim();
  const reason = String($("#bl-reason")?.value || "").trim();
  if (!value) {
    if (msg) msg.textContent = "请填写 IP 或 MAC";
    return;
  }
  try {
    await api("/api/visitors/blacklist", {
      method: "POST",
      body: JSON.stringify({ kind, value, reason }),
    });
    if ($("#bl-value")) $("#bl-value").value = "";
    if ($("#bl-reason")) $("#bl-reason").value = "";
    if (msg) msg.textContent = "已加入黑名单";
    await loadVisitorStats();
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  }
});

document.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const del = t.closest(".btn-bl-del");
  if (del) {
    const id = del.getAttribute("data-id");
    if (!id) return;
    api(`/api/visitors/blacklist/${id}`, { method: "DELETE" })
      .then(() => loadVisitorStats())
      .catch((err) => {
        const msg = $("#visitor-msg");
        if (msg) msg.textContent = err.message || String(err);
      });
    return;
  }
  const ban = t.closest(".btn-bl-ip");
  if (ban) {
    const ip = ban.getAttribute("data-ip");
    if (!ip) return;
    if (!confirm(`将 IP ${ip} 加入黑名单？`)) return;
    api("/api/visitors/blacklist", {
      method: "POST",
      body: JSON.stringify({ kind: "ip", value: ip, reason: "手动拉黑" }),
    })
      .then(() => loadVisitorStats())
      .catch((err) => {
        const msg = $("#visitor-msg");
        if (msg) msg.textContent = err.message || String(err);
      });
  }
});

$("#settings-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
});



async function refreshMapPackStatus() {
  const el = $("#map-pack-status");
  const msg = $("#map-pack-msg");
  const btn = $("#btn-map-pack-update");
  if (!el) return null;
  const st = await api("/api/map/pack");
  state.mapPack = st;
  const job = st.job || {};
  const xyz = st.xyz_count || 0;
  const mb = st.mbtiles_count || 0;
  const meta = st.meta || {};
  const built = meta.built_at || "—";
  const pref = st.map_provider_pref || "auto";
  const mode = st.provider_mode || (pref === "offline" ? "offline" : "amap");
  const modeLabel =
    mode === "amap"
      ? "高德在线"
      : pref === "offline"
        ? "离线包"
        : meta.provider || "离线包";
  const amapN = st.amap_cache_count || 0;
  let line =
    mode === "amap"
      ? `当前底图：高德 · 最高缩放 ${st.max_zoom || 18} · 已缓存 ${amapN} 张`
      : st.ready
        ? `当前底图：离线包 · XYZ ${xyz} 张` + (mb ? ` · MBTiles ${mb} 张` : "")
        : "离线包尚未就绪，请联网「更新地图包」或改回高德在线";
  if (st.size_bytes && mode === "offline") line += ` · 包 ${formatBytes(st.size_bytes)}`;
  if (pref === "offline" && mode === "offline" && !st.ready) {
    line += "\n提示：已选离线模式，但本地瓦片不足，地图可能空白";
  }
  line += `\n上次更新：${built}`;
  if (job.running) {
    const pct =
      job.total > 0 ? ` ${Math.min(100, Math.round((100 * job.done) / job.total))}%` : "";
    line += `\n进行中：${job.message || job.phase || "更新中…"}${pct}`;
    if (btn) btn.disabled = true;
  } else {
    if (btn) btn.disabled = false;
    if (job.phase === "完成" && job.message) {
      if (msg) msg.textContent = job.message;
    } else if (job.phase === "失败") {
      if (msg) msg.textContent = job.error || job.message || "更新失败";
    }
  }
  el.textContent = line;
  return st;
}

$("#btn-map-provider-save")?.addEventListener("click", async () => {
  const btn = $("#btn-map-provider-save");
  const msg = $("#map-provider-msg");
  const body = {
    map_provider: $("#input-map-provider")?.value || "auto",
  };
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "保存中…";
  try {
    const r = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    applyMapSettingsForm(r);
    state.mapProviderKey = null;
    state.mapPack = null;
    await refreshMapPackStatus();
    if (msg) {
      // 以保存的偏好为准，不用可能过期的 pack 缓存文案
      const pref = r.map_provider || body.map_provider || "auto";
      msg.textContent =
        pref === "offline"
          ? "已保存，地图使用离线包"
          : pref === "amap"
            ? "已保存，地图使用高德在线"
            : "已保存，地图自动（默认高德在线）";
    }
    // 若正在看地图，强制按新底图重载
    if (state.viewMode === "map") {
      loadMap(true).catch((e) => {
        $("#map-status").textContent = e.message || String(e);
      });
    }
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
  } finally {
    if (btn) btn.disabled = false;
  }
});

function stopMapPackPoll() {
  if (state.mapPackPoll) {
    clearInterval(state.mapPackPoll);
    state.mapPackPoll = null;
  }
}

function startMapPackPoll() {
  stopMapPackPoll();
  state.mapPackPoll = setInterval(async () => {
    try {
      const st = await refreshMapPackStatus();
      if (!st || !(st.job && st.job.running)) {
        stopMapPackPoll();
        // 更新完成后清地图图层缓存提示
        if (state.mapLayer) {
          try {
            state.mapLayer.redraw();
          } catch (_) {}
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, 1500);
}

$("#btn-map-pack-update")?.addEventListener("click", async () => {
  const btn = $("#btn-map-pack-update");
  const msg = $("#map-pack-msg");
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "开始更新…";
  try {
    const r = await api("/api/map/pack/update", {
      method: "POST",
      body: JSON.stringify({ force: false }),
    });
    if (msg) msg.textContent = r.message || "已开始更新";
    await refreshMapPackStatus();
    startMapPackPoll();
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    if (btn) btn.disabled = false;
  }
});

document.querySelectorAll('input[name="theme"]').forEach((el) => {
  el.addEventListener("change", () => applyTheme(el.value));
});

/* 回收站 */
function formatTrashTime(iso) {
  if (!iso) return "未知时间";
  const s = String(iso).replace("T", " ").replace(/\+\d{2}:\d{2}$/, "").replace(/Z$/, "");
  return s.slice(0, 19);
}

function updateTrashSelectUI() {
  const on = state.trashSelectMode;
  const n = state.trashSelected.size;
  const total = (state.trashItems || []).length;
  const allOn = on && total > 0 && n >= total;
  const btnSelect = $("#btn-trash-select");
  const btnAll = $("#btn-trash-select-all");
  const btnRestore = $("#btn-trash-restore");
  const btnPurge = $("#btn-trash-purge");
  if (btnSelect) {
    btnSelect.textContent = on ? "取消选择" : "选择";
    btnSelect.classList.toggle("is-active", on);
  }
  if (btnAll) {
    btnAll.classList.toggle("hidden", !on);
    btnAll.textContent = allOn ? "取消全选" : "全选";
    btnAll.classList.toggle("is-active", allOn);
  }
  btnRestore?.classList.toggle("hidden", !(on && n > 0));
  btnPurge?.classList.toggle("hidden", !(on && n > 0));
  if (btnRestore) btnRestore.textContent = n ? `恢复(${n})` : "恢复";
  if (btnPurge) btnPurge.textContent = n ? `彻底删除(${n})` : "彻底删除";
  $("#trash-grid")?.classList.toggle("trash-selecting", on);
  document.body.classList.toggle("trash-select-mode", on);
}

function setTrashSelectMode(on) {
  state.trashSelectMode = Boolean(on);
  if (!on) state.trashSelected.clear();
  document.querySelectorAll("#trash-grid .trash-card").forEach((c) => {
    c.classList.toggle("selectable", on);
    c.classList.toggle("selected", on && state.trashSelected.has(c.dataset.id));
  });
  updateTrashSelectUI();
}

function renderTrash(items) {
  const grid = $("#trash-grid");
  const empty = $("#trash-empty");
  if (!grid) return;
  grid.innerHTML = "";
  if (!items.length) {
    empty?.classList.remove("hidden");
    updateTrashSelectUI();
    return;
  }
  empty?.classList.add("hidden");
  items.forEach((it) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "photo-card trash-card";
    card.dataset.id = it.id;
    card.dataset.path = it.path;
    const title = it.title || it.name || "未命名";
    const isVid = it.kind === "video" || isVideoName(it.name);
    const deleted = formatTrashTime(it.deleted_at);
    const shot = formatTrashTime(it.media_datetime);
    card.innerHTML = `
      <span class="photo-check" aria-hidden="true"></span>
      ${
        isVid
          ? `<span class="media-badge media-badge-video" aria-hidden="true">视频</span>`
          : `<span class="media-badge media-badge-image" aria-hidden="true">照片</span>`
      }
      <img loading="lazy" decoding="async" src="/api/thumb?path=${encodeURIComponent(it.path)}&size=${albumThumbSize()}&_=${state.thumbBust || 0}" alt="" />
      <span class="trash-card-title">${escapeAttr(title)}</span>
      <span class="trash-card-meta muted">删于 ${escapeAttr(deleted)}</span>
      <span class="trash-card-meta muted">拍摄 ${escapeAttr(shot)}</span>`;
    card.addEventListener("click", () => {
      if (state.trashSelectMode) {
        if (state.trashSelected.has(it.id)) {
          state.trashSelected.delete(it.id);
          card.classList.remove("selected");
        } else {
          state.trashSelected.add(it.id);
          card.classList.add("selected");
        }
        updateTrashSelectUI();
        return;
      }
      openLightbox(it.path, items.map((x) => x.path));
    });
    if (state.trashSelectMode) card.classList.add("selectable");
    if (state.trashSelected.has(it.id)) card.classList.add("selected");
    grid.appendChild(card);
  });
  updateTrashSelectUI();
}

async function loadTrash() {
  const sort = ["deleted_at", "media_datetime"].includes(state.trashSort)
    ? state.trashSort
    : "deleted_at";
  state.trashSort = sort;
  localStorage.setItem("xiaoshu_trash_sort", sort);
  document.querySelectorAll('.seg[aria-label="回收站排序"] .seg-btn').forEach((b) => {
    b.classList.toggle("active", b.dataset.trashSort === sort);
  });
  const data = await api(`/api/trash?sort=${encodeURIComponent(sort)}`);
  state.trashItems = data.items || [];
  // 清掉已不存在的选中
  const alive = new Set(state.trashItems.map((x) => x.id));
  [...state.trashSelected].forEach((id) => {
    if (!alive.has(id)) state.trashSelected.delete(id);
  });
  renderTrash(state.trashItems);
}

document.querySelectorAll('.seg[aria-label="回收站排序"] .seg-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    state.trashSort = btn.dataset.trashSort;
    loadTrash().catch((e) => alert(e.message));
  });
});

$("#btn-trash-select")?.addEventListener("click", () => {
  setTrashSelectMode(!state.trashSelectMode);
});

$("#btn-trash-select-all")?.addEventListener("click", () => {
  if (!state.trashSelectMode) return;
  const items = state.trashItems || [];
  const allOn = items.length > 0 && items.every((it) => state.trashSelected.has(it.id));
  if (allOn) {
    state.trashSelected.clear();
  } else {
    items.forEach((it) => state.trashSelected.add(it.id));
  }
  document.querySelectorAll("#trash-grid .trash-card").forEach((c) => {
    c.classList.toggle("selected", state.trashSelected.has(c.dataset.id));
  });
  updateTrashSelectUI();
});

$("#btn-trash-refresh")?.addEventListener("click", () => {
  loadTrash().catch((e) => alert(e.message));
});

$("#btn-trash-restore")?.addEventListener("click", async () => {
  const ids = [...state.trashSelected];
  if (!ids.length) {
    alert("请先选择要恢复的项目");
    return;
  }
  if (!confirm(`确定恢复选中的 ${ids.length} 项？`)) return;
  try {
    const r = await api("/api/trash/restore", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    setTrashSelectMode(false);
    await loadTrash();
    await loadTree(true);
    await invalidateMapData();
    alert(r.message || "已恢复");
  } catch (e) {
    alert(e.message);
  }
});

$("#btn-trash-purge")?.addEventListener("click", async () => {
  const ids = [...state.trashSelected];
  if (!ids.length) {
    alert("请先选择要彻底删除的项目");
    return;
  }
  if (!confirm(`彻底删除后无法恢复。确定删除 ${ids.length} 项？`)) return;
  try {
    const r = await api("/api/trash/purge", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    setTrashSelectMode(false);
    await loadTrash();
    alert(r.message || "已彻底删除");
  } catch (e) {
    alert(e.message);
  }
});


/* —— 搜索模式 —— */
let searchSeq = 0;

function paintSearchHead(total, shown, kind) {
  const kindHint =
    kind === "video" ? "（仅视频）" : kind === "image" ? "（仅照片）" : "（照片+视频）";
  return `<strong>找到 ${total} 项</strong><span class="muted">已显示 ${shown} 项 ${kindHint}</span>`;
}

async function runSearch(q, offset = 0) {
  const results = $("#search-results") || $("#search-root");
  if (!results) return;
  const text = (q || "").trim();
  if (!text) {
    clearSearch();
    return;
  }
  const appending = offset > 0;
  const seq = appending ? searchSeq : ++searchSeq;
  if (state.viewMode !== "search") {
    state.viewMode = "search";
    localStorage.setItem("xiaoshu_view", "search");
    applyViewMode();
  }
  const box = $("#search-results") || results;
  if (!appending) {
    box.innerHTML = `<p class="muted">正在从索引库搜索…</p>`;
    state.searchGallery = [];
  }
  $("#btn-search-clear")?.classList.remove("hidden");
  const kind = mediaKindQuery();
  const qs = new URLSearchParams({
    q: text,
    limit: "200",
    offset: String(offset),
  });
  if (kind) qs.set("kind", kind);
  const data = await api(`/api/search?${qs.toString()}`);
  if (seq !== searchSeq) return;
  const items = data.items || [];
  const total = Number(data.total || 0);
  if (!items.length && !appending) {
    const kindLabel = kind === "video" ? "视频" : kind === "image" ? "照片" : "内容";
    box.innerHTML = `<p class="empty">没有匹配「${escapeHtml(text)}」的${kindLabel}</p>`;
    return;
  }
  if (!state.searchGallery) state.searchGallery = [];
  if (!appending) state.searchGallery.length = 0;
  items.forEach((p) => state.searchGallery.push(p.path));
  let grid = appending ? $("#search-grid") : null;
  if (!grid) {
    box.innerHTML = `<div class="search-head">${paintSearchHead(total, items.length, kind)}</div>
      <div class="photo-grid search-grid" id="search-grid"></div>`;
    grid = $("#search-grid");
  } else {
    const head = box.querySelector(".search-head");
    if (head) head.innerHTML = paintSearchHead(total, state.searchGallery.length, kind);
    box.querySelector("#search-more")?.remove();
  }
  items.forEach((p) => {
    grid.appendChild(makePhotoCard(p, state.searchGallery));
  });
  bindAlbumThumbLazy(grid);
  const shown = state.searchGallery.length;
  if (items.length && (data.has_more || shown < total)) {
    const more = document.createElement("button");
    more.type = "button";
    more.id = "search-more";
    more.className = "btn ghost search-more";
    more.textContent = `加载更多（已 ${shown} / ${total}）`;
    more.addEventListener("click", () => {
      more.disabled = true;
      runSearch(text, shown).catch((err) => alert(err.message || err));
    });
    box.appendChild(more);
  }
}

function clearSearch() {
  searchSeq += 1;
  state.searchGallery = [];
  const box = $("#search-results");
  if (box) box.innerHTML = "";
  $("#btn-search-clear")?.classList.add("hidden");
  if ($("#search-q")) $("#search-q").value = "";
}

$("#search-bar")?.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch($("#search-q")?.value || "").catch((err) => alert(err.message || err));
});
$("#btn-search-clear")?.addEventListener("click", () => clearSearch());

/* —— 存储看板 —— */
async function loadStorage(force = false) {
  const cards = $("#storage-cards");
  const msg = $("#storage-msg");
  if (!cards) return;
  if (!cards.querySelector(".storage-card")) {
    cards.innerHTML = `<p class="muted">正在读取占用…</p>`;
  }
  if (msg) msg.textContent = force ? "正在重新清点文件夹…" : "";
  const data = await api(`/api/storage${force ? "?force=1" : ""}`);
  const b = data.bytes || {};
  const d = data.disk || {};
  const c = data.counts || {};
  const pct = d.percent_used || 0;
  cards.innerHTML = `
    <div class="storage-card disk">
      <div class="storage-label">磁盘水位</div>
      <div class="storage-value">${pct}%</div>
      <div class="storage-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="muted">已用 ${formatBytes(d.used)} / ${formatBytes(d.total)} · 剩余 ${formatBytes(d.free)}</div>
    </div>
    <div class="storage-card"><div class="storage-label">相册原片</div><div class="storage-value">${formatBytes(b.album)}</div><div class="muted">${c.media || 0} 项媒资</div></div>
    <div class="storage-card"><div class="storage-label">回收站</div><div class="storage-value">${formatBytes(b.trash)}</div><div class="muted">${c.trash || 0} 项</div></div>
    <div class="storage-card"><div class="storage-label">待入库</div><div class="storage-value">${formatBytes(b.inbox)}</div></div>
    <div class="storage-card"><div class="storage-label">缩略图缓存</div><div class="storage-value">${formatBytes(b.thumbs)}</div></div>
    <div class="storage-card"><div class="storage-label">离线地图包</div><div class="storage-value">${formatBytes(b.map_pack)}</div></div>
    <div class="storage-card"><div class="storage-label">data 合计</div><div class="storage-value">${formatBytes(b.data)}</div></div>
  `;
  if (msg) msg.textContent = "";
  const dedup = $("#dedup-root");
  if (dedup && !dedup.dataset.loaded) {
    dedup.innerHTML = `<p class="muted">点「检查重复项」后，在这里列出相同内容。</p>`;
  }
  updateDedupProgress({
    hashed: (data.content_hash || {}).hashed || 0,
    total: (data.content_hash || {}).total || 0,
    missing: (data.content_hash || {}).missing || 0,
    scan: { running: false },
  });
  api("/api/dedup?limit=1")
    .then((dedup) => {
      if ($("#manage-storage")?.classList.contains("hidden")) return;
      updateDedupProgress(dedup);
    })
    .catch(() => {});
}

async function waitDedupReady(root, msg) {
  let data = await api("/api/dedup?limit=500");
  const scan = data.scan || {};
  const needs = (data.missing || 0) > 0 || data.needs_rehash || scan.running;
  if (!needs) return data;
  if (!scan.running) {
    const q = data.needs_rehash ? "?force=true" : "";
    await api(`/api/dedup/scan${q}`, { method: "POST", body: "{}" });
  }
  for (let i = 0; i < 7200; i++) {
    const st = await api("/api/dedup/scan");
    const hashed = st.hashed ?? 0;
    const total = st.total ?? hashed;
    const line = st.running
      ? `内容指纹 ${hashed} / ${total}，还在补算`
      : st.error || "指纹已更新";
    if (msg) msg.textContent = line;
    updateDedupProgress({ hashed, total, missing: st.missing || 0, scan: st });
    if (!st.running) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return api("/api/dedup?limit=500");
}

function updateDedupProgress(data) {
  const hashed = Number(data.hashed || 0);
  const total = Number(data.total || 0);
  const running = Boolean(data.scan && data.scan.running) || Number(data.missing || 0) > 0;
  const status = $("#dedup-status");
  const bar = $("#dedup-bar");
  const fill = $("#dedup-bar-fill");
  const pct = total > 0 ? Math.min(100, Math.round((hashed * 100) / total)) : 0;
  if (status) {
    status.textContent = total
      ? running
        ? `内容指纹 ${hashed} / ${total}，还在补算`
        : `内容指纹 ${hashed} / ${total}`
      : "尚未检查";
  }
  if (bar && fill) {
    bar.hidden = !total;
    fill.style.width = `${pct}%`;
  }
}

async function checkAndLoadDedup() {
  const root = $("#dedup-root");
  const msg = $("#storage-msg");
  if (!root) return;
  root.innerHTML = `<p class="muted">正在读取已入库的指纹…</p>`;
  if (msg) msg.textContent = "";
  try {
    let data = await api("/api/dedup?limit=500");
    if ((data.missing || 0) > 0 || data.needs_rehash) {
      if (!(data.scan && data.scan.running)) {
        const q = data.needs_rehash && !(data.hashed > 0) ? "?force=true" : "";
        await api(`/api/dedup/scan${q}`, { method: "POST", body: "{}" });
        data = await api("/api/dedup?limit=500");
      }
    }
    updateDedupProgress(data);
    const groupKey = (payload) =>
      (payload.groups || []).map((g) => `${g.content_hash}:${g.count}`).join("|");
    renderDedupList(data);
    let shown = groupKey(data);
    if ((data.scan && data.scan.running) || (data.missing || 0) > 0) {
      for (let i = 0; i < 7200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (!root.isConnected) return;
        data = await api("/api/dedup?limit=500");
        updateDedupProgress(data);
        const next = groupKey(data);
        const still = Boolean(data.scan && data.scan.running) || (data.missing || 0) > 0;
        if (next !== shown || !still) {
          shown = next;
          renderDedupList(data);
        }
        if (!still) break;
      }
    }
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    root.innerHTML = `<p class="empty">${escapeHtml(e.message || String(e))}</p>`;
  }
}

function renderDedupList(data) {
  const root = $("#dedup-root");
  if (!root) return;
  root.dataset.loaded = "1";
  const groups = data.groups || [];
  if (!groups.length) {
    root.innerHTML = `<p class="empty">已检查的照片里，没有压缩内容相同的重复项。</p>`;
    return;
  }
  const more = data.truncated
    ? `<p class="muted">只列出前 ${groups.length} 组，后面可能还有。</p>`
    : "";
  root.innerHTML =
    `<div class="search-head"><strong>发现 ${groups.length} 组重复</strong><span class="muted">每组勾选要保留的一份，其余移入回收站</span></div>${more}` +
    groups
      .map((g, gi) => {
        const items = g.items || [];
        const rows = items
          .map((it, ii) => {
            const id = `dedup-${gi}-${ii}`;
            const checked = ii === 0 ? "checked" : "";
            return `<label class="dedup-item">
              <input type="radio" name="dedup-g-${gi}" value="${escapeAttr(it.path)}" ${checked} />
              <span><code>${escapeHtml(it.path)}</code><br/><span class="muted">${formatBytes(it.size)} · ${escapeHtml(it.datetime || "")} · ${escapeHtml(it.title || "")}</span></span>
              <button type="button" class="btn ghost btn-dedup-open" data-path="${escapeAttr(it.path)}">查看</button>
            </label>`;
          })
          .join("");
        return `<details class="dedup-group" open>
          <summary>${items.length} 份相同 · ${escapeHtml((g.content_hash || "").slice(0, 12))}…</summary>
          <div class="dedup-list" data-group="${gi}">${rows}</div>
          <div class="dedup-actions">
            <button type="button" class="btn primary btn-dedup-resolve-one" data-group="${gi}">其余移入回收站</button>
          </div>
        </details>`;
      })
      .join("");
}

async function loadDedupList() {
  const root = $("#dedup-root");
  if (!root) return;
  root.innerHTML = `<p class="muted">加载重复项…</p>`;
  const data = await api("/api/dedup?limit=500");
  renderDedupList(data);
}

async function resolveDedupGroup(groupEl) {
  const keep = groupEl.querySelector('input[type="radio"]:checked')?.value;
  if (!keep) {
    alert("请先选择要保留的一份");
    return;
  }
  const remove = [...groupEl.querySelectorAll('input[type="radio"]')]
    .map((el) => el.value)
    .filter((p) => p && p !== keep);
  if (!remove.length) {
    alert("该组没有其它重复项");
    return;
  }
  if (!confirm(`保留：\n${keep}\n\n其余 ${remove.length} 项移入回收站？`)) return;
  const r = await api("/api/dedup/resolve", {
    method: "POST",
    body: JSON.stringify({ keep, remove }),
  });
  alert(r.message || "已处理");
  await loadDedupList();
  await loadStorage().catch(() => {});
  await loadTree(true).catch(() => {});
}

$("#dedup-root")?.addEventListener("click", (e) => {
  const openBtn = e.target.closest?.(".btn-dedup-open");
  if (openBtn) {
    const path = openBtn.dataset.path;
    if (path) openLightbox(path, [path]);
    return;
  }
  const resolveBtn = e.target.closest?.(".btn-dedup-resolve-one");
  if (resolveBtn) {
    const details = resolveBtn.closest(".dedup-group");
    const list = details?.querySelector(".dedup-list");
    if (list) resolveDedupGroup(list).catch((err) => alert(err.message || err));
  }
});

$("#btn-storage-refresh")?.addEventListener("click", () => loadStorage(true).catch((e) => alert(e.message)));
$("#btn-dedup-check")?.addEventListener("click", () => checkAndLoadDedup().catch((e) => alert(e.message)));
async function resolveAllDedup(strategy) {
  const label = strategy === "newest" ? "每组保留拍摄时间最新的一份" : "每组保留拍摄时间最早的一份";
  if (!confirm(`${label}，其余全部移入回收站。确定？`)) return;
  const msg = $("#storage-msg");
  if (msg) msg.textContent = "处理中…";
  try {
    await waitDedupReady($("#dedup-root"), msg);
    const r = await api("/api/dedup/resolve-all", {
      method: "POST",
      body: JSON.stringify({ strategy }),
    });
    if (msg) msg.textContent = r.message || "完成";
    alert(r.message || "完成");
    await loadDedupList();
    await loadStorage().catch(() => {});
    await loadTree(true).catch(() => {});
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    alert(e.message || e);
  }
}
$("#btn-dedup-resolve-oldest")?.addEventListener("click", () => resolveAllDedup("oldest"));
$("#btn-dedup-resolve-newest")?.addEventListener("click", () => resolveAllDedup("newest"));



/* —— 实况预览 —— */
function lbStopLive() {
  lbLivePlaying = false;
  if (lbLiveVideo) {
    try {
      lbLiveVideo.pause();
      lbLiveVideo.removeAttribute("src");
      lbLiveVideo.load();
    } catch (_) {}
    lbLiveVideo.classList.add("hidden");
  }
  $("#lb-live")?.classList.add("hidden");
  $("#lb-live")?.setAttribute("aria-pressed", "false");
  lbImg?.classList.remove("hidden");
}

function lbSetupLive(data) {
  lbStopLive();
  lbLivePath = data?.has_live && data?.live_video_path ? data.live_video_path : null;
  const btn = $("#lb-live");
  if (!lbLivePath || !btn) return;
  btn.classList.remove("hidden");
  btn.textContent = "实况";
}

async function lbToggleLive() {
  if (!lbLivePath || !lbLiveVideo) return;
  if (lbLivePlaying) {
    lbLiveVideo.pause();
    lbLiveVideo.classList.add("hidden");
    lbImg?.classList.remove("hidden");
    lbLivePlaying = false;
    $("#lb-live")?.setAttribute("aria-pressed", "false");
    $("#lb-live").textContent = "实况";
    return;
  }
  const url = mediaPlayUrl(lbLivePath);
  lbLiveVideo.src = url;
  lbLiveVideo.classList.remove("hidden");
  lbImg?.classList.add("hidden");
  try {
    await lbLiveVideo.play();
    lbLivePlaying = true;
    $("#lb-live")?.setAttribute("aria-pressed", "true");
    $("#lb-live").textContent = "停实况";
  } catch (e) {
    lbStopLive();
    alert("实况视频播放失败");
  }
}

$("#lb-live")?.addEventListener("click", () => lbToggleLive().catch(console.error));

// 长按缩略图也可触发挥实况：在灯箱图上按住
let _livePressTimer = null;
lbViewport?.addEventListener("pointerdown", (e) => {
  if (!lbLivePath || lb.kind === "video") return;
  if (e.button && e.button !== 0) return;
  _livePressTimer = setTimeout(() => {
    if (!lbLivePlaying) lbToggleLive().catch(console.error);
  }, 420);
});
["pointerup", "pointercancel", "pointerleave"].forEach((ev) => {
  lbViewport?.addEventListener(ev, () => {
    if (_livePressTimer) {
      clearTimeout(_livePressTimer);
      _livePressTimer = null;
    }
  });
});

/* Boot */
setupImportMobileUX();
bindMacPhotoPicker();
wireUploadQueueControls();
wireUploadHist();
wireMediaKindFilter();

async function bootAuthAndUi() {
  const params = new URLSearchParams(location.search);
  const share = params.get("share");
  if (share) {
    try {
      await api("/api/auth/share-enter", {
        method: "POST",
        body: JSON.stringify({ token: share }),
      });
      params.delete("share");
      const qs = params.toString();
      history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    } catch (e) {
      console.warn("share enter failed", e);
      alert(e.message || "分享链接无效");
      location.replace("/login");
      return;
    }
  }
  // 并行拉身份与品牌，缩短首屏等待
  const meP = api("/api/me").catch(() => null);
  const cfgP = api("/api/config").catch(() => null);
  const me = await meP;
  if (!me || me.needs_setup || !me.authenticated) {
    location.replace("/login");
    return;
  }
  applyCapabilities(me);
  const cfg = await cfgP;
  if (cfg) applyBrand(cfg);
  // 每次进入固定时光浏览（不恢复上次管理/地图页，减轻首屏卡顿感）
  state.section = "browse";
  state.viewMode = "journey";
  localStorage.setItem("xiaoshu_section", "browse");
  localStorage.setItem("xiaoshu_view", "journey");
  applySection();
  loadBrowse().catch(console.error);
}

bootAuthAndUi().catch(console.error);
