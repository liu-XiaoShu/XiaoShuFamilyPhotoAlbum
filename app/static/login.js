/* 超级用户登录页 */
const $ = (s, el = document) => el.querySelector(s);

async function api(url, options = {}) {
  const opts = { credentials: "same-origin", ...options };
  if (opts.body && !opts.headers) {
    opts.headers = { "Content-Type": "application/json" };
  } else if (opts.body && opts.headers && !opts.headers["Content-Type"]) {
    opts.headers = { ...opts.headers, "Content-Type": "application/json" };
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const msg = Array.isArray(detail)
      ? detail.map((d) => d.msg || d).join("; ")
      : detail || res.statusText || "请求失败";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
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
    const input = document.getElementById(btn.dataset.for);
    if (!input) return;
    const show = input.type === "password";
    clearTimeout(hideTimer);
    setShown(input, show);
    if (show) {
      hideTimer = setTimeout(() => {
        if (input.type === "text") setShown(input, false);
      }, 2500);
    }
  });
});

let needsSetup = false;

function paintRules() {
  if (!needsSetup) return;
  const pw = $("#login-pass")?.value || "";
  const checks = passwordChecks(pw, $("#login-pass2")?.value);
  const meter = $("#login-meter");
  if (meter) {
    meter.className = "";
    const lv = passwordScore(pw);
    if (pw) meter.classList.add(`lv${lv}`);
  }
  $("#login-rules")?.querySelectorAll("[data-rule]").forEach((li) => {
    const ok = checks[li.dataset.rule];
    li.classList.toggle("ok", Boolean(ok));
    li.classList.toggle("bad", pw.length > 0 && !ok);
  });
}

$("#login-pass")?.addEventListener("input", paintRules);
$("#login-pass2")?.addEventListener("input", paintRules);

async function boot() {
  // 与相册页共用同一主题，避免登录前后观感不一致
  try {
    const t = localStorage.getItem("xiaoshu_theme") || "fresh";
    const allowed = { fresh: 1, cyber: 1 };
    document.documentElement.setAttribute(
      "data-theme",
      allowed[t] ? t : "fresh"
    );
  } catch (_) {}

  const cfg = await api("/api/config").catch(() => null);
  if (cfg?.album_title) {
    const t = $("#login-brand-title");
    if (t) t.textContent = cfg.album_title;
    document.title = `超级用户登录 · ${cfg.album_title}`;
  }
  if (cfg?.album_icon_url) {
    const icon = $("#login-brand-icon");
    if (icon) icon.src = `${cfg.album_icon_url}?t=${Date.now()}`;
  }

  const me = await api("/api/me").catch(() => null);
  if (me?.authenticated && (me.is_admin || me.kind === "share")) {
    location.replace("/");
    return;
  }
  needsSetup = Boolean(me?.needs_setup || me?.open_mode);
  $("#setup-extra")?.classList.toggle("hidden", !needsSetup);
  const heading = $("#login-heading");
  const hint = $("#login-hint");
  const submit = $("#login-submit");
  if (needsSetup) {
    if (heading) heading.textContent = "创建超级用户";
    if (hint) hint.textContent = "首次使用：设置用户名与密码，之后用此账号管理相册。";
    if (submit) submit.textContent = "创建并登录";
    const pass = $("#login-pass");
    if (pass) {
      pass.autocomplete = "new-password";
      pass.placeholder = "设置登录密码";
    }
  }
}

$("#login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#login-msg");
  const username = $("#login-user")?.value || "admin";
  const password = $("#login-pass")?.value || "";
  try {
    if (needsSetup) {
      const checks = passwordChecks(password, $("#login-pass2")?.value);
      if (!checks.len || !checks.classes || !checks.space) {
        if (msg) msg.textContent = "请按规则设置密码";
        return;
      }
      if (!checks.match) {
        if (msg) msg.textContent = "两次密码不一致";
        return;
      }
      await api("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
    } else {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
    }
    if (msg) msg.textContent = "成功，正在进入…";
    location.replace("/");
  } catch (err) {
    if (msg) msg.textContent = err.message || String(err);
  }
});

boot().catch(console.error);
