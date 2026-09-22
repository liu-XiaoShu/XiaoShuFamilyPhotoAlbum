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
  thumbBust: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  naturalW: 0,
  naturalH: 0,
  fitScale: 1,
  crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
  viewMode: (() => {
    const v = localStorage.getItem("xiaoshu_view") || "journey";
    if (v === "tree") {
      localStorage.setItem("xiaoshu_view", "journey");
      localStorage.setItem("xiaoshu_section", "manage");
      localStorage.setItem("xiaoshu_manage", "album");
      return "journey";
    }
    return ["journey", "classic", "map"].includes(v) ? v : "journey";
  })(),
  section: (() => {
    const s = localStorage.getItem("xiaoshu_section") || "browse";
    return s === "manage" ? "manage" : "browse";
  })(),
  manageTab: (() => {
    const m = localStorage.getItem("xiaoshu_manage") || "album";
    return ["album", "import", "trash", "settings", "about"].includes(m) ? m : "album";
  })(),
  trashSort: localStorage.getItem("xiaoshu_trash_sort") || "deleted_at",
  trashSelectMode: false,
  trashSelected: new Set(),
  trashItems: [],
  me: null,
  timelineCache: null,
  shareMode: "years",
  shareYears: new Set(),
  shareMediaPaths: new Set(),
  shareMediaLoaded: false,
  selectMode: false,
  selectScope: null,
  selectedPaths: new Set(),
  batchTarget: null,
  map: null,
  mapLayer: null,
  mapMarkers: null,
  mapProviderKey: "",
  mapPoints: null,
  mapPackPoll: null,
};

async function api(url, options = {}) {
  const opts = { ...options };
  const headers = { ...(opts.headers || {}) };
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (!isForm && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  opts.headers = headers;
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
  $("#manage-about")?.classList.toggle("hidden", tab !== "about");
  if (tab !== "album" && state.selectMode) setSelectMode(false);
  if (tab !== "trash" && state.trashSelectMode) setTrashSelectMode(false);
  if (tab === "album") loadTree().catch(console.error);
  if (tab === "import") loadImport().catch(console.error);
  if (tab === "trash") loadTrash().catch(console.error);
  if (tab === "settings") loadSettings().catch(console.error);
}

function manageTabsAllowed() {
  const me = state.me || {};
  const tabs = ["album"];
  if (me.can_upload || me.open_mode) tabs.push("import");
  if (me.can_trash || me.open_mode) tabs.push("trash");
  if (me.can_settings || me.open_mode || me.needs_setup) tabs.push("settings");
  // 登录后均可看关于（含分享访客）
  if (me.authenticated || me.open_mode) tabs.push("about");
  return tabs;
}

function applyCapabilities(me) {
  state.me = me || state.me || {};
  const m = state.me;
  document.body.classList.toggle("cap-no-edit", !(m.can_edit || m.open_mode));
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
    if (state.section === "browse") loadTree().catch(console.error);
  });
});

document.querySelectorAll('.seg[aria-label="管理功能"] .seg-btn').forEach((btn) => {
  btn.addEventListener("click", () => {
    state.manageTab = btn.dataset.manage;
    applyManageTab();
  });
});

/* Timeline / 浏览模式 */
function applyViewMode() {
  if (!["journey", "classic", "map"].includes(state.viewMode)) {
    state.viewMode = "journey";
  }
  const journey = $("#journey-root");
  const classic = $("#classic-root");
  const mapRoot = $("#map-root");
  document.querySelectorAll('.seg[aria-label="浏览模式"] .seg-btn').forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.viewMode);
  });
  journey?.classList.add("hidden");
  classic?.classList.add("hidden");
  mapRoot?.classList.add("hidden");
  const empty = !(state.timelineCache?.years?.length);
  if (empty) {
    $("#browse-empty")?.classList.remove("hidden");
    updateSelectUI();
    return;
  }
  $("#browse-empty")?.classList.add("hidden");
  if (state.viewMode === "journey") {
    journey?.classList.remove("hidden");
  } else if (state.viewMode === "classic") {
    classic?.classList.remove("hidden");
  } else if (state.viewMode === "map") {
    mapRoot?.classList.remove("hidden");
    loadMap(true).catch((e) => {
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

function renderClassic(data) {
  const root = $("#classic-root");
  if (!root) return;
  root.innerHTML = "";
  const photos = flattenTimelinePhotos(data);
  if (!photos.length) return;

  const allPaths = photos.map((p) => p.path);
  state.classicPaths = allPaths;

  // 按拍摄日分组（已按时间轴新→旧）
  const groups = [];
  let cur = null;
  photos.forEach((p) => {
    const day = ((p.meta && p.meta.datetime) || "").slice(0, 10) || "未知日期";
    if (!cur || cur.day !== day) {
      cur = { day, photos: [] };
      groups.push(cur);
    }
    cur.photos.push(p);
  });

  const head = document.createElement("div");
  head.className = "classic-toolbar";
  head.innerHTML = `<span class="classic-total">共 ${photos.length} 张 · 点击即可沉浸翻看</span>`;
  root.appendChild(head);

  groups.forEach((g) => {
    const section = document.createElement("section");
    section.className = "classic-day";
    const h = document.createElement("header");
    h.className = "classic-day-head";
    h.innerHTML = `<strong>${formatClassicDay(g.day)}</strong><span class="muted">${g.photos.length} 张</span>`;
    const grid = document.createElement("div");
    grid.className = "classic-grid";
    g.photos.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "classic-cell";
      btn.dataset.path = p.path;
      const title = (p.meta && p.meta.title) || p.name || "";
      const isVid = p.kind === "video" || isVideoName(p.name);
      btn.title = title;
      btn.innerHTML = `
        ${isVid ? `<span class="classic-vid" aria-hidden="true">▶</span>` : ""}
        <img loading="lazy" decoding="async" alt="${escapeAttr(title)}"
          src="/api/thumb?path=${encodeURIComponent(p.path)}&size=400&_=${state.thumbBust || 0}" />`;
      btn.addEventListener("click", () => openLightbox(p.path, allPaths, p.meta || null));
      grid.appendChild(btn);
    });
    section.appendChild(h);
    section.appendChild(grid);
    root.appendChild(section);
  });
}

function buildMonthSelectBar(monthKey, photoPaths) {
  const bar = document.createElement("div");
  bar.className = "album-select-bar";
  bar.innerHTML = `
    <button type="button" class="btn ghost btn-scope-select">选择</button>
    <button type="button" class="btn ghost btn-scope-batch hidden">批量编辑</button>
    <button type="button" class="btn ghost btn-scope-trash hidden">移入回收站</button>`;
  const btnSelect = bar.querySelector(".btn-scope-select");
  const btnBatch = bar.querySelector(".btn-scope-batch");
  const btnTrash = bar.querySelector(".btn-scope-trash");
  btnSelect.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.selectMode && state.selectScope === monthKey) {
      setSelectMode(false);
      return;
    }
    setSelectMode(true, monthKey, photoPaths);
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
  await loadTree();
  await invalidateMapData();
  alert(r.message || "已移入回收站");
}


function journeyTitleFreqBrief(photos) {
  /** 当前年范围内，相册简述（title）里高频出现的完整简介 */
  const freq = new Map();
  for (const p of photos || []) {
    const title = String((p.meta && p.meta.title) || "").trim();
    if (!title) continue;
    freq.set(title, (freq.get(title) || 0) + 1);
  }
  if (!freq.size) return "这一年还在生长。";

  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .slice(0, 5)
    .map(([title]) => title);
  return `代表瞬间：${ranked.join(" · ")}`;
}

function renderJourney(data) {
  const root = $("#journey-root");
  root.innerHTML = "";
  const rail = document.createElement("div");
  rail.className = "journey-rail";
  const shaft = document.createElement("div");
  shaft.className = "journey-shaft";
  const head = document.createElement("div");
  head.className = "journey-head";
  rail.appendChild(shaft);
  rail.appendChild(head);

  data.years.forEach((y) => {
    const albums = y.months.length;
    const yearPhotos = y.months.flatMap((m) => m.photos || []);
    const imageCount = yearPhotos.filter((p) => p.kind !== "video").length;
    const videoCount = yearPhotos.filter((p) => p.kind === "video").length;
    const brief = journeyTitleFreqBrief(yearPhotos);

    const item = document.createElement("div");
    item.className = "journey-item";
    item.dataset.year = y.year;

    const dot = document.createElement("span");
    dot.className = "journey-dot";
    dot.setAttribute("aria-hidden", "true");

    const node = document.createElement("button");
    node.type = "button";
    node.className = "journey-node";
    const videoStat =
      videoCount > 0
        ? `<span>视频 <strong>${videoCount}</strong> 条</span>`
        : "";
    node.innerHTML = `
      <div class="journey-year">${y.year}</div>
      <div class="journey-stats">
        <span>相册 <strong>${albums}</strong> 册</span>
        <span>照片 <strong>${imageCount}</strong> 张</span>
        ${videoStat}
      </div>
      <p class="journey-brief">${escapeAttr(brief)}</p>`;

    const albumsBox = document.createElement("div");
    albumsBox.className = "journey-albums";
    y.months.forEach((m) => {
      const albumBtn = document.createElement("button");
      albumBtn.type = "button";
      albumBtn.className = "journey-album";
      const monthLabel = m.month;
      const mPhotos = m.photos || [];
      const mImg = mPhotos.filter((p) => p.kind !== "video").length;
      const mVid = mPhotos.filter((p) => p.kind === "video").length;
      const metaBits = [`${mImg} 张`];
      if (mVid) metaBits.push(`${mVid} 条视频`);
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
  await loadTree();
  const yearEl = [...($("#tree-root")?.querySelectorAll(".year") || [])].find((el) =>
    (el.querySelector("summary")?.textContent || "").startsWith(String(year))
  );
  if (!yearEl) return;
  yearEl.open = true;
  const monthEl = [...yearEl.querySelectorAll(".month")].find((el) =>
    (el.querySelector("summary")?.textContent || "").startsWith(String(month))
  );
  if (monthEl) monthEl.open = true;
  (monthEl || yearEl).scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadTree() {
  const data = await api("/api/timeline");
  state.timelineCache = data;
  const root = $("#tree-root");
  const treeEmpty = $("#tree-empty");
  const browseEmpty = $("#browse-empty");
  if (root) root.innerHTML = "";
  if (!data.years.length) {
    treeEmpty?.classList.remove("hidden");
    browseEmpty?.classList.remove("hidden");
    $("#journey-root")?.classList.add("hidden");
    $("#classic-root")?.classList.add("hidden");
    $("#map-root")?.classList.add("hidden");
    return;
  }
  treeEmpty?.classList.add("hidden");
  browseEmpty?.classList.add("hidden");

  data.years.forEach((y, yi) => {
    const yearEl = document.createElement("details");
    yearEl.className = "year";
    yearEl.dataset.scopeKey = `year:${y.year}`;
    if (yi === 0) yearEl.open = true;
    const count = y.months.reduce((n, m) => n + m.photos.length, 0);
    const yearPaths = y.months.flatMap((m) => m.photos.map((p) => p.path));
    const yearSummary = document.createElement("summary");
    yearSummary.innerHTML = `<span>${y.year}<span class="muted"> · ${count} 张</span></span>`;
    yearSummary.appendChild(buildMonthSelectBar(`year:${y.year}`, yearPaths));
    yearEl.appendChild(yearSummary);
    const body = document.createElement("div");
    body.className = "year-body months";

    y.months.forEach((m, mi) => {
      const monthEl = document.createElement("details");
      monthEl.className = "month";
      monthEl.dataset.scopeKey = `month:${m.month}`;
      if (yi === 0 && mi === 0) monthEl.open = true;
      const monthSummary = document.createElement("summary");
      monthSummary.innerHTML = `<span>${m.month}<span class="muted"> · ${m.photos.length} 张</span></span>`;
      const paths = m.photos.map((p) => p.path);
      monthSummary.appendChild(buildMonthSelectBar(`month:${m.month}`, paths));
      monthEl.appendChild(monthSummary);
      const grid = document.createElement("div");
      grid.className = "month-body photo-grid";
      m.photos.forEach((p) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "photo-card";
        card.dataset.path = p.path;
        const title = (p.meta && p.meta.title) || p.name;
        const isVid = p.kind === "video" || isVideoName(p.name);
        card.innerHTML = `
          <span class="photo-check" aria-hidden="true"></span>
          ${isVid ? `<span class="media-badge" aria-hidden="true">▶</span>` : ""}
          <img loading="lazy" src="/api/thumb?path=${encodeURIComponent(p.path)}&_=${state.thumbBust || 0}" alt="" />
          <span>${title}</span>`;
        card.addEventListener("click", (e) => {
          if (state.selectMode) {
            e.preventDefault();
            if (state.selectPathsSet && !state.selectPathsSet.has(p.path)) return;
            toggleSelectPath(p.path, card);
            return;
          }
          openLightbox(p.path, paths);
        });
        if (state.selectedPaths.has(p.path)) card.classList.add("selected");
        grid.appendChild(card);
      });
      monthEl.appendChild(grid);
      body.appendChild(monthEl);
    });
    yearEl.appendChild(body);
    root?.appendChild(yearEl);
  });
  renderJourney(data);
  renderClassic(data);
  if (state.section === "browse") applyViewMode();
  else updateSelectUI();
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

/* Map — 苹果相册「地点」式：离线标准底图 + 元数据聚点 + 点击展开 */
function ensureMap() {
  const want = "offline:xyz";
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
    maxZoom: 12,
    // 减少拖动时的重绘压力
    fadeAnimation: false,
    zoomAnimation: true,
    markerZoomAnimation: false,
  });
  // 静态 XYZ 目录直出，不经 SQLite（z9–12 支持市/县级）
  state.mapLayer = L.tileLayer("/map-tiles/{z}/{x}/{y}.png", {
    maxZoom: 12,
    minZoom: 2,
    maxNativeZoom: 12,
    keepBuffer: 4,
    updateWhenZooming: false,
    updateWhenIdle: true,
    attribution: "© OpenStreetMap",
    errorTileUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  }).addTo(state.map);
  state.mapMarkers = L.layerGroup().addTo(state.map);
  state.mapProviderKey = want;
  state._clusterTimer = null;
  state._lastClusterZoom = null;
  // 只在缩放结束后重聚点；拖动不再整表重绘（这是卡顿主因）
  state.map.on("zoomend", () => {
    if (!state.mapPoints || !state.mapPoints.points) return;
    const z = state.map.getZoom();
    if (state._lastClusterZoom === z) return;
    clearTimeout(state._clusterTimer);
    state._clusterTimer = setTimeout(() => {
      state._lastClusterZoom = z;
      renderMapClusters(state.mapPoints.points);
    }, 80);
  });
  return state.map;
}

function fitMapToPoints(points, scope) {
  const map = state.map;
  if (!map) return;
  if (!points.length) {
    if (scope === "world") map.setView([20, 10], 2);
    else map.setView([35.2, 105.0], 4);
    return;
  }
  const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
  if (!bounds.isValid()) return;
  // 点很散（跨省）时总览；点集中时放到市/县级
  const span = Math.max(
    Math.abs(bounds.getNorth() - bounds.getSouth()),
    Math.abs(bounds.getEast() - bounds.getWest())
  );
  let maxZoom = 12;
  if (scope === "world" || span > 25) maxZoom = 5;
  else if (span > 8) maxZoom = 7;
  else if (span > 2) maxZoom = 9;
  else if (span > 0.5) maxZoom = 11;
  map.fitBounds(bounds.pad(0.35), { maxZoom, animate: false });
  if (points.length === 1) {
    map.setView([points[0].lat, points[0].lng], Math.min(12, Math.max(10, map.getZoom())), {
      animate: false,
    });
  }
}

/** 按当前缩放网格聚点（类似苹果相册 Places 堆叠） */
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
    };
  });
}

function placeLabel(cluster) {
  const locs = cluster.photos
    .map((p) => (p.meta && p.meta.location) || "")
    .filter(Boolean);
  if (locs.length) {
    const freq = {};
    locs.forEach((l) => {
      freq[l] = (freq[l] || 0) + 1;
    });
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  }
  return `${cluster.lat.toFixed(2)}, ${cluster.lng.toFixed(2)}`;
}

function stackIconHtml(cluster) {
  const cover = cluster.cover;
  const src = `/api/thumb?path=${encodeURIComponent(cover.path)}&size=120&_=${state.thumbBust || 0}`;
  const n = cluster.count;
  const stack =
    n > 1
      ? `<span class="places-stack-back" aria-hidden="true"></span><span class="places-stack-mid" aria-hidden="true"></span>`
      : "";
  const badge = n > 1 ? `<span class="places-badge">${n > 99 ? "99+" : n}</span>` : "";
  return `<div class="places-stack">${stack}<div class="places-stack-face"><img src="${src}" alt="" />${badge}</div></div>`;
}

function focusMapOnCluster(cluster, zoom = 12) {
  const map = state.map;
  if (!map || !cluster) return;
  const z = Math.min(12, Math.max(zoom, 11));
  // 展开后地图变窄，先校正尺寸再定位，避免分辨率/中心错乱
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

function openMapExpand(cluster) {
  const panel = $("#map-expand");
  const grid = $("#map-expand-grid");
  const title = placeLabel(cluster);
  $("#map-expand-title").textContent = title;
  $("#map-expand-sub").textContent = `${cluster.count} 张 · 点击照片打开`;
  grid.innerHTML = "";
  cluster.photos.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-expand-item";
    const t = (p.meta && p.meta.title) || p.name;
    btn.innerHTML = `<img src="/api/thumb?path=${encodeURIComponent(
      p.path
    )}&size=240&_=${state.thumbBust || 0}" alt="" /><span>${escapeAttr(t)}</span>`;
    btn.addEventListener("click", () =>
      openLightbox(
        p.path,
        cluster.photos.map((x) => x.path),
        p.meta || null
      )
    );
    grid.appendChild(btn);
  });
  panel.classList.remove("hidden");
  $("#map-root").classList.add("map-expand-open");
  focusMapOnCluster(cluster, 12);
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

function renderMapClusters(points) {
  ensureMap();
  const zoom = state.map.getZoom();
  const clusters = clusterPhotosByZoom(points, zoom);
  state.mapClusters = clusters;
  state.mapMarkers.clearLayers();
  clusters.forEach((c) => {
    const icon = L.divIcon({
      className: "places-marker",
      html: stackIconHtml(c),
      iconSize: [56, 64],
      iconAnchor: [28, 64],
    });
    const marker = L.marker([c.lat, c.lng], { icon, riseOnHover: true });
    marker.on("click", () => {
      // 县级堆叠：展开图集并放大到 z12；单张直接打开详情并聚焦
      if (c.count === 1) {
        openLightbox(c.cover.path, [c.cover.path], c.cover.meta || null);
        focusMapOnCluster(c, 12);
        return;
      }
      openMapExpand(c);
    });
    state.mapMarkers.addLayer(marker);
  });
}

async function loadMap(force = false) {
  $("#map-status").textContent = "加载地图…";
  closeMapExpand();
  // 等面板真正显示后再初始化，否则 Leaflet 宽高为 0 会一直空白
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!state.mapPoints || force) {
    state.mapPoints = await api("/api/map/photos");
  }
  const pack = await api("/api/map/pack").catch(() => ({ ready: false }));
  try {
    ensureMap();
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

  const points = state.mapPoints.points || [];
  state._lastClusterZoom = null;
  renderMapClusters(points);
  const scope = state.mapPoints.scope || (state.mapPoints.has_foreign ? "world" : "china");
  fitMapToPoints(points, scope);
  refreshSize();
  const n = points.length;
  const skip = state.mapPoints.skipped || 0;
  const viewTip = state.mapPoints.has_foreign ? "含境外 · 世界视野" : "国内 · 自动聚焦";
  const packTip = pack.ready ? "离线标准地图" : "地图包缺失";
  $("#map-status").textContent = n
    ? `${packTip} · ${viewTip} · ${n} 张${skip ? `（${skip} 张无地点）` : ""}`
    : skip
      ? `暂无坐标点（${skip} 张缺地点或 GPS）`
      : "暂无照片";
}

/** 地点/元数据变更后清缓存；若正在看地图则立即重载 */
function invalidateMapData() {
  state.mapPoints = null;
  state._lastClusterZoom = null;
  if (state.viewMode === "map") {
    return loadMap(true).catch((e) => {
      $("#map-status").textContent = e.message || String(e);
    });
  }
  return Promise.resolve();
}

/* Import */
function renderImportItems(items) {
  const list = $("#import-list");
  const empty = $("#import-empty");
  list.innerHTML = "";
  $("#import-count").textContent = items.length ? `共 ${items.length} 项` : "";
  if (!items.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "import-item";
    row.dataset.path = it.path;
    if (it.live_companion) row.dataset.liveCompanion = "1";
    const meta = it.meta || {};
    const kind = it.kind || (isVideoName(it.name) ? "video" : "image");
    const heic = isHeicName(it.name || it.path);
    let preview;
    if (kind === "video") {
      preview = it.live_companion
        ? `<div class="import-video-ph" title="实况伴生视频">Live</div>`
        : `<div class="import-video-ph" title="视频">▶</div>`;
    } else if (heic) {
      preview = `<img src="/api/preview?source=import&path=${encodeURIComponent(it.path)}&size=240" alt="" />`;
    } else {
      preview = `<img src="/api/file?source=import&path=${encodeURIComponent(it.path)}" alt="" />`;
    }
    const badge = it.live_companion
      ? `<span class="live-badge">实况伴生 · 随同名 HEIC 入库</span>`
      : heic
        ? `<span class="live-badge heic">HEIC 原件</span>`
        : "";
    // 实况伴生 MOV 默认不单独勾选（会随 HEIC 一起带走）
    const checked = it.live_companion ? "" : "checked";
    row.innerHTML = `
      <input type="checkbox" class="pick" ${checked} />
      ${preview}
      <div class="import-fields">
        <label>文件 <input type="text" value="${escapeAttr(it.name)}" disabled /></label>
        ${badge}
        <label>时间 <input type="datetime-local" class="f-datetime" value="${toLocalInput(meta.datetime)}" ${it.live_companion ? "disabled" : ""} /></label>
        <label>简述 <input type="text" class="f-title" maxlength="30" value="${escapeAttr(meta.title || "")}" ${it.live_companion ? "disabled" : ""} /></label>
        <label>描述 <input type="text" class="f-description" value="${escapeAttr(meta.description || "")}" ${it.live_companion ? "disabled" : ""} /></label>
        <label>地点 <input type="text" class="f-location" value="${escapeAttr(meta.location || "")}" ${it.live_companion ? "disabled" : ""} /></label>
      </div>`;
    list.appendChild(row);
  });
}

async function loadImport() {
  const data = await api("/api/import/list");
  renderImportItems(data.items);
}

$("#btn-reload-import").addEventListener("click", () => loadImport().catch(alert));
$("#btn-parse").addEventListener("click", async () => {
  try {
    const data = await api("/api/import/parse", { method: "POST", body: "{}" });
    renderImportItems(data.items);
  } catch (e) {
    alert(e.message);
  }
});

$("#check-all").addEventListener("change", (e) => {
  document.querySelectorAll(".import-item .pick").forEach((c) => {
    c.checked = e.target.checked;
  });
});

$("#btn-select-same-day").addEventListener("click", () => {
  const rows = [...document.querySelectorAll(".import-item")];
  const checked = rows.filter((r) => r.querySelector(".pick").checked);
  if (!checked.length) {
    alert("请先勾选一张作为「同日」参考");
    return;
  }
  const ref = checked[0].querySelector(".f-datetime").value.slice(0, 10);
  if (!ref) {
    alert("参考项没有日期，请先填写时间或换一张");
    return;
  }
  rows.forEach((row) => {
    const day = (row.querySelector(".f-datetime").value || "").slice(0, 10);
    row.querySelector(".pick").checked = day === ref;
  });
  $("#import-count").textContent = `已勾选同日 ${ref} 的照片`;
});

/* Batch edit */
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
  $("#batch-dialog").showModal();
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

$("#btn-batch-import").addEventListener("click", () => {
  const n = document.querySelectorAll(".import-item .pick:checked").length;
  if (!n) {
    alert("请先勾选要批量编辑的照片");
    return;
  }
  openBatchDialog("import", n);
});

$("#btn-batch-cancel").addEventListener("click", () => $("#batch-dialog").close());

$("#btn-batch-apply").addEventListener("click", async () => {
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
      document.querySelectorAll(".import-item").forEach((row) => {
        if (!row.querySelector(".pick").checked) return;
        if (flags.apply_datetime && fields.datetime) {
          row.querySelector(".f-datetime").value = toLocalInput(fields.datetime);
        }
        if (flags.apply_title) row.querySelector(".f-title").value = fields.title || "";
        if (flags.apply_description) {
          row.querySelector(".f-description").value = fields.description || "";
        }
        if (flags.apply_location) {
          row.querySelector(".f-location").value = fields.location || "";
        }
      });
      $("#batch-dialog").close();
      alert(`已应用到导入列表 ${document.querySelectorAll(".import-item .pick:checked").length} 张`);
      return;
    }
    const paths = [...state.selectedPaths];
    if (!paths.length) {
      alert("未选中照片");
      return;
    }
    const r = await api("/api/photo/meta/batch", {
      method: "POST",
      body: JSON.stringify({
        paths,
        datetime: fields.datetime ?? null,
        title: fields.title ?? null,
        description: fields.description ?? null,
        location: fields.location ?? null,
        ...flags,
      }),
    });
    $("#batch-dialog").close();
    state.selectedPaths.clear();
    setSelectMode(false);
    await loadTree();
    await invalidateMapData();
    alert(r.message || "批量编辑完成");
  } catch (e) {
    alert(e.message);
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

const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?|bmp|hei[cf])$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|3gp|ts|mts|m2ts)$/i;
const MEDIA_EXT = /\.(jpe?g|png|webp|tiff?|bmp|hei[cf]|mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|3gp|ts|mts|m2ts)$/i;

function isVideoName(name) {
  return VIDEO_EXT.test(name || "");
}

function isHeicName(name) {
  return /\.hei[cf]$/i.test(name || "");
}

function isMobileClient() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
}

function setupImportMobileUX() {
  const mobile = isMobileClient();
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
        "手机/平板：用「从相册选择」导入。支持苹果 HEIC、实况、MOV；按字节拷贝，不转码不压画质。解析只预填，点「入库」才写入相册。";
    }
  }
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

async function uploadPairs(pairs) {
  if (!pairs.length) {
    $("#drop-status").textContent = "没有可导入的图片或视频";
    return;
  }
  $("#drop-status").textContent = `正在导入 ${pairs.length} 个文件…`;
  const batchSize = isMobileClient() ? 4 : 12;
  let saved = 0;
  let skipped = 0;
  for (let i = 0; i < pairs.length; i += batchSize) {
    const slice = pairs.slice(i, i + batchSize);
    const form = new FormData();
    slice.forEach(({ file, path }) => {
      form.append("files", file, file.name);
      form.append("paths", path || file.name);
    });
    const res = await fetch("/api/import/upload", { method: "POST", body: form });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        msg = j.detail || msg;
      } catch (_) {}
      throw new Error(typeof msg === "string" ? msg : "上传失败");
    }
    const data = await res.json();
    saved += data.count || 0;
    skipped += (data.skipped || []).length;
  }
  $("#drop-status").textContent = `已放入待入库区 ${saved} 项${skipped ? `，跳过 ${skipped} 个` : ""}`;
  await loadImport();
}

const zone = $("#drop-zone");
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

$("#btn-pick-files").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#file-input").click();
});
$("#btn-pick-dir").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#dir-input").click();
});
zone.addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  $("#file-input").click();
});

function onPicked(input) {
  const pairs = [...input.files]
    .filter((file) => MEDIA_EXT.test(file.name))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  uploadPairs(pairs).catch((err) => {
    $("#drop-status").textContent = err.message;
  });
  input.value = "";
}
$("#file-input").addEventListener("change", (e) => onPicked(e.target));
$("#dir-input").addEventListener("change", (e) => onPicked(e.target));

$("#btn-ingest").addEventListener("click", async () => {
  const items = [];
  document.querySelectorAll(".import-item").forEach((row) => {
    if (!row.querySelector(".pick").checked) return;
    // 实况伴生 MOV：勿单独入库，入库 HEIC 时会自动带走
    if (row.dataset.liveCompanion === "1") return;
    items.push({
      path: row.dataset.path,
      datetime: fromLocalInput(row.querySelector(".f-datetime").value),
      title: row.querySelector(".f-title").value,
      description: row.querySelector(".f-description").value,
      location: row.querySelector(".f-location").value,
    });
  });
  if (!items.length) {
    alert("请先勾选要入库的项目");
    return;
  }
  try {
    const data = await api("/api/import/ingest", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    const log = $("#import-log");
    log.classList.remove("hidden");
    log.textContent = data.results
      .map((r) => (r.ok ? `✓ ${r.path} ${r.message || ""}` : `✗ ${r.path || ""} ${r.message}`))
      .join("\n");
    await loadImport();
    await loadTree();
    await invalidateMapData();
  } catch (e) {
    alert(e.message);
  }
});

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
  if (!["fade", "slide", "cut"].includes(mode)) mode = "fade";
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

function lbRunFxPrep(dir) {
  const { mode } = lbPlaySettings();
  if (!lbFx || mode === "cut") {
    lbClearFx();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    lbClearFx();
    const outCls =
      mode === "slide"
        ? dir > 0
          ? "fx-slide-out-left"
          : "fx-slide-out-right"
        : "fx-fade-out";
    lbFx.classList.add(outCls);
    const done = () => {
      lbFx.removeEventListener("animationend", done);
      resolve();
    };
    lbFx.addEventListener("animationend", done, { once: true });
    setTimeout(done, 300);
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
    const inCls =
      mode === "slide"
        ? dir > 0
          ? "fx-slide-in-left"
          : "fx-slide-in-right"
        : "fx-fade-in";
    void lbFx.offsetWidth;
    lbFx.classList.add(inCls);
    const done = () => {
      lbFx.removeEventListener("animationend", done);
      lbClearFx();
      resolve();
    };
    lbFx.addEventListener("animationend", done, { once: true });
    setTimeout(done, 400);
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

function lbStopNarration() {
  if (lb.audioEl) {
    try {
      lb.audioEl.pause();
      lb.audioEl.removeAttribute("src");
      lb.audioEl.load?.();
    } catch (_) {}
    lb.audioEl = null;
  }
}

function lbStopAutoplay() {
  lb.playing = false;
  if (lb.timer) {
    clearTimeout(lb.timer);
    lb.timer = null;
  }
  lbStopNarration();
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
  lbStopNarration();
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
      const wait = Math.max(ms, vidMs > 0 ? vidMs : ms);
      lbStartProgress(wait);
      lbVideo.play?.().catch(() => {});
      if (vidMs > 0 && Number.isFinite(lbVideo.duration)) {
        lbVideo.addEventListener("ended", advance, { once: true });
        lb.timer = setTimeout(advance, wait + 200);
      } else {
        lb.timer = setTimeout(advance, ms);
      }
    };
    if (lbVideo.readyState >= 1) tryPlay();
    else lbVideo.addEventListener("loadedmetadata", tryPlay, { once: true });
    return;
  }

  // 图片有旁白且开启「播放旁白」：按时长切换并播音频
  if (playNarration && lb.hasAudio && lb.audioUrl) {
    const audio = new Audio(lb.audioUrl);
    lb.audioEl = audio;
    const advance = () => {
      audio.removeEventListener("ended", advance);
      if (lb.timer) {
        clearTimeout(lb.timer);
        lb.timer = null;
      }
      if (!lb.playing) return;
      lbGo(1, { autoplay: true });
    };
    const tryPlay = () => {
      const known = Number(lb.audioDuration) || 0;
      const probed = Number(audio.duration) || 0;
      const audMs = Math.max(known, probed > 0 && Number.isFinite(probed) ? probed : 0) * 1000;
      const wait = audMs > 0 ? audMs : ms;
      lbStartProgress(wait);
      audio.play?.().catch(() => {});
      audio.addEventListener("ended", advance, { once: true });
      lb.timer = setTimeout(advance, wait + 250);
    };
    if (audio.readyState >= 1) tryPlay();
    else audio.addEventListener("loadedmetadata", tryPlay, { once: true });
    audio.addEventListener("error", () => {
      lbStartProgress(ms);
      lb.timer = setTimeout(() => {
        if (!lb.playing) return;
        lbGo(1, { autoplay: true });
      }, ms);
    }, { once: true });
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
  lbScheduleNext();
}

function lbToggleAutoplay() {
  if (lb.playing) lbStopAutoplay();
  else lbStartAutoplay();
}

function lbApplyTransform() {
  if (!lbStage) return;
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
  lbStopNarration();
  lb.hasAudio = false;
  lb.audioUrl = null;
  lb.audioDuration = null;

  const hint = hintMeta || {};
  const hintVid = hint.kind === "video" || isVideoName(path);
  lb.kind = hintVid ? "video" : "image";
  lbImg.classList.toggle("hidden", lb.kind === "video");
  lbVideo.classList.toggle("hidden", lb.kind !== "video");
  $("#lb-hint").textContent = lb.playing
    ? "自动播放中 · 点「暂停」停止 ·「设置」可改模式与时长"
    : lb.kind === "video"
      ? "左右滑动翻图 · 点右上角编辑可剪辑与设封面"
      : "左右滑动翻图 · 双击放大 · 捏合 / 滚轮缩放";

  const dir = opts.dir || lb.lastDelta || 1;
  if (opts.withFx) await lbRunFxPrep(dir);

  try {
    const data = await api(`/api/photo?path=${encodeURIComponent(path)}`);
    if (state.galleryPaths[state.galleryIndex] !== path) return;
    const kind = data.kind || (isVideoName(data.name || path) ? "video" : "image");
    lb.kind = kind;
    lb.hasAudio = Boolean(data.has_audio && data.audio_path);
    lb.audioUrl = lb.hasAudio
      ? `/api/file?path=${encodeURIComponent(data.audio_path)}&t=${Date.now()}`
      : null;
    lb.audioDuration = data.audio_duration != null ? Number(data.audio_duration) : null;
    lbImg.classList.toggle("hidden", kind === "video");
    lbVideo.classList.toggle("hidden", kind !== "video");
    $("#lb-title").textContent =
      (data.meta && data.meta.title) || data.name || path.split("/").pop();
    const fileUrl = `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    if (kind === "video") {
      lbImg.removeAttribute("src");
      lbVideo.pause();
      lbVideo.src = fileUrl;
      lbVideo.load();
    } else {
      lbVideo.pause();
      lbVideo.removeAttribute("src");
      lbVideo.load();
      const waitImg = new Promise((resolve) => {
        const done = () => {
          lbImg.removeEventListener("load", done);
          lbImg.removeEventListener("error", done);
          resolve();
        };
        lbImg.addEventListener("load", done, { once: true });
        lbImg.addEventListener("error", done, { once: true });
      });
      lbImg.src = isHeicName(data.name || path)
        ? `/api/preview?path=${encodeURIComponent(path)}&size=2000&t=${Date.now()}`
        : fileUrl;
      await waitImg;
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
  } catch (e) {
    $("#lb-title").textContent = e.message || "加载失败";
    lbClearFx();
  }

  if (lb.playing) lbScheduleNext();
}

function openLightbox(path, paths = null, hintMeta = null) {
  const list =
    Array.isArray(paths) && paths.length ? paths.slice() : [path];
  state.galleryPaths = list;
  state.galleryIndex = Math.max(0, list.indexOf(path));
  if (state.galleryIndex < 0) {
    state.galleryPaths = [path];
    state.galleryIndex = 0;
  }
  state.reopenLightbox = false;
  lbStopAutoplay();
  $("#lb-play-panel")?.classList.add("hidden");
  if (!lbDialog.open) lbDialog.showModal();
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
  if (lbDialog.open) lbDialog.close();
  openDetail(path).catch((e) => alert(e.message || e));
}

$("#lb-close")?.addEventListener("click", () => {
  lbStopAutoplay();
  lbVideo?.pause();
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
  if (!state.reopenLightbox) return;
  state.reopenLightbox = false;
  const path = state.currentPath || (state.galleryPaths || [])[state.galleryIndex];
  if (!path) return;
  // 编辑后回到看图
  openLightbox(path, state.galleryPaths.length ? state.galleryPaths : [path]);
});

async function openDetail(path, hintMeta = null) {
  const req = ++_detailReq;
  state.currentPath = path;
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
    const url = `/api/file?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    if (kind === "video") {
      videoEl.pause();
      videoEl.src = url;
      videoEl.load();
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
      // HEIC：多数浏览器不能直接显示原件，用预览 JPEG（不改相册原件）
      imgEl.src = isHeicName(data.name || path)
        ? `/api/preview?path=${encodeURIComponent(path)}&size=1600&t=${Date.now()}`
        : url;
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
  state.currentPath = r.path || state.currentPath;
  // 同步 gallery 路径（另存后可能改名）
  if (state.galleryPaths?.length && state.galleryIndex >= 0) {
    state.galleryPaths[state.galleryIndex] = state.currentPath;
  }
  $("#detail-msg").textContent = r.message || "已保存";
  const url = `/api/file?path=${encodeURIComponent(state.currentPath)}&t=${Date.now()}`;
  if (state.mediaKind === "video") {
    videoEl.src = url;
    videoEl.load();
  } else {
    imgEl.src = isHeicName(state.currentPath)
      ? `/api/preview?path=${encodeURIComponent(state.currentPath)}&size=1600&t=${Date.now()}`
      : url;
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
    state.currentPath = r.path || state.currentPath;
    state.thumbBust = r.thumb_bust || Date.now();
    status.textContent = "已写回，正在同步信息…";
    await saveMetaOnly({ refreshViews: false });
    if (state.mediaKind === "video") {
      videoEl.src = `/api/file?path=${encodeURIComponent(state.currentPath)}&t=${Date.now()}`;
      videoEl.load();
    } else {
      imgEl.src = isHeicName(state.currentPath)
        ? `/api/preview?path=${encodeURIComponent(state.currentPath)}&size=1600&t=${Date.now()}`
        : `/api/file?path=${encodeURIComponent(state.currentPath)}&t=${Date.now()}`;
    }
    $("#save-mode-dialog").close();
    $("#detail-msg").textContent = (r.message || "已保存") + "；信息已同步";
    queueMicrotask(() => {
      loadTree().catch(console.error);
      invalidateMapData().catch(console.error);
    });
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

async function loadSettings() {
  const cfg = await api("/api/config");
  const form = $("#settings-form");
  if (form?.album_root) form.album_root.value = cfg.album_root || "";
  const titleInput = $("#input-album-title");
  if (titleInput) titleInput.value = cfg.album_title || "小树时光相册";
  applyBrand(cfg);
  updateAlbumRootStatus(cfg);
  applyTheme(localStorage.getItem("xiaoshu_theme") || "fresh");
  refreshMapPackStatus().catch(console.error);
  refreshAuthSettingsUI();
  renderShareYearChips(cfg.album_years || []);
  if (state.me?.can_settings) {
    loadShares().catch(console.error);
    refreshIndexStatus().catch(console.error);
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
  btn.addEventListener("click", () => {
    const id = btn.dataset.for;
    const input = id ? document.getElementById(id) : null;
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "隐藏" : "显示";
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
  state.shareMode = mode === "media" ? "media" : "years";
  document.querySelectorAll("[data-share-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.shareMode === state.shareMode);
  });
  $("#share-years-box")?.classList.toggle("hidden", state.shareMode !== "years");
  $("#share-media-box")?.classList.toggle("hidden", state.shareMode !== "media");
  if (state.shareMode === "media" && !state.shareMediaLoaded) {
    loadShareMediaPicker().catch(console.error);
  }
}

document.querySelectorAll("[data-share-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setShareMode(btn.dataset.shareMode));
});

function updateShareMediaCount() {
  const el = $("#share-media-count");
  if (el) el.textContent = `已选 ${state.shareMediaPaths.size}`;
}

async function loadShareMediaPicker() {
  const grid = $("#share-media-grid");
  if (!grid) return;
  grid.innerHTML = `<p class="muted">加载中…</p>`;
  const data = await api("/api/timeline");
  const photos = [];
  (data.years || []).forEach((y) => {
    (y.months || []).forEach((m) => {
      (m.photos || []).forEach((p) => photos.push(p));
    });
  });
  grid.innerHTML = "";
  if (!photos.length) {
    grid.innerHTML = `<p class="muted">相册为空</p>`;
    state.shareMediaLoaded = true;
    updateShareMediaCount();
    return;
  }
  const frag = document.createDocumentFragment();
  photos.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "share-media-item" + (state.shareMediaPaths.has(p.path) ? " selected" : "");
    btn.dataset.path = p.path;
    btn.title = p.path;
    btn.innerHTML = `<img loading="lazy" src="/api/thumb?path=${encodeURIComponent(
      p.path
    )}&size=160&_=${state.thumbBust || 0}" alt="" />${
      p.kind === "video" ? `<span class="kind-tag">视频</span>` : ""
    }`;
    btn.addEventListener("click", () => {
      if (state.shareMediaPaths.has(p.path)) state.shareMediaPaths.delete(p.path);
      else state.shareMediaPaths.add(p.path);
      btn.classList.toggle("selected", state.shareMediaPaths.has(p.path));
      updateShareMediaCount();
    });
    frag.appendChild(btn);
  });
  grid.appendChild(frag);
  state.shareMediaLoaded = true;
  updateShareMediaCount();
}

$("#btn-share-media-reload")?.addEventListener("click", () => {
  state.shareMediaLoaded = false;
  loadShareMediaPicker().catch((e) => alert(e.message || String(e)));
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
      <img src="/api/shares/${it.id}/qr?t=${Date.now()}" alt="二维码" />
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
    state.shareMode === "media" ? [...state.shareMediaPaths] : [];
  if (!album_scopes.length && !media_paths.length) {
    if (msg) {
      msg.textContent =
        state.shareMode === "media"
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
  }
});

$("#btn-auth-logout")?.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch (_) {}
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
  if (data && data.has_audio && data.audio_path) {
    audio.src = `/api/file?path=${encodeURIComponent(data.audio_path)}&t=${Date.now()}`;
    audio.classList.remove("hidden");
    btnDel?.classList.remove("hidden");
    const dur = data.audio_duration;
    status.textContent = dur
      ? `已有旁白，约 ${Number(dur).toFixed(1)} 秒`
      : "已有旁白";
  } else {
    audio.removeAttribute("src");
    audio.classList.add("hidden");
    btnDel?.classList.add("hidden");
    if (status) status.textContent = "";
  }
}

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

$("#btn-narration-rec")?.addEventListener("click", async () => {
  const status = $("#narration-status");
  if (!state.currentPath || state.mediaKind === "video") return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    alert("当前浏览器不支持录音");
    return;
  }
  try {
    _narrationChunks = [];
    _narrationStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    _narrationRecorder = mime
      ? new MediaRecorder(_narrationStream, { mimeType: mime })
      : new MediaRecorder(_narrationStream);
    _narrationRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) _narrationChunks.push(e.data);
    };
    _narrationRecorder.onstop = async () => {
      await stopNarrationTracks();
      const type = _narrationRecorder?.mimeType || "audio/webm";
      const blob = new Blob(_narrationChunks, { type });
      _narrationChunks = [];
      _narrationRecorder = null;
      $("#narration-block")?.classList.remove("is-recording");
      $("#narration-meter")?.classList.add("hidden");
      $("#btn-narration-rec")?.classList.remove("hidden");
      $("#btn-narration-stop")?.classList.add("hidden");
      if (!blob.size) {
        if (status) status.textContent = "没有录到声音";
        return;
      }
      try {
        if (status) status.textContent = "正在保存旁白…";
        const fd = new FormData();
        fd.append("file", blob, "narration.webm");
        const r = await api(
          `/api/photo/audio?path=${encodeURIComponent(state.currentPath)}`,
          { method: "POST", body: fd }
        );
        updateNarrationUI(r);
        if (status) status.textContent = r.message || "旁白已保存";
      } catch (e) {
        if (status) status.textContent = e.message || String(e);
      }
    };
    _narrationRecorder.start();
    startNarrationMeter(_narrationStream);
    $("#narration-block")?.classList.add("is-recording");
    $("#btn-narration-rec")?.classList.add("hidden");
    $("#btn-narration-stop")?.classList.remove("hidden");
    if (status) status.textContent = "录音中…点击「停止并保存」结束";
  } catch (e) {
    await stopNarrationTracks();
    if (status) status.textContent = e.message || "无法打开麦克风";
  }
});

$("#btn-narration-stop")?.addEventListener("click", () => {
  if (_narrationRecorder && _narrationRecorder.state !== "inactive") {
    _narrationRecorder.stop();
  }
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
    cfg = await api("/api/config");
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
    state.timelineCache = null;
    queueMicrotask(() => {
      loadTree().catch(console.error);
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

$("#settings-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
});

function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshMapPackStatus() {
  const el = $("#map-pack-status");
  const msg = $("#map-pack-msg");
  const btn = $("#btn-map-pack-update");
  if (!el) return null;
  const st = await api("/api/map/pack");
  const job = st.job || {};
  const xyz = st.xyz_count || 0;
  const mb = st.mbtiles_count || 0;
  const meta = st.meta || {};
  const built = meta.built_at || "—";
  const provider = meta.provider || "OpenStreetMap";
  let line = st.ready
    ? `已就绪 · ${provider} · XYZ ${xyz} 张` + (mb ? ` · MBTiles ${mb} 张` : "")
    : "尚未就绪，请联网更新地图包";
  if (st.size_bytes) line += ` · 包 ${formatBytes(st.size_bytes)}`;
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
  const btnSelect = $("#btn-trash-select");
  const btnRestore = $("#btn-trash-restore");
  const btnPurge = $("#btn-trash-purge");
  if (btnSelect) {
    btnSelect.textContent = on ? "取消选择" : "选择";
    btnSelect.classList.toggle("is-active", on);
  }
  btnRestore?.classList.toggle("hidden", !(on && n > 0));
  btnPurge?.classList.toggle("hidden", !(on && n > 0));
  if (btnRestore) btnRestore.textContent = n ? `恢复(${n})` : "恢复";
  if (btnPurge) btnPurge.textContent = n ? `彻底删除(${n})` : "彻底删除";
  $("#trash-grid")?.classList.toggle("trash-selecting", on);
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
      ${isVid ? `<span class="media-badge" aria-hidden="true">▶</span>` : ""}
      <img loading="lazy" src="/api/thumb?path=${encodeURIComponent(it.path)}&_=${state.thumbBust || 0}" alt="" />
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
    await loadTree();
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

/* Boot */
setupImportMobileUX();

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
  let me = null;
  try {
    me = await api("/api/me");
    applyCapabilities(me);
  } catch (_) {
    me = { open_mode: true, can_edit: true, can_upload: true, can_settings: true, can_trash: true };
    applyCapabilities(me);
  }
  // 未登录（含首次建号）一律进登录页；分享会话除外
  if (!me?.authenticated) {
    location.replace("/login");
    return;
  }
  try {
    const cfg = await api("/api/config");
    applyBrand(cfg);
  } catch (_) {}
  applySection();
  if (state.section === "browse") loadTree().catch(console.error);
}

bootAuthAndUi().catch(console.error);
