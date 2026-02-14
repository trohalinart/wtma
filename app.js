/* eslint-disable no-console */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  units: "metric", // metric | imperial
  theme: "auto", // auto | light | dark
  location: null, // { name, admin1, country, latitude, longitude, timezone? }
  forecast: null, // api payload
  aborter: null,
  searchAborter: null,
  tgMainBound: false,
};

const ui = {
  bg: $("#bg"),
  subtitle: $("#subtitle"),
  userCount: $("#userCount"),
  btnGeo: $("#btnGeo"),
  btnTheme: $("#btnTheme"),
  btnUnits: $("#btnUnits"),
  btnRefresh: $("#btnRefresh"),
  cityInput: $("#cityInput"),
  btnClear: $("#btnClear"),
  suggestions: $("#suggestions"),
  recent: $("#recent"),
  status: $("#status"),
  clock: $("#clock"),
  current: $("#current"),
  forecast: $("#forecast"),
  sheetBackdrop: $("#sheetBackdrop"),
  sheet: $("#sheet"),
  sheetContent: $("#sheetContent"),
};

const storageKey = "wxapp:v1";

// --- fullscreen viewport sync (mobile Safari / Telegram WebView quirks) ---

function viewportHeightPx() {
  // Prefer Telegram-provided viewport sizes when available (more stable on mobile WebViews).
  try {
    const tg = getTelegram();
    const tgH = Number(tg?.viewportStableHeight ?? tg?.viewportHeight);
    if (Number.isFinite(tgH) && tgH > 0) return Math.round(tgH);
  } catch {
    // ignore
  }

  const vv = window.visualViewport;
  const h = Number(vv?.height ?? window.innerHeight);
  if (!Number.isFinite(h) || h <= 0) return null;
  return Math.round(h);
}

function syncAppViewport() {
  const h = viewportHeightPx();
  if (!h) return;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
}

let viewportSyncRaf = 0;
function scheduleViewportSync() {
  if (viewportSyncRaf) return;
  viewportSyncRaf = requestAnimationFrame(() => {
    viewportSyncRaf = 0;
    syncAppViewport();
  });
}

function initViewportSync() {
  scheduleViewportSync();
  window.addEventListener("resize", scheduleViewportSync, { passive: true });
  window.visualViewport?.addEventListener("resize", scheduleViewportSync, { passive: true });
  // iOS: toolbar show/hide affects visual viewport without a window resize.
  window.visualViewport?.addEventListener("scroll", scheduleViewportSync, { passive: true });
}

function counterSafeName(text, { fallback = "x" } = {}) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || fallback;
}

function getUserCountCounter() {
  const host = location.host || location.hostname || "local";
  const ns = counterSafeName(`wxapp-weather-${host}`);
  const name = "users";
  return { ns, name };
}

function userCountStorageKeys() {
  const { ns, name } = getUserCountCounter();
  const base = `wxapp:usercount:v1:${ns}:${name}`;
  return {
    seen: `${base}:seen`,
    cache: `${base}:cache`,
  };
}

function formatUserCount(n) {
  try {
    return new Intl.NumberFormat("ru-RU").format(n);
  } catch {
    return String(n);
  }
}

function readUserCountCache() {
  const { cache } = userCountStorageKeys();
  try {
    const raw = localStorage.getItem(cache);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const value = Number(data?.value);
    const ts = Number(data?.ts);
    if (!Number.isFinite(value) || !Number.isFinite(ts)) return null;
    return { value, ts };
  } catch {
    return null;
  }
}

function writeUserCountCache(value) {
  const { cache } = userCountStorageKeys();
  try {
    localStorage.setItem(cache, JSON.stringify({ value, ts: Date.now() }));
  } catch {
    // ignore
  }
}

async function syncUserCount() {
  if (!ui.userCount) return;

  const cached = readUserCountCache();
  if (cached && Number.isFinite(cached.value)) ui.userCount.textContent = formatUserCount(cached.value);

  // Reduce API calls on repeated opens.
  const ttlMs = 10 * 60 * 1000;
  if (cached && Date.now() - cached.ts < ttlMs) return;

  const { seen } = userCountStorageKeys();
  let hasCounted = false;
  try {
    hasCounted = localStorage.getItem(seen) === "1";
  } catch {
    hasCounted = false;
  }

  const { ns, name } = getUserCountCounter();
  const url = hasCounted
    ? `https://api.counterapi.dev/v1/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/`
    : `https://api.counterapi.dev/v1/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/up`;

  try {
    const data = await apiJson(url);
    const count = Number(data?.count);
    if (!Number.isFinite(count)) return;
    ui.userCount.textContent = formatUserCount(count);
    writeUserCountCache(count);
    if (!hasCounted) {
      try {
        localStorage.setItem(seen, "1");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.units === "metric" || data?.units === "imperial") state.units = data.units;
    if (data?.theme === "auto" || data?.theme === "light" || data?.theme === "dark") state.theme = data.theme;
    if (data?.location && typeof data.location === "object") state.location = data.location;
  } catch {
    // ignore
  }
}

function savePrefs(extra = {}) {
  try {
    const raw = localStorage.getItem(storageKey);
    const prev = raw ? JSON.parse(raw) : {};
    const base = prev && typeof prev === "object" ? prev : {};
    const payload = {
      ...base,
      units: state.units,
      theme: state.theme,
      location: state.location,
      ...extra,
    };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

const themeVars = ["--bg", "--fg", "--muted", "--card", "--card-2", "--border", "--shadow", "--accent", "--accent-2", "--danger"];

function clearInlineThemeVars() {
  const root = document.documentElement;
  for (const k of themeVars) root.style.removeProperty(k);
}

function getSystemTheme() {
  const tg = getTelegram();
  const scheme = tg?.colorScheme;
  if (scheme === "light" || scheme === "dark") return scheme;

  try {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function getEffectiveTheme() {
  if (state.theme === "light" || state.theme === "dark") return state.theme;
  return getSystemTheme();
}

function syncThemeButton() {
  if (!ui.btnTheme) return;

  const effective = getEffectiveTheme();
  const next = effective === "dark" ? "light" : "dark";
  const glyph = next === "light" ? "☀" : "☾";
  const title = next === "light" ? "Включить светлую тему" : "Включить тёмную тему";

  const span = ui.btnTheme.querySelector("span");
  if (span) span.textContent = glyph;
  ui.btnTheme.title = title;
  ui.btnTheme.setAttribute("aria-label", title);
  ui.btnTheme.setAttribute("aria-pressed", String(effective === "dark"));
}

function applyTheme() {
  const root = document.documentElement;

  if (state.theme === "light" || state.theme === "dark") {
    root.dataset.theme = state.theme;
    clearInlineThemeVars();
  } else {
    delete root.dataset.theme;
  }

  try {
    root.style.colorScheme = getEffectiveTheme();
  } catch {
    // ignore
  }

  syncThemeButton();
}

function toggleTheme() {
  const effective = getEffectiveTheme();
  state.theme = effective === "dark" ? "light" : "dark";
  savePrefs();
  applyTheme();
  syncTelegramMainButton();

  try {
    getTelegram()?.HapticFeedback?.impactOccurred?.("light");
  } catch {
    // ignore
  }
}

function initTheme() {
  applyTheme();

  // Keep the icon in sync in browsers (auto mode only).
  try {
    const mql = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mql) return;
    const onChange = () => state.theme === "auto" && applyTheme();
    if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
    else if (typeof mql.addListener === "function") mql.addListener(onChange);
  } catch {
    // ignore
  }
}

function getRecent() {
  try {
    const raw = localStorage.getItem(storageKey);
    const data = raw ? JSON.parse(raw) : null;
    const items = Array.isArray(data?.recent) ? data.recent : [];
    return items.filter((x) => x && typeof x === "object").slice(0, 8);
  } catch {
    return [];
  }
}

function removeRecent(lat, lon) {
  const latN = Number(lat);
  const lonN = Number(lon);
  if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return;

  const key = `${latN.toFixed(4)},${lonN.toFixed(4)}`;

  try {
    const raw = localStorage.getItem(storageKey);
    const data = raw ? JSON.parse(raw) : {};
    const base = data && typeof data === "object" ? data : {};
    const items = Array.isArray(base?.recent) ? base.recent : [];
    base.recent = items
      .filter((x) => x && typeof x === "object")
      .filter((x) => `${Number(x.latitude).toFixed(4)},${Number(x.longitude).toFixed(4)}` !== key);
    localStorage.setItem(storageKey, JSON.stringify(base));
  } catch {
    // ignore
  }
}

function pushRecent(loc) {
  const items = getRecent();
  const key = `${loc.latitude.toFixed(4)},${loc.longitude.toFixed(4)}`;
  const next = [loc, ...items.filter((x) => `${x.latitude.toFixed(4)},${x.longitude.toFixed(4)}` !== key)].slice(0, 8);
  try {
    const raw = localStorage.getItem(storageKey);
    const data = raw ? JSON.parse(raw) : {};
    data.recent = next;
    data.units = state.units;
    data.location = state.location;
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function setStatus(text, kind = "info") {
  if (!text) {
    ui.status.hidden = true;
    ui.status.textContent = "";
    ui.status.classList.remove("status--error");
    return;
  }
  ui.status.hidden = false;
  ui.status.textContent = text;
  ui.status.classList.toggle("status--error", kind === "error");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function withTimeout(promise, ms, label = "timeout") {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => t && clearTimeout(t));
}

function wmoInfo(code, isDay = true) {
  const c = Number(code);
  const base = { label: "Неизвестно", icon: iconCloudLegacy() };

  if (c === 0) return { label: "Ясно", icon: isDay ? iconSunLegacy() : iconMoon() };
  if (c === 1) return { label: "Малооблачно", icon: isDay ? iconPartlyCloudyLegacy() : iconNightCloudy() };
  if (c === 2) return { label: "Переменная облачность", icon: iconPartlyCloudySvg() };
  if (c === 3) return { label: "Пасмурно", icon: iconCloudLegacy() };
  if ([45, 48].includes(c)) return { label: "Туман", icon: iconFog() };
  if (c >= 51 && c <= 57) return { label: "Морось", icon: iconRainLegacy() };
  if (c >= 61 && c <= 67) return { label: "Дождь", icon: iconRainLegacy() };
  if (c >= 71 && c <= 77) return { label: "Снег", icon: iconSnowLegacy() };
  if (c >= 80 && c <= 82) return { label: "Ливни", icon: iconRainLegacy() };
  if (c >= 85 && c <= 86) return { label: "Снегопад", icon: iconSnowLegacy() };
  if (c >= 95 && c <= 99) return { label: "Гроза", icon: iconThunder() };

  return base;
}

let lastWxScene = null;
let lastWxBright = false;
let bgFadeTimer = null;
let currentClockTimeout = null;
let currentClockInterval = null;

function wxSceneFromWmo(code, isDay) {
  const c = Number(code);

  if (c === 0) return isDay ? "clear-day" : "clear-night";
  if (c === 1) return isDay ? "clear-day" : "clear-night";
  if (c === 2) return "cloudy";
  if (c === 3) return "cloudy";
  if ([45, 48].includes(c)) return "fog";
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) return "snow";
  if (c >= 95 && c <= 99) return "thunder";

  return isDay ? "cloudy" : "clear-night";
}

function wxSceneFromCurrent(current) {
  const isDay = Boolean(current?.is_day);
  return wxSceneFromWmo(current?.weather_code, isDay);
}

function setWxScene(scene, { bright = false } = {}) {
  const nextBright = Boolean(bright);
  if (!scene) {
    lastWxScene = null;
    lastWxBright = false;
    delete document.documentElement.dataset.wx;
    delete document.documentElement.dataset.wxBright;
    return;
  }

  if (scene === lastWxScene && nextBright === lastWxBright) return;
  lastWxScene = scene;
  lastWxBright = nextBright;
  document.documentElement.dataset.wx = scene;
  if (nextBright) document.documentElement.dataset.wxBright = "1";
  else delete document.documentElement.dataset.wxBright;

  if (ui.bg) {
    if (bgFadeTimer) window.clearTimeout(bgFadeTimer);
    ui.bg.classList.add("bg--fade");
    bgFadeTimer = window.setTimeout(() => ui.bg && ui.bg.classList.remove("bg--fade"), 240);
  }
}

function applyWeatherBackground() {
  const current = state.forecast?.current;
  if (!current) {
    setWxScene(null);
    return;
  }

  const isDay = Boolean(current?.is_day);
  const code = Number(current?.weather_code);
  const bright = isDay && code === 0;
  setWxScene(wxSceneFromCurrent(current), { bright });
}

function getTelegramLocationManager() {
  const tg = getTelegram();
  if (!tg || !tgIsVersionAtLeast(tg, "8.0")) return null;
  const lm = tg?.LocationManager;
  if (!lm || typeof lm.getLocation !== "function") return null;
  return lm;
}

function promptOpenTgLocationSettings() {
  const tg = getTelegram();
  const lm = getTelegramLocationManager();
  if (!tg || !lm || typeof lm.openSettings !== "function") return;

  if (typeof tg.showPopup === "function") {
    tg.showPopup(
      {
        title: "Геолокация",
        message: "Разрешите доступ к геолокации в настройках Telegram и попробуйте ещё раз.",
        buttons: [
          { id: "settings", type: "default", text: "Настройки" },
          { id: "cancel", type: "cancel" },
        ],
      },
      (buttonId) => {
        if (buttonId === "settings") {
          try {
            lm.openSettings();
          } catch {
            // ignore
          }
        }
      },
    );
    return;
  }

  // Fallback: try to open settings directly (still under a user gesture).
  try {
    lm.openSettings();
  } catch {
    // ignore
  }
}

async function resolveCoordsToForecast(lat, lon, { fallbackName = "Моё местоположение" } = {}) {
  try {
    setStatus("Определяю город…");
    const place = await reversePlace(lat, lon);
    const loc = place
      ? {
          name: place.name,
          admin1: place.admin1,
          country: place.country,
          latitude: place.latitude,
          longitude: place.longitude,
          timezone: place.timezone,
        }
      : { name: fallbackName, latitude: lat, longitude: lon };
    hideSuggestions();
    ui.cityInput.value = "";
    ui.btnClear.hidden = true;
    loadForecast(loc);
  } catch (err) {
    // Reverse geocoding is optional: still show forecast by coordinates.
    console.warn(err);
    const loc = { name: fallbackName, latitude: lat, longitude: lon };
    hideSuggestions();
    ui.cityInput.value = "";
    ui.btnClear.hidden = true;
    loadForecast(loc);
  }
}

async function requestLocationViaTelegram(lm) {
  const tg = getTelegram();
  try {
    if (!lm.isInited && typeof lm.init === "function") {
      await withTimeout(new Promise((resolve) => lm.init(() => resolve())), 6000, "tg location init timeout");
    }
  } catch {
    // ignore init errors; try getLocation anyway
  }

  return withTimeout(
    new Promise((resolve) => {
      let settled = false;

      const finish = (locationData) => {
        if (settled) return;
        settled = true;
        try {
          tg?.offEvent?.("locationRequested", onRequested);
        } catch {
          // ignore
        }
        resolve(locationData || null);
      };

      const onRequested = (eventData) => {
        const ld = eventData?.locationData ?? eventData?.data?.locationData ?? null;
        finish(ld);
      };

      try {
        tg?.onEvent?.("locationRequested", onRequested);
      } catch {
        // ignore
      }

      try {
        lm.getLocation((locationData) => finish(locationData));
      } catch {
        finish(null);
      }
    }),
    45000,
    "tg location timeout",
  );
}

function requestLocationViaBrowser() {
  if (!navigator.geolocation) return Promise.reject(new Error("geolocation not supported"));

  if (typeof window.isSecureContext === "boolean" && window.isSecureContext === false) {
    return Promise.reject(new Error("insecure context"));
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 120000,
    });
  });
}

async function requestLocationViaIp({ signal } = {}) {
  const data = await apiJson("https://geolocation-db.com/json/", { signal });
  const lat = Number(data?.latitude);
  const lon = Number(data?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("ip geolocation failed");
  return { latitude: lat, longitude: lon };
}

function geoDiagShort(lm) {
  const tg = getTelegram();
  const parts = [];
  if (tg) parts.push(`TG ${tg.platform || "?"} v${tg.version || "?"}`);
  if (lm) {
    parts.push(
      `LM inited=${String(lm.isInited)} avail=${String(lm.isLocationAvailable)} requested=${String(lm.isAccessRequested)} granted=${String(lm.isAccessGranted)}`,
    );
  } else if (tg) {
    parts.push("LM отсутствует");
  }
  parts.push(`secure=${String(window.isSecureContext)}`);
  parts.push(`${location.protocol}//${location.host || ""}`.replace(/\/$/, ""));
  return parts.join(" | ");
}

function iconEmoji(symbol, label) {
  const safeSymbol = escapeHtml(symbol || "");
  if (!label) return `<span class="wx-emoji" aria-hidden="true">${safeSymbol}</span>`;
  const safeLabel = escapeHtml(label);
  return `<span class="wx-emoji" role="img" aria-label="${safeLabel}">${safeSymbol}</span>`;
}

function iconSvg(src, label) {
  const safeSrc = escapeHtml(src || "");
  const safeLabel = escapeHtml(label || "");
  return `<img class="wx-icon" src="${safeSrc}" alt="${safeLabel}" loading="lazy" decoding="async" />`;
}

function iconSunLegacy() {
  return iconEmoji("\u2600\uFE0F", "\u042f\u0441\u043d\u043e");
}




function iconCloudLegacy() {
  return iconEmoji("\u2601\uFE0F", "\u041f\u0430\u0441\u043c\u0443\u0440\u043d\u043e");
}




function iconPartlyCloudyLegacy() {
  return iconEmoji("\u26C5\uFE0F", "\u041f\u0435\u0440\u0435\u043c\u0435\u043d\u043d\u0430\u044f \u043e\u0431\u043b\u0430\u0447\u043d\u043e\u0441\u0442\u044c");
}

function iconPartlyCloudySvg() {
  return iconSvg("./images/partly_cloudy.svg", "Переменная облачность");
}




function iconRainLegacy() {
  return iconEmoji("\u{1F327}\uFE0F", "\u0414\u043e\u0436\u0434\u044c");
}




function iconSnowLegacy() {
  return iconEmoji("\u{1F328}\uFE0F", "\u0421\u043d\u0435\u0433");
}




function iconSun() {
  return iconSunLegacy();
}




function iconMoon() {
  return iconEmoji("\u{1F319}", "\u041d\u043e\u0447\u044c");
}




function iconCloud() {
  return iconCloudLegacy();
}




function iconPartlyCloudy() {
  return iconPartlyCloudyLegacy();
}




function iconNightCloudy() {
  return iconSvg("./images/cloudy_moon.svg", "Облачно ночью");
}




function iconFog() {
  return iconEmoji("\u{1F32B}\uFE0F", "\u0422\u0443\u043c\u0430\u043d");
}




function iconDrizzle() {
  return iconEmoji("\u{1F326}\uFE0F", "\u041c\u043e\u0440\u043e\u0441\u044c");
}




function iconRain() {
  return iconRainLegacy();
}




function iconSunshower() {
  return iconEmoji("\u{1F326}\uFE0F", "\u041b\u0438\u0432\u0435\u043d\u044c \u0441 \u0441\u043e\u043b\u043d\u0446\u0435\u043c");
}




function iconSnow() {
  return iconSnowLegacy();
}




function iconThunder() {
  return iconEmoji("\u26C8\uFE0F", "\u0413\u0440\u043e\u0437\u0430");
}




function iconMiniWind() {
  return iconEmoji("\u{1F4A8}");
}




function iconMiniDrop() {
  return iconEmoji("\u{1F4A7}");
}




function iconMiniPressure() {
  return iconEmoji("\u{1F9ED}");
}




function iconMiniUnits() {
  return iconEmoji("\u{1F321}\uFE0F");
}




function formatPlace(loc) {
  const parts = [loc?.name, loc?.admin1, loc?.country].filter(Boolean);
  return parts.join(", ");
}

function dayLabel(dateISO) {
  const d = new Date(`${dateISO}T00:00:00`);
  const w = new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(d);
  const dm = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(d);
  return { w, dm };
}

function unitsLabel() {
  return state.units === "metric" ? "°C" : "°F";
}

function precipUnit() {
  return state.units === "metric" ? "мм" : "in";
}

function windUnit() {
  return state.units === "metric" ? "км/ч" : "mph";
}

function pressureUnit() {
  return "мм рт. ст.";
}

function formatPressureHpa(hPa) {
  const p = Number(hPa);
  if (!Number.isFinite(p)) return null;
  // 1 hPa = 0.750061683 mmHg
  return String(Math.round(p * 0.750061683));
}

function toC(temp) {
  const t = Number(temp);
  if (!Number.isFinite(t)) return NaN;
  return state.units === "metric" ? t : ((t - 32) * 5) / 9;
}

function toKmh(wind) {
  const w = Number(wind);
  if (!Number.isFinite(w)) return NaN;
  return state.units === "metric" ? w : w * 1.60934;
}

function toMm(precip) {
  const p = Number(precip);
  if (!Number.isFinite(p)) return NaN;
  return state.units === "metric" ? p : p * 25.4;
}

function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return dateISO;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ceilToHourISO(isoLocal) {
  const s = String(isoLocal || "");
  const day = s.slice(0, 10);
  const hh = Number(s.slice(11, 13));
  const mm = Number(s.slice(14, 16));
  if (!day || !Number.isFinite(hh) || !Number.isFinite(mm)) return "";

  let nextDay = day;
  let nextHour = hh + (mm > 0 ? 1 : 0);
  if (nextHour >= 24) {
    nextDay = addDaysISO(day, 1);
    nextHour %= 24;
  }
  return `${nextDay}T${String(nextHour).padStart(2, "0")}:00`;
}

function hourlyToEndOfDayItems() {
  const hourly = state.forecast?.hourly;
  const time = hourly?.time;
  if (!Array.isArray(time) || time.length === 0) return [];

  const baseTime = String(state.forecast?.current?.time || time[0] || "");
  const day = baseTime.slice(0, 10);
  if (!day) return [];

  const start = ceilToHourISO(baseTime) || `${day}T00:00`;
  const end = `${day}T23:00`;

  const temperature = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const code = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  const isDay = Array.isArray(hourly.is_day) ? hourly.is_day : [];
  const precipProb = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : null;

  const items = [];
  for (let i = 0; i < time.length; i++) {
    const ts = time[i];
    if (typeof ts !== "string" || !ts.startsWith(day)) continue;
    if (ts < start || ts > end) continue;

    const t = Number(temperature[i]);
    const wmo = Number(code[i]);
    const d = isDay[i];
    const pop = precipProb ? Number(precipProb[i]) : NaN;

    items.push({
      time: ts.slice(11, 16),
      temp: Number.isFinite(t) ? Math.round(t) : null,
      wmo,
      isDay: d === 1 || d === true,
      pop: Number.isFinite(pop) ? Math.round(pop) : null,
    });
  }

  return items;
}

function hourlyNextHoursItems(hoursAhead = 12) {
  const hourly = state.forecast?.hourly;
  const time = hourly?.time;
  if (!Array.isArray(time) || time.length === 0) return [];

  const limit = Math.max(0, Math.floor(Number(hoursAhead) || 0));
  if (!limit) return [];

  const baseTime = String(state.forecast?.current?.time || time[0] || "");
  const start = ceilToHourISO(baseTime) || String(time[0] || "");
  if (!start) return [];

  const temperature = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const code = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  const isDay = Array.isArray(hourly.is_day) ? hourly.is_day : [];
  const precipProb = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : null;

  const items = [];
  for (let i = 0; i < time.length; i++) {
    const ts = time[i];
    if (typeof ts !== "string") continue;
    if (ts < start) continue;

    const t = Number(temperature[i]);
    const wmo = Number(code[i]);
    const d = isDay[i];
    const pop = precipProb ? Number(precipProb[i]) : NaN;

    items.push({
      time: ts.slice(11, 16),
      temp: Number.isFinite(t) ? Math.round(t) : null,
      wmo,
      isDay: d === 1 || d === true,
      pop: Number.isFinite(pop) ? Math.round(pop) : null,
    });

    if (items.length >= limit) break;
  }

  return items;
}

function bindWheelToHorizontalScroll(el) {
  if (!el || el.dataset.wheelScrollBound) return;
  el.dataset.wheelScrollBound = "1";
  el.addEventListener(
    "wheel",
    (e) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
}

function buildTodayRecommendations({ hourlyItems = [] } = {}) {
  const daily = state.forecast?.daily;
  if (!daily) return [];
  const time = Array.isArray(daily.time) ? daily.time : [];
  if (!time.length) return [];

  const baseTime = String(state.forecast?.current?.time || time[0] || "");
  const todayISO = baseTime.slice(0, 10);
  const idx = todayISO ? time.indexOf(todayISO) : -1;
  const i = idx >= 0 ? idx : 0;

  const wmo = Number(daily.weather_code?.[i]);
  const tmax = Number(daily.temperature_2m_max?.[i]);
  const tmin = Number(daily.temperature_2m_min?.[i]);
  const pr = Number(daily.precipitation_sum?.[i]);
  const wind = Number(daily.wind_speed_10m_max?.[i]);
  const sunrise = String(daily.sunrise?.[i] || "").slice(11, 16);
  const sunset = String(daily.sunset?.[i] || "").slice(11, 16);

  const maxC = toC(tmax);
  const minC = toC(tmin);
  const prMm = toMm(pr);
  const windKmh = toKmh(wind);

  const maxPop = hourlyItems
    .map((x) => x?.pop)
    .filter((x) => Number.isFinite(x))
    .reduce((m, v) => Math.max(m, v), -Infinity);
  const hasMaxPop = Number.isFinite(maxPop);

  const tmaxR = Number.isFinite(tmax) ? Math.round(tmax) : null;
  const tminR = Number.isFinite(tmin) ? Math.round(tmin) : null;
  const tLine = Number.isFinite(tminR) && Number.isFinite(tmaxR) ? `${tminR}…${tmaxR}${unitsLabel()}` : null;

  const warmC = Number.isFinite(maxC) ? maxC : minC;

  const tips = [];

  if (tLine && Number.isFinite(warmC)) {
    if (warmC <= -15) tips.push(`Сегодня ${tLine} — очень холодно: шапка и перчатки обязательны.`);
    else if (warmC <= -5) tips.push(`Сегодня ${tLine} — холодно: тёплая куртка и шарф.`);
    else if (warmC <= 5) tips.push(`Сегодня ${tLine} — прохладно: куртка и закрытая обувь.`);
    else if (warmC >= 30) tips.push(`Сегодня ${tLine} — жарко: вода и головной убор.`);
    else if (warmC >= 22) tips.push(`Сегодня ${tLine} — тепло: подойдёт лёгкая одежда.`);
    else tips.push(`Сегодня ${tLine} — комфортно: на вечер может пригодиться лёгкая куртка.`);
  }

  const isFog = [45, 48].includes(wmo);
  const isThunder = wmo >= 95 && wmo <= 99;
  const isSnow = (wmo >= 71 && wmo <= 77) || wmo === 85 || wmo === 86;
  const isRain = (wmo >= 51 && wmo <= 67) || (wmo >= 80 && wmo <= 82);
  const isFreezingRain = wmo === 66 || wmo === 67;
  const isClear = wmo === 0;

  if (isThunder) tips.push("Гроза — избегай открытых пространств и не стой под деревьями во время разрядов.");
  if (isFog) tips.push("Туман — водителям: ближний свет и дистанция.");
  if (isFreezingRain) tips.push("Возможен гололёд — осторожнее на тротуарах и дорогах.");

  const prRounded = Number.isFinite(pr) ? Math.round(pr * 10) / 10 : null;
  if (isSnow) tips.push("Снег — тёплая обувь и осторожнее: может быть скользко.");
  else if (isRain && prRounded !== null && prRounded > 0)
    tips.push(`Ожидаются осадки (≈${prRounded} ${precipUnit()}) — зонт/дождевик пригодятся.`);
  else if (isRain) tips.push("Ожидаются осадки — зонт/дождевик и непромокаемая обувь пригодятся.");

  const precipLikely = (Number.isFinite(prMm) && prMm >= 1) || (hasMaxPop && maxPop >= 60);
  if (!isRain && !isSnow && precipLikely && hasMaxPop) tips.push(`Вероятность осадков высокая (до ${maxPop}%) — зонт может пригодиться.`);
  else if (!isRain && !isSnow && precipLikely) tips.push("Есть шанс осадков — зонт может пригодиться.");

  const windRounded = Number.isFinite(wind) ? Math.round(wind) : null;
  if (Number.isFinite(windKmh) && windKmh >= 35 && windRounded !== null)
    tips.push(`Сильный ветер (до ${windRounded} ${windUnit()}) — лучше капюшон/шапка и держись подальше от деревьев.`);
  else if (Number.isFinite(windKmh) && windKmh >= 35)
    tips.push("Сильный ветер — лучше капюшон/шапка и держись подальше от деревьев.");

  if (isClear && tips.length < 4) tips.push("Ясно — хороший день, чтобы ненадолго выйти прогуляться.");
  if (sunset && tips.length < 5) tips.push(`Темнеет около ${sunset} — планируй прогулки заранее.`);

  return tips.slice(0, 5);
}

async function apiJson(url, { signal } = {}) {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchPlaces(query, { signal } = {}) {
  const q = encodeURIComponent(query.trim());
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=8&language=ru&format=json`;
  const data = await apiJson(url, { signal });
  return Array.isArray(data?.results) ? data.results : [];
}

async function reversePlace(lat, lon, { signal } = {}) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  // Keep it at city level to avoid returning POIs/stores.
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "ru");

  const data = await apiJson(url.toString(), { signal });
  const addr = data?.address || {};

  const name = addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || data?.name || null;
  if (!name) return null;

  const admin1 = addr.state || addr.region || addr.state_district || addr.county || null;
  const country = addr.country || null;

  const latitude = Number(data?.lat ?? lat);
  const longitude = Number(data?.lon ?? lon);

  return {
    name,
    admin1,
    country,
    latitude: Number.isFinite(latitude) ? latitude : lat,
    longitude: Number.isFinite(longitude) ? longitude : lon,
  };
}

function forecastUrl(lat, lon) {
  const base = new URL("https://api.open-meteo.com/v1/forecast");
  base.searchParams.set("latitude", String(lat));
  base.searchParams.set("longitude", String(lon));
  // We hide "today" in the UI, so request 8 days to keep 7 upcoming days.
  base.searchParams.set("forecast_days", "8");
  base.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_speed_10m_max",
      "sunrise",
      "sunset",
    ].join(","),
  );
  base.searchParams.set(
    "hourly",
    ["temperature_2m", "weather_code", "is_day", "precipitation_probability"].join(","),
  );
  base.searchParams.set(
    "current",
    [
      "temperature_2m",
      "apparent_temperature",
      "weather_code",
      "is_day",
      "wind_speed_10m",
      "relative_humidity_2m",
      "pressure_msl",
      "surface_pressure",
    ].join(","),
  );
  base.searchParams.set("timezone", "auto");
  if (state.units === "imperial") {
    base.searchParams.set("temperature_unit", "fahrenheit");
    base.searchParams.set("wind_speed_unit", "mph");
    base.searchParams.set("precipitation_unit", "inch");
  }
  return base.toString();
}

async function loadForecast(loc, { reason = "load" } = {}) {
  if (!loc) return;

  if (state.aborter) state.aborter.abort();
  const aborter = new AbortController();
  state.aborter = aborter;

  setStatus(reason === "refresh" ? "Обновляю прогноз…" : "Загружаю прогноз…");
  ui.forecast.innerHTML = skeletonCards();

  try {
    const url = forecastUrl(loc.latitude, loc.longitude);
    const data = await apiJson(url, { signal: aborter.signal });
    state.forecast = data;
    state.location = loc;
    savePrefs();
    pushRecent(loc);
    renderAll();
    setStatus("");
  } catch (err) {
    if (aborter.signal.aborted) return;
    console.error(err);
    setStatus("Не удалось загрузить прогноз. Проверьте интернет и попробуйте ещё раз.", "error");
    ui.forecast.innerHTML = "";
  }
}

function skeletonCards() {
  return Array.from({ length: 7 })
    .map(
      () => `
      <div class="card" style="opacity:.6">
        <div class="card__head">
          <div>
            <div class="card__day" style="width:80px;height:14px;background:rgba(255,255,255,.08);border-radius:8px"></div>
            <div class="card__date" style="margin-top:8px;width:56px;height:12px;background:rgba(255,255,255,.06);border-radius:8px"></div>
          </div>
          <div class="card__icon" style="background:rgba(255,255,255,.06)"></div>
        </div>
        <div class="card__temp">
          <div class="card__tmax" style="width:64px;height:22px;background:rgba(255,255,255,.08);border-radius:10px"></div>
          <div class="card__tmin" style="width:44px;height:16px;background:rgba(255,255,255,.06);border-radius:10px"></div>
        </div>
        <div class="card__meta">
          <span class="pill" style="width:72px;height:14px"></span>
          <span class="pill" style="width:60px;height:14px"></span>
        </div>
      </div>
    `,
    )
    .join("");
}

function renderRecent() {
  const items = getRecent();
  if (!items.length) {
    ui.recent.hidden = true;
    ui.recent.innerHTML = "";
    return;
  }
  ui.recent.hidden = false;
  ui.recent.innerHTML = items
    .map((loc) => {
      const name = escapeHtml(loc.name);
      return `
        <button class="chip" type="button" data-lat="${loc.latitude}" data-lon="${loc.longitude}" aria-label="Выбрать: ${name}">
          <span class="chip__label">${name}</span>
          <span class="chip__remove" data-remove title="Удалить" aria-label="Удалить">×</span>
        </button>
      `;
    })
    .join("");

  ui.recent.querySelectorAll("button[data-lat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lat = Number(btn.dataset.lat);
      const lon = Number(btn.dataset.lon);
      const loc = items.find((x) => Number(x.latitude) === lat && Number(x.longitude) === lon) || null;
      if (loc) {
        ui.cityInput.value = "";
        ui.btnClear.hidden = true;
        hideSuggestions();
        loadForecast(loc);
      }
    });
  });

  ui.recent.querySelectorAll("[data-remove]").forEach((xBtn) => {
    xBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chip = xBtn.closest("button[data-lat]");
      if (!chip) return;
      removeRecent(chip.dataset.lat, chip.dataset.lon);
      renderRecent();
    });
  });

  bindWheelToHorizontalScroll(ui.recent);
}

function formatUtcOffset(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "";

  const sign = s >= 0 ? "+" : "-";
  const abs = Math.abs(s);
  const hh = Math.floor(abs / 3600);
  const mm = Math.floor((abs % 3600) / 60);
  const hm = mm ? `${hh}:${String(mm).padStart(2, "0")}` : String(hh);
  return `UTC${sign}${hm}`;
}

function stopCurrentClock() {
  if (currentClockTimeout) {
    window.clearTimeout(currentClockTimeout);
    currentClockTimeout = null;
  }
  if (currentClockInterval) {
    window.clearInterval(currentClockInterval);
    currentClockInterval = null;
  }
}

function startCurrentClock({ timeZone, timeZoneAbbr, utcOffsetSeconds } = {}) {
  stopCurrentClock();

  if (!ui.clock) return;

  const dateEl = ui.clock.querySelector("[data-clock-date]");
  const timeEl = ui.clock.querySelector("[data-clock-time]");
  const tzEl = ui.clock.querySelector("[data-clock-tz]");
  if (!timeEl || !tzEl) return;

  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  const abbr = typeof timeZoneAbbr === "string" ? timeZoneAbbr.trim() : "";
  const offset = formatUtcOffset(utcOffsetSeconds);

  tzEl.textContent = (abbr && offset ? `${abbr} (${offset})` : abbr || offset || tz) || "—";
  tzEl.title = tz || "";

  let timeFmt = null;
  let dateFmt = null;
  let canUseIntlTimeZone = false;
  try {
    timeFmt = new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || undefined,
    });
    dateFmt = new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: tz || undefined,
    });
    canUseIntlTimeZone = Boolean(tz);
  } catch {
    timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
    dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  const tick = () => {
    try {
      if (canUseIntlTimeZone) {
        const now = new Date();
        timeEl.textContent = timeFmt.format(now);
        if (dateEl) dateEl.textContent = dateFmt.format(now);
        return;
      }

      const offsetSeconds = Number(utcOffsetSeconds);
      if (Number.isFinite(offsetSeconds)) {
        const d = new Date(Date.now() + offsetSeconds * 1000);
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mm = String(d.getUTCMinutes()).padStart(2, "0");
        timeEl.textContent = `${hh}:${mm}`;
        if (dateEl) {
          const dd = String(d.getUTCDate()).padStart(2, "0");
          const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
          const yyyy = String(d.getUTCFullYear());
          dateEl.textContent = `${dd}.${mo}.${yyyy}`;
        }
        return;
      }

      const now = new Date();
      timeEl.textContent = timeFmt.format(now);
      if (dateEl) dateEl.textContent = dateFmt.format(now);
    } catch {
      timeEl.textContent = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      if (dateEl) dateEl.textContent = new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    }
  };

  tick();

  const msToNextMinute = 60000 - (Date.now() % 60000);
  currentClockTimeout = window.setTimeout(() => {
    tick();
    currentClockInterval = window.setInterval(tick, 60000);
  }, msToNextMinute + 50);
}

function renderClock() {
  if (!ui.clock) return;

  const cur = state.forecast?.current;
  if (!cur || typeof cur !== "object") {
    stopCurrentClock();
    ui.clock.hidden = true;
    ui.clock.innerHTML = "";
    return;
  }

  ui.clock.hidden = false;
  ui.clock.innerHTML = `
    <div class="clock__value">
      <span class="clock__date" data-clock-date>—</span>
      <span class="clock__time" data-clock-time>—</span>
      <span class="clock__sep">•</span>
      <span class="clock__tz" data-clock-tz>—</span>
    </div>
  `;

  startCurrentClock({
    timeZone: state.forecast?.timezone || state.location?.timezone,
    timeZoneAbbr: state.forecast?.timezone_abbreviation,
    utcOffsetSeconds: state.forecast?.utc_offset_seconds,
  });
}

function renderCurrent() {
  const cur = state.forecast?.current;
  if (!cur || typeof cur !== "object") {
    stopCurrentClock();
    if (ui.clock) {
      ui.clock.hidden = true;
      ui.clock.innerHTML = "";
    }
    ui.current.hidden = true;
    ui.current.innerHTML = "";
    return;
  }

  const isDay = Boolean(cur.is_day);
  const info = wmoInfo(cur.weather_code, isDay);
  const t = Math.round(cur.temperature_2m);
  const feels = Number(cur.apparent_temperature);
  const tf = Number.isFinite(feels) ? Math.round(feels) : null;
  const w = Math.round(cur.wind_speed_10m);
  const rh = Number(cur.relative_humidity_2m);
  const h = Number.isFinite(rh) ? Math.round(rh) : null;
  const p = formatPressureHpa(cur.pressure_msl ?? cur.surface_pressure);
  const desc = info.label;

  const hourlyItems = hourlyNextHoursItems(12);
  const hourlyHtml = hourlyItems.length
    ? `
      <div class="current__hourly">
        <div class="current__hourly-title">По часам на 12 часов вперёд</div>
        <div class="hourly" data-hourly-scroll role="list" aria-label="Погода по часам на 12 часов вперёд">
          ${hourlyItems
            .map((x) => {
              const infoH = wmoInfo(x.wmo, x.isDay);
              const tempH = Number.isFinite(x.temp) ? `${x.temp}${unitsLabel()}` : "—";
              return `
                <div class="hour" role="listitem" title="${escapeHtml(infoH.label)}">
                  <div class="hour__time">${escapeHtml(x.time)}</div>
                  <div class="hour__icon" aria-hidden="true">${infoH.icon}</div>
                  <div class="hour__temp">${escapeHtml(tempH)}</div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `
    : "";

  const tips = buildTodayRecommendations({ hourlyItems: hourlyToEndOfDayItems() });
  const tipsHtml = tips.length
    ? `
      <div class="current__tips">
        <div class="current__tips-title">Рекомендации на сегодня</div>
        <ul class="tips" aria-label="Рекомендации на сегодня">
          ${tips.map((text) => `<li class="tip">${escapeHtml(text)}</li>`).join("")}
        </ul>
      </div>
    `
    : "";

  ui.current.hidden = false;
  ui.current.innerHTML = `
    <div class="current__top">
      <div class="card__icon current__icon" aria-hidden="true">${info.icon}</div>
      <div class="current__main">
        <div class="current__temp">
          ${t}${unitsLabel()}
          ${tf !== null ? `<div class="current__feels">ощущается ${tf}${unitsLabel()}</div>` : ""}
        </div>
        <div class="current__desc">${escapeHtml(desc)}</div>
      </div>
    </div>
    <div class="current__meta" data-meta-scroll role="list" aria-label="Параметры сейчас">
      <div class="pill meta-pill" role="listitem">${iconMiniWind()} Ветер: <b>${w}</b> ${windUnit()}</div>
      ${h !== null ? `<div class="pill meta-pill" role="listitem">${iconMiniDrop()} Влажность: <b>${h}</b>%</div>` : ""}
      ${p !== null ? `<div class="pill meta-pill" role="listitem">${iconMiniPressure()} Давление: <b>${escapeHtml(p)}</b> ${pressureUnit()}</div>` : ""}
      <div class="pill meta-pill" role="listitem">${iconMiniUnits()} Единицы: <b>${state.units === "metric" ? "метрические" : "имперские"}</b></div>
    </div>
    ${hourlyHtml}
    ${tipsHtml}
  `;

  const scroller = ui.current.querySelector("[data-hourly-scroll]");
  if (scroller) bindWheelToHorizontalScroll(scroller);

  const metaScroller = ui.current.querySelector("[data-meta-scroll]");
  if (metaScroller) bindWheelToHorizontalScroll(metaScroller);
}

function renderForecast() {
  const daily = state.forecast?.daily;
  const time = daily?.time;
  if (!Array.isArray(time) || time.length === 0) {
    ui.forecast.innerHTML = "";
    return;
  }

  const tmax = daily.temperature_2m_max || [];
  const tmin = daily.temperature_2m_min || [];
  const wcode = daily.weather_code || [];
  const precip = daily.precipitation_sum || [];
  const wind = daily.wind_speed_10m_max || [];

  const start = 1; // skip today
  const end = Math.min(time.length, start + 7);
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, i) => i + start);

  ui.forecast.innerHTML = indices
    .map((dayIdx) => {
      const dateISO = time[dayIdx];
      const { w, dm } = dayLabel(dateISO);
      const info = wmoInfo(wcode[dayIdx], true);
      const max = Math.round(tmax[dayIdx]);
      const min = Math.round(tmin[dayIdx]);
      const pr = Math.round(precip[dayIdx] * 10) / 10;
      const wi = Math.round(wind[dayIdx]);

      return `
        <article class="card" role="button" tabindex="0" data-idx="${dayIdx}" aria-label="Детали за ${escapeHtml(dm)}">
          <div class="card__head">
            <div>
              <div class="card__day">${escapeHtml(w)}</div>
              <div class="card__date">${escapeHtml(dm)}</div>
            </div>
            <div class="card__icon" aria-hidden="true">${info.icon}</div>
          </div>
          <div class="card__temp">
            <div class="card__tmax">${max}${unitsLabel()}</div>
            <div class="card__tmin">${min}${unitsLabel()}</div>
          </div>
          <div class="card__meta">
            <span class="pill">Осадки: ${escapeHtml(String(pr))} ${precipUnit()}</span>
            <span class="pill">Ветер: ${escapeHtml(String(wi))} ${windUnit()}</span>
          </div>
        </article>
      `;
    })
    .join("");

  ui.forecast.querySelectorAll(".card[data-idx]").forEach((card) => {
    card.addEventListener("click", () => openDetails(Number(card.dataset.idx)));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetails(Number(card.dataset.idx));
      }
    });
  });
}

function openDetails(idx) {
  const daily = state.forecast?.daily;
  if (!daily) return;

  const dateISO = daily.time?.[idx];
  if (!dateISO) return;

  const wmo = Number(daily.weather_code?.[idx]);
  setWxScene(wxSceneFromWmo(wmo, true), { bright: wmo === 0 });

  const info = wmoInfo(wmo, true);
  const { w, dm } = dayLabel(dateISO);
  const max = Math.round(daily.temperature_2m_max?.[idx]);
  const min = Math.round(daily.temperature_2m_min?.[idx]);
  const pr = Math.round((daily.precipitation_sum?.[idx] ?? 0) * 10) / 10;
  const wi = Math.round(daily.wind_speed_10m_max?.[idx] ?? 0);
  const sunrise = (daily.sunrise?.[idx] || "").slice(11, 16);
  const sunset = (daily.sunset?.[idx] || "").slice(11, 16);

  ui.sheetContent.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <h2>${escapeHtml(w)} • ${escapeHtml(dm)}</h2>
        <div class="subtitle">${escapeHtml(info.label)}</div>
      </div>
      <div class="card__icon" aria-hidden="true">${info.icon}</div>
    </div>
    <div class="grid2">
      <div class="kv"><div class="k">Макс / мин</div><div class="v">${max}${unitsLabel()} / ${min}${unitsLabel()}</div></div>
      <div class="kv"><div class="k">Осадки</div><div class="v">${escapeHtml(String(pr))} ${precipUnit()}</div></div>
      <div class="kv"><div class="k">Ветер (макс)</div><div class="v">${escapeHtml(String(wi))} ${windUnit()}</div></div>
      <div class="kv"><div class="k">Восход / закат</div><div class="v">${escapeHtml(sunrise || "—")} / ${escapeHtml(sunset || "—")}</div></div>
    </div>
    ${renderTempChart()}
    <button id="btnCloseSheet" class="btn" type="button">Закрыть</button>
  `;

  $("#btnCloseSheet")?.addEventListener("click", closeDetails);
  showSheet();
}

function renderTempChart() {
  const daily = state.forecast?.daily;
  if (!daily) return "";
  const tmax = (daily.temperature_2m_max || []).slice(1, 8).map((x) => Number(x));
  const tmin = (daily.temperature_2m_min || []).slice(1, 8).map((x) => Number(x));
  if (tmax.length < 2 || tmin.length < 2) return "";

  const all = [...tmax, ...tmin];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = Math.max(2, (hi - lo) * 0.12);
  const minY = lo - pad;
  const maxY = hi + pad;

  const W = 320;
  const H = 92;
  const step = W / (tmax.length - 1);
  const y = (temp) => {
    const t = (temp - minY) / (maxY - minY);
    return Math.round((1 - t) * (H - 12) + 6);
  };

  const points = (arr) => arr.map((temp, i) => `${Math.round(i * step)},${y(temp)}`).join(" ");

  const maxPts = points(tmax);
  const minPts = points(tmin);

  const label = state.units === "metric" ? "Температура, °C" : "Температура, °F";

  return `
    <div class="chart" aria-label="${escapeHtml(label)}">
      <div class="subtitle" style="margin:0 0 8px">${escapeHtml(label)}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-hidden="true">
        <polyline points="${escapeHtml(maxPts)}" fill="none" stroke="rgba(110,231,255,.9)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        <polyline points="${escapeHtml(minPts)}" fill="none" stroke="rgba(167,139,250,.9)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="subtitle" style="display:flex;flex-wrap:wrap;gap:12px;margin:0">
        <span>Макс: <b style="color:var(--fg)">${Math.round(Math.max(...tmax))}${unitsLabel()}</b></span>
        <span>Мин: <b style="color:var(--fg)">${Math.round(Math.min(...tmin))}${unitsLabel()}</b></span>
      </div>
    </div>
  `;
}

function showSheet() {
  ui.sheetBackdrop.hidden = false;
  ui.sheet.classList.add("sheet--open");
  ui.sheet.setAttribute("aria-hidden", "false");
  syncTelegramBackButton();
}

function closeDetails() {
  ui.sheet.classList.remove("sheet--open");
  ui.sheet.setAttribute("aria-hidden", "true");
  syncTelegramBackButton();
  applyWeatherBackground();
  setTimeout(() => {
    ui.sheetBackdrop.hidden = true;
    ui.sheetContent.innerHTML = "";
  }, 240);
}

function syncTelegramBackButton() {
  const tg = getTelegram();
  if (!tg?.BackButton || !tgIsVersionAtLeast(tg, "6.1")) return;
  try {
    if (ui.sheet.classList.contains("sheet--open")) tg.BackButton.show();
    else tg.BackButton.hide();
  } catch {
    // ignore
  }
}

function hideSuggestions() {
  ui.suggestions.hidden = true;
  ui.suggestions.innerHTML = "";
}

function renderAll() {
  ui.btnUnits.textContent = unitsLabel();

  const loc = state.location;
  ui.subtitle.textContent = loc ? formatPlace(loc) : "Выберите город или используйте геолокацию";

  renderRecent();
  renderClock();
  renderCurrent();
  applyWeatherBackground();
  renderForecast();
  syncTelegramMainButton();
}

function setUnits(nextUnits) {
  state.units = nextUnits;
  savePrefs();
  renderAll();
  if (state.location) loadForecast(state.location, { reason: "refresh" });
}

function toggleUnits() {
  setUnits(state.units === "metric" ? "imperial" : "metric");
}

async function useGeolocation() {
  const tg = getTelegram();
  const insideTelegram = Boolean(tg?.initData);
  const maybeNeedsTgUpdate =
    insideTelegram ? !tgIsVersionAtLeast(tg, "8.0") : false;

  setStatus("Запрашиваю геолокацию…");

  const lm = getTelegramLocationManager();
  let tgNote = "";
  let browserErr = null;

  if (lm) {
    try {
      const locData = await requestLocationViaTelegram(lm);
      const lat = Number(locData?.latitude);
      const lon = Number(locData?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        await resolveCoordsToForecast(lat, lon);
        return;
      }
    } catch (err) {
      console.error(err);
      tgNote = "Не удалось получить геолокацию через Telegram.";
    }

    if (lm.isLocationAvailable === false) {
      tgNote = "Геолокация недоступна на устройстве (Telegram).";
    } else if (lm.isAccessGranted === false) {
      tgNote = "Нет доступа к геолокации в Telegram.";
      promptOpenTgLocationSettings();
    }
  } else if (insideTelegram) {
    tgNote = maybeNeedsTgUpdate
      ? "В Telegram нет API геолокации (нужна версия WebApp 8.0+)."
      : "В Telegram нет API геолокации.";
  }

  try {
    const pos = await requestLocationViaBrowser();
    await resolveCoordsToForecast(pos.coords.latitude, pos.coords.longitude);
    return;
  } catch (err) {
    console.error(err);
    browserErr = err;
  }

  try {
    const prefix = tgNote ? `${tgNote}\n` : "";
    setStatus(`${prefix}Определяю местоположение по IP (примерно)…`);
    const ip = await requestLocationViaIp();
    await resolveCoordsToForecast(ip.latitude, ip.longitude, { fallbackName: "Моё местоположение (по IP)" });
    return;
  } catch (err) {
    console.error(err);
  }

  const err = browserErr;

  if (String(err?.message) === "geolocation not supported") {
    if (insideTelegram) {
      const hint = maybeNeedsTgUpdate
        ? "Обновите Telegram (нужна версия с WebApp API 8.0+) или выберите город вручную."
        : "Выберите город вручную.";
      setStatus(`Геолокация недоступна в Telegram на этом устройстве. ${hint}\n${geoDiagShort(lm)}`, "error");
      return;
    }
    setStatus("Геолокация не поддерживается этим устройством. Выберите город вручную.", "error");
    return;
  }
  if (String(err?.message) === "insecure context") {
    setStatus(`Геолокация работает только по HTTPS (или localhost).\n${geoDiagShort(lm)}`, "error");
    return;
  }
  if (err?.code === 1) {
    setStatus(`Доступ к геолокации отклонён. Разрешите доступ и попробуйте ещё раз.\n${geoDiagShort(lm)}`, "error");
    if (insideTelegram) promptOpenTgLocationSettings();
    return;
  }
  if (err?.code === 2) {
    setStatus(`Не удалось определить местоположение. Проверьте GPS/сеть и попробуйте ещё раз.\n${geoDiagShort(lm)}`, "error");
    return;
  }
  if (err?.code === 3) {
    setStatus(`Таймаут геолокации. Попробуйте ещё раз.\n${geoDiagShort(lm)}`, "error");
    return;
  }
  const extra = insideTelegram && (maybeNeedsTgUpdate || !lm) ? " Обновите Telegram или выберите город вручную." : "";
  setStatus(`Не удалось получить геолокацию. Попробуйте ещё раз.${extra}\n${geoDiagShort(lm)}`, "error");
}

const onSearchInput = debounce(async () => {
  const q = ui.cityInput.value.trim();
  ui.btnClear.hidden = q.length === 0;
  if (q.length < 2) {
    hideSuggestions();
    return;
  }

  try {
    if (state.searchAborter) state.searchAborter.abort();
    const aborter = new AbortController();
    state.searchAborter = aborter;
    const queryAtStart = q;

    const results = await searchPlaces(queryAtStart, { signal: aborter.signal });
    if (aborter.signal.aborted) return;
    if (ui.cityInput.value.trim() !== queryAtStart) return;
    if (!results.length) {
      ui.suggestions.hidden = false;
      ui.suggestions.innerHTML = `<div style="padding:12px;color:var(--muted)">Ничего не найдено</div>`;
      return;
    }
    ui.suggestions.hidden = false;
    ui.suggestions.innerHTML = results
      .slice(0, 8)
      .map((r) => {
        const primary = escapeHtml(r.name);
        const secondary = escapeHtml([r.admin1, r.country].filter(Boolean).join(", "));
        return `
          <button type="button" data-lat="${r.latitude}" data-lon="${r.longitude}">
            <div>${primary}</div>
            <div class="secondary">${secondary}</div>
          </button>
        `;
      })
      .join("");

    ui.suggestions.querySelectorAll("button[data-lat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const lat = Number(btn.dataset.lat);
        const lon = Number(btn.dataset.lon);
        const picked = results.find((x) => Number(x.latitude) === lat && Number(x.longitude) === lon);
        if (!picked) return;
        const loc = {
          name: picked.name,
          admin1: picked.admin1,
          country: picked.country,
          latitude: picked.latitude,
          longitude: picked.longitude,
          timezone: picked.timezone,
        };
        hideSuggestions();
        ui.cityInput.value = "";
        ui.btnClear.hidden = true;
        loadForecast(loc);
      });
    });
  } catch (err) {
    if (state.searchAborter?.signal?.aborted) return;
    console.error(err);
    // Quietly ignore search errors; keep UX calm.
  }
}, 260);

// --- Telegram WebApp integration (optional) ---

function getTelegram() {
  return window.Telegram?.WebApp || null;
}

function parseTgVersion(v) {
  return String(v || "")
    .split(".")
    .slice(0, 3)
    .map((x) => Number(x))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

function tgIsVersionAtLeast(tg, minVersion) {
  if (!tg) return false;
  try {
    if (typeof tg.isVersionAtLeast === "function") return tg.isVersionAtLeast(minVersion);
  } catch {
    // ignore
  }

  const cur = parseTgVersion(tg.version);
  const min = parseTgVersion(minVersion);
  for (let i = 0; i < 3; i++) {
    const a = cur[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function applyTelegramTheme(tg) {
  if (state.theme !== "auto") return;
  const p = tg?.themeParams || {};
  const root = document.documentElement;

  // Telegram supplies hex colors; use them as hints, but keep contrast.
  if (p.bg_color) root.style.setProperty("--bg", p.bg_color);
  if (p.text_color) root.style.setProperty("--fg", p.text_color);
  if (p.hint_color) root.style.setProperty("--muted", p.hint_color);
  if (p.secondary_bg_color) root.style.setProperty("--card", p.secondary_bg_color);
  if (p.button_color) root.style.setProperty("--accent", p.button_color);
  if (p.secondary_bg_color) root.style.setProperty("--card-2", p.secondary_bg_color);

  const supportsColors = tgIsVersionAtLeast(tg, "6.1");
  if (supportsColors && typeof tg.setHeaderColor === "function") {
    try {
      // Prefer token values to match Telegram UI where possible.
      tg.setHeaderColor(p.bg_color ? "bg_color" : "secondary_bg_color");
    } catch {
      // ignore
    }
  }
  if (supportsColors && typeof tg.setBackgroundColor === "function" && p.bg_color) {
    try {
      tg.setBackgroundColor(p.bg_color);
    } catch {
      // ignore
    }
  }
}

function syncTelegramMainButton() {
  const tg = getTelegram();
  if (!tg?.MainButton) return;

  const ready = Boolean(state.location && state.forecast?.daily?.time?.length);
  if (!ready) {
    tg.MainButton.hide();
    return;
  }

  tg.MainButton.setText("Отправить прогноз");
  tg.MainButton.color = tg.themeParams?.button_color || "#2ea6ff";
  tg.MainButton.textColor = tg.themeParams?.button_text_color || "#ffffff";
  tg.MainButton.show();
  if (typeof tg.MainButton.enable === "function") tg.MainButton.enable();

  // Ensure we only have one handler.
  if (!state.tgMainBound) {
    state.tgMainBound = true;
    const onMainClick = () => {
      try {
        const liveTg = getTelegram();
        if (!liveTg || typeof liveTg.sendData !== "function") {
          throw new Error("Telegram WebApp sendData() is not available");
        }

        if (typeof liveTg.MainButton?.showProgress === "function") liveTg.MainButton.showProgress();
        if (typeof liveTg.MainButton?.disable === "function") liveTg.MainButton.disable();

        setStatus("Отправляю прогноз…");
        const payload = buildSharePayload();
        liveTg.sendData(JSON.stringify(payload));
        liveTg.HapticFeedback?.impactOccurred?.("light");

        const doneText = "Готово! Прогноз отправлен. Вернитесь в чат.";
        if (typeof liveTg.showAlert === "function") {
          liveTg.showAlert(doneText, () => {
            if (typeof liveTg.close === "function") liveTg.close();
          });
        } else {
          setStatus(doneText);
          if (typeof liveTg.close === "function") setTimeout(() => liveTg.close(), 250);
        }
      } catch (err) {
        console.error(err);
        setStatus("Не удалось отправить прогноз. Проверьте, что мини‑приложение открыто из Telegram.", "error");

        const liveTg = getTelegram();
        if (typeof liveTg?.MainButton?.hideProgress === "function") liveTg.MainButton.hideProgress();
        if (typeof liveTg?.MainButton?.enable === "function") liveTg.MainButton.enable();
        liveTg?.showAlert?.("Не удалось отправить данные.");
      }
    };

    if (typeof tg.MainButton.onClick === "function") tg.MainButton.onClick(onMainClick);
    else tg.onEvent?.("mainButtonClicked", onMainClick);
  }
}

function buildSharePayload() {
  const daily = state.forecast?.daily || {};
  const time = Array.isArray(daily.time) ? daily.time : [];
  const start = 1;
  const end = Math.min(time.length, start + 7);
  const items = Array.from({ length: Math.max(0, end - start) }, (_, i) => i + start).map((dayIdx) => ({
    date: time[dayIdx],
    wmo: Number(daily.weather_code?.[dayIdx]),
    tmax: Number(daily.temperature_2m_max?.[dayIdx]),
    tmin: Number(daily.temperature_2m_min?.[dayIdx]),
    pr: Number(daily.precipitation_sum?.[dayIdx]),
    wind: Number(daily.wind_speed_10m_max?.[dayIdx]),
  }));

  return {
    type: "forecast_v1",
    units: state.units,
    location: state.location,
    items,
  };
}

function initTelegram() {
  const tg = getTelegram();
  if (!tg) return;
  tg.ready();
  tg.expand?.();
  scheduleViewportSync();
  applyTelegramTheme(tg);
  tg.onEvent?.("themeChanged", () => {
    applyTelegramTheme(tg);
    applyTheme();
    syncTelegramMainButton();
  });
  tg.onEvent?.("viewportChanged", scheduleViewportSync);

  if (tg.BackButton && !tg.__wxappBackBound && tgIsVersionAtLeast(tg, "6.1")) {
    try {
      tg.BackButton.onClick(() => {
        if (ui.sheet.classList.contains("sheet--open")) closeDetails();
      });
      tg.__wxappBackBound = true;
    } catch {
      // ignore
    }
  }
}

// --- wire up ---

function init() {
  initViewportSync();
  loadPrefs();
  initTheme();
  initTelegram();
  syncTelegramBackButton();
  syncUserCount();

  ui.btnUnits.addEventListener("click", toggleUnits);
  ui.btnGeo.addEventListener("click", useGeolocation);
  ui.btnTheme?.addEventListener("click", toggleTheme);
  ui.btnRefresh.addEventListener("click", () => state.location && loadForecast(state.location, { reason: "refresh" }));
  ui.btnClear.addEventListener("click", () => {
    ui.cityInput.value = "";
    ui.btnClear.hidden = true;
    hideSuggestions();
    ui.cityInput.focus();
  });
  ui.cityInput.addEventListener("input", onSearchInput);
  ui.cityInput.addEventListener("focus", () => ui.cityInput.value.trim().length >= 2 && onSearchInput());

  ui.sheetBackdrop.addEventListener("click", closeDetails);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeDetails());

  renderAll();
  if (state.location) loadForecast(state.location);
  else renderRecent();
}

init();
