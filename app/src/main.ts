import "./style.css";
import { getSDK } from "@discourse-mini-app/sdk";
import type { MiniAppError, MiniAppTheme } from "@discourse-mini-app/sdk";
import { createAudio } from "./audio.ts";
import {
  createCloudController,
  isWishTarget,
  normalizeWishInput,
} from "./cloud.ts";
import type {
  CloudController,
  CloudState,
  InitializeStatus,
  Wish,
  WishTarget,
} from "./cloud.ts";
import { createDiscourseCloudAdapter } from "./discourse-cloud.ts";
import { createHost } from "./host.ts";
import { dateKey } from "./merit.ts";
import { createPreviewCloudAdapter } from "./preview-cloud.ts";
import messages from "./strings.json";

type Elements = {
  app: HTMLElement;
  "brand-icon": HTMLImageElement;
  total: HTMLElement;
  today: HTMLElement;
  "fish-stage": HTMLElement;
  fish: HTMLButtonElement;
  "fish-visual": HTMLElement;
  "fish-image": HTMLImageElement;
  "fish-fallback": HTMLElement;
  "float-layer": HTMLElement;
  instruction: HTMLElement;
  notice: HTMLElement;
  "sound-toggle": HTMLButtonElement;
  "sound-label": HTMLElement;
  "sound-on-icon": SVGElement;
  "sound-off-icon": SVGElement;
  "sound-checkbox": HTMLInputElement;
  "fullscreen-toggle": HTMLButtonElement;
  "fullscreen-label": HTMLElement;
  "settings-open": HTMLButtonElement;
  "settings-dialog": HTMLDialogElement;
  "settings-close": HTMLButtonElement;
  "sync-status": HTMLElement;
  "sync-label": HTMLElement;
  "wish-area": HTMLElement;
  "wish-open": HTMLButtonElement;
  "wish-current": HTMLButtonElement;
  "wish-current-text": HTMLElement;
  "wish-progress": HTMLProgressElement;
  "wish-progress-text": HTMLElement;
  "access-gate": HTMLElement;
  "gate-title": HTMLElement;
  "gate-message": HTMLElement;
  "gate-retry": HTMLButtonElement;
  "wish-dialog": HTMLDialogElement;
  "wish-close": HTMLButtonElement;
  "wish-form": HTMLFormElement;
  "wish-input": HTMLTextAreaElement;
  "wish-count": HTMLElement;
  "wish-target": HTMLSelectElement;
  "wish-create": HTMLButtonElement;
  "wish-error": HTMLElement;
  "wish-active-detail": HTMLElement;
  "wish-detail-content": HTMLElement;
  "wish-detail-progress": HTMLElement;
  "wish-history-details": HTMLDetailsElement;
  "wish-history": HTMLUListElement;
  "wish-complete-dialog": HTMLDialogElement;
  "complete-wish-text": HTMLElement;
  "wish-seal": HTMLElement;
  "wish-seal-progress": HTMLElement;
  "wish-seal-text": HTMLElement;
  "wish-complete-close": HTMLButtonElement;
};

const element = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof Elements
    ? Elements[Id]
    : HTMLElement;

const app = element("app");
const sdk = import.meta.env.DEV ? null : getSDK();
const emptyCloudState = (): CloudState => ({
  version: 1,
  total: 0,
  day: dateKey(new Date()),
  today: 0,
  sound: true,
  revision: 0,
  activeWish: null,
  wishes: [],
  justReachedTarget: false,
});
let state = emptyCloudState();
let cloud: CloudController;
let locale: keyof typeof messages = "zh_CN";
let reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
app.dataset.reducedMotion = String(reducedMotion);
document.documentElement.dataset.reducedMotion = String(reducedMotion);
let initialized = false;
let gateStatus: InitializeStatus | "loading" = "loading";
let syncPaused = false;
let syncing = false;
let wishBusy = false;
let fullscreenActive = false;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let completionTimer: ReturnType<typeof setTimeout> | null = null;
let completionLocked = false;
let fishAnimation: Animation | null = null;
let fishUrl: string | null = null;
let connecting: Promise<void> | null = null;
const completionShown = new Set<string>();

function t(key: keyof (typeof messages)["zh_CN"]): string {
  return messages[locale][key] ?? messages.zh_CN[key] ?? key;
}

function showNotice(key: keyof (typeof messages)["zh_CN"] | string) {
  const known = Object.hasOwn(messages.zh_CN, key);
  element("notice").textContent = known
    ? t(key as keyof (typeof messages)["zh_CN"])
    : key;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => element("notice").textContent = "", 3500);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale === "zh_CN" ? "zh-CN" : "en-US").format(value);
}

function localize() {
  document.querySelectorAll<HTMLElement>("[data-text]").forEach((node) => {
    node.textContent = t(node.dataset.text as keyof (typeof messages)["zh_CN"]);
  });
  if (initialized) element("instruction").textContent = t("instruction");
  element("fish").setAttribute("aria-label", t("hitAria"));
  element("wish-input").placeholder = t("wishPlaceholder");
  updateControls();
  renderGate();
  renderSyncStatus();
}

function renderWishHistory() {
  const list = element("wish-history");
  list.replaceChildren();
  element("wish-history-details").hidden = state.wishes.length === 0;
  for (const wish of state.wishes.slice(0, 5)) {
    const item = document.createElement("li");
    const content = document.createElement("p");
    content.textContent = wish.content;
    const meta = document.createElement("span");
    const date = wish.completedAt ? new Date(wish.completedAt) : null;
    const dateText = date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat(locale === "zh_CN" ? "zh-CN" : "en-US").format(date)
      : "";
    meta.textContent = `${wish.target} / ${wish.target}${dateText ? ` · ${dateText}` : ""}`;
    item.append(content, meta);
    list.append(item);
  }
}

function render() {
  element("total").textContent = formatNumber(state.total);
  element("today").textContent = formatNumber(state.today);
  element("sound-checkbox").checked = state.sound;
  const wish = state.activeWish;
  element("wish-open").hidden = wish !== null;
  element("wish-current").hidden = wish === null;
  if (wish) {
    element("wish-current-text").textContent = wish.content;
    element("wish-progress").max = wish.target;
    element("wish-progress").value = wish.progress;
    element("wish-progress-text").textContent = `${formatNumber(wish.progress)} / ${formatNumber(wish.target)}`;
  }
  element("wish-detail-content").textContent = wish?.content ?? "";
  element("wish-detail-progress").textContent = wish
    ? `${formatNumber(wish.progress)} / ${formatNumber(wish.target)}`
    : "";
  renderWishHistory();
  updateControls();
}

function setControlsEnabled(enabled: boolean) {
  for (const id of [
    "fish",
    "sound-toggle",
    "fullscreen-toggle",
    "settings-open",
    "sound-checkbox",
    "wish-open",
    "wish-current",
  ] as const) element(id).disabled = !enabled;
}

function updateControls() {
  element("sound-toggle").setAttribute("aria-pressed", String(state.sound));
  element("sound-label").textContent = t(state.sound ? "soundOn" : "soundOff");
  element("sound-toggle").setAttribute("aria-label", t(state.sound ? "soundOn" : "soundOff"));
  element("sound-on-icon").toggleAttribute("hidden", !state.sound);
  element("sound-off-icon").toggleAttribute("hidden", state.sound);
  element("fullscreen-toggle").setAttribute("aria-pressed", String(fullscreenActive));
  const text = t(fullscreenActive ? "exitFullscreen" : "fullscreen");
  element("fullscreen-label").textContent = text;
  element("fullscreen-toggle").setAttribute("aria-label", text);
}

function renderSyncStatus() {
  element("sync-status").dataset.status = syncing
    ? "loading"
    : syncPaused
      ? "paused"
      : initialized ? "online" : "loading";
  element("sync-label").textContent = syncing
    ? t("syncing")
    : syncPaused
      ? t("syncPaused")
      : initialized ? t("accountSynced") : t("connecting");
}

function renderGate() {
  const gate = element("access-gate");
  gate.dataset.status = gateStatus;
  app.dataset.ready = String(gateStatus === "ready");
  gate.hidden = gateStatus === "ready";
  if (gateStatus === "ready") return;
  const content: Record<Exclude<InitializeStatus, "ready"> | "loading", [string, string]> = {
    loading: [t("loading"), t("connectingHint")],
    "login-required": [t("loginRequiredTitle"), t("loginRequiredMessage")],
    "permission-required": [t("permissionTitle"), t("permissionMessage")],
    offline: [t("offlineTitle"), t("offlineMessage")],
    "cache-error": [t("cacheErrorTitle"), t("cacheErrorMessage")],
  };
  const [title, message] = content[gateStatus];
  element("gate-title").textContent = title;
  element("gate-message").textContent = message;
  element("gate-retry").hidden = gateStatus === "loading";
}

function syncFromCloud() {
  if (cloud) state = cloud.getState();
}

const themeTokens = {
  "--bg": "background",
  "--fg": "text",
  "--line": "border",
  "--accent": "accent",
} as const satisfies Record<string, keyof MiniAppTheme>;

function applyThemeColors(theme: MiniAppTheme) {
  const root = document.documentElement.style;
  for (const [property, key] of Object.entries(themeTokens)) {
    const value = theme[key];
    // Only accept valid CSS colors from the host; otherwise keep the built-in palette.
    if (typeof value === "string" && value && CSS.supports("color", value)) {
      root.setProperty(property, value);
    } else {
      root.removeProperty(property);
    }
  }
}

function applyTheme(theme: MiniAppTheme) {
  locale = theme.locale.startsWith("zh") ? "zh_CN" : "en";
  reducedMotion = theme.reducedMotion;
  app.dataset.mode = theme.mode;
  app.dataset.reducedMotion = String(reducedMotion);
  document.documentElement.dataset.mode = theme.mode;
  document.documentElement.dataset.reducedMotion = String(reducedMotion);
  document.documentElement.style.colorScheme = theme.mode;
  applyThemeColors(theme);
  localize();
  render();
  if (reducedMotion) {
    fishAnimation?.cancel();
    element("float-layer").replaceChildren();
  }
}

const host = createHost(sdk, {
  onTheme: applyTheme,
  onNotice: showNotice,
  onStorageError: () => undefined,
});
const audio = createAudio(sdk, {
  enabled: () => state.sound,
  onUnavailable: () => showNotice("audioUnavailable"),
});

function animateHit() {
  if (reducedMotion) return;
  fishAnimation?.cancel();
  fishAnimation = element("fish-visual").animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(0.94)", offset: 0.38 },
      { transform: "scale(1.015)", offset: 0.76 },
      { transform: "scale(1)" },
    ],
    { duration: 180, easing: "ease-out" },
  );
  const layer = element("float-layer");
  while (layer.childElementCount >= 10) layer.firstElementChild?.remove();
  const floating = document.createElement("span");
  floating.className = "float-text";
  floating.textContent = t("hit");
  floating.style.left = `calc(50% + ${Math.round((Math.random() - 0.5) * 110)}px)`;
  layer.append(floating);
  const animation = floating.animate(
    [
      { opacity: 0, transform: "translate(-50%, 8px) scale(0.94)" },
      { opacity: 1, transform: "translate(-50%, -6px) scale(1)", offset: 0.2 },
      { opacity: 0, transform: "translate(-50%, -68px) scale(1)" },
    ],
    { duration: 850, easing: "ease-out" },
  );
  animation.addEventListener("finish", () => floating.remove(), { once: true });
  animation.addEventListener("cancel", () => floating.remove(), { once: true });
}

function showWishCompletion(wish: Wish) {
  if (completionShown.has(wish.id)) return;
  completionShown.add(wish.id);
  const dialog = element("wish-complete-dialog");
  const sealText = element("wish-seal-text");
  const closeButton = element("wish-complete-close");
  const progressBar = element("wish-seal-progress");
  if (completionTimer !== null) clearTimeout(completionTimer);
  completionLocked = true;
  dialog.dataset.sealing = "true";
  sealText.dataset.text = "wishSealing";
  sealText.textContent = t("wishSealing");
  closeButton.disabled = true;
  element("complete-wish-text").textContent = wish.content;
  progressBar.style.animation = "none";
  void progressBar.offsetWidth;
  progressBar.style.animation = "";
  if (!dialog.open) dialog.showModal();
  dialog.focus();
  void flushCloud();
  completionTimer = setTimeout(() => {
    completionTimer = null;
    completionLocked = false;
    dialog.dataset.sealing = "false";
    sealText.dataset.text = "wishSealed";
    sealText.textContent = t("wishSealed");
    closeButton.disabled = false;
  }, 3000);
}

function hit() {
  if (
    !initialized ||
    element("wish-complete-dialog").open ||
    element("wish-dialog").open ||
    element("settings-dialog").open
  ) {
    return;
  }
  const result = cloud.recordHit();
  syncFromCloud();
  render();
  if (!result.accepted) {
    syncPaused = true;
    renderSyncStatus();
    showNotice("syncPaused");
    return;
  }
  animateHit();
  void audio.play();
  if (result.completedWish) showWishCompletion(result.completedWish);
  if (state.justReachedTarget && state.activeWish) showWishCompletion(state.activeWish);
}

function updateSound(enabled: boolean) {
  if (!initialized) return;
  cloud.setSound(enabled);
  syncFromCloud();
  render();
}

async function flushCloud() {
  if (!initialized || syncing) return false;
  syncing = true;
  renderSyncStatus();
  try {
    const recovered = syncPaused;
    const success = await cloud.flush();
    syncFromCloud();
    syncPaused = !success;
    if (success && recovered) showNotice("accountSynced");
    return success;
  } finally {
    syncing = false;
    render();
    renderSyncStatus();
  }
}

async function toggleFullscreen() {
  try {
    if (!sdk && import.meta.env.DEV) {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        fullscreenActive = false;
      } else {
        await document.documentElement.requestFullscreen();
        fullscreenActive = true;
      }
    } else if (sdk && host.can("fullscreen")) {
      const result = fullscreenActive ? await sdk.fullscreen.exit() : await sdk.fullscreen.request();
      fullscreenActive = result.active;
    } else {
      showNotice("fullscreenUnavailable");
      return;
    }
    updateControls();
  } catch (error) {
    console.warn("[muyu] Fullscreen request failed", error);
    showNotice("fullscreenUnavailable");
  }
}

let fishLoaded: Promise<void> | null = null;

function loadFish() {
  if (fishLoaded) return fishLoaded;
  const image = element("fish-image");
  const brandIcon = element("brand-icon");
  fishLoaded = (async () => {
    try {
      if (!sdk && import.meta.env.DEV) {
        image.src = "images/muyu.webp";
        brandIcon.src = "images/muyu.webp";
      } else if (sdk) {
        const bytes = await sdk.assets.readBytes("images/muyu.webp");
        fishUrl = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
        image.src = fishUrl;
        brandIcon.src = fishUrl;
      }
      await Promise.all([image.decode(), brandIcon.decode()]);
      element("fish-fallback").hidden = true;
    } catch (error) {
      console.warn("[muyu] Failed to load wooden fish image", error);
      image.hidden = true;
      brandIcon.hidden = true;
      element("fish-fallback").hidden = false;
      showNotice("imageError");
    }
  })();
  return fishLoaded;
}

async function connectCloud() {
  if (connecting) return connecting;
  connecting = (async () => {
    gateStatus = "loading";
    initialized = false;
    setControlsEnabled(false);
    element("wish-area").hidden = true;
    element("gate-retry").disabled = true;
    renderGate();
    if (cloud) await cloud.dispose();
    const adapter = import.meta.env.DEV
      ? createPreviewCloudAdapter()
      : createDiscourseCloudAdapter(sdk!);
    cloud = createCloudController(adapter);
    syncFromCloud();
    render();
    const [{ status }] = await Promise.all([
      cloud.initialize(),
      loadFish(),
      audio.warmup(),
    ]);
    syncFromCloud();
    gateStatus = status;
    initialized = status === "ready";
    syncPaused = false;
    if (initialized) {
      setControlsEnabled(true);
      element("wish-area").hidden = false;
      element("instruction").textContent = t("instruction");
    }
    render();
    renderSyncStatus();
    renderGate();
    element("gate-retry").disabled = false;
    await host.rendered();
  })().finally(() => connecting = null);
  return connecting;
}

function updateWishInput() {
  const value = element("wish-input").value;
  element("wish-count").textContent = `${Array.from(value).length} / 80`;
  const target = Number(element("wish-target").value);
  element("wish-create").disabled = wishBusy ||
    normalizeWishInput(value, target) === null;
}

function openWishDialog() {
  if (!initialized) return;
  element("wish-error").textContent = "";
  element("wish-form").hidden = state.activeWish !== null;
  element("wish-active-detail").hidden = state.activeWish === null;
  updateWishInput();
  renderWishHistory();
  if (!element("wish-dialog").open) element("wish-dialog").showModal();
}

async function createWish(event?: Event) {
  event?.preventDefault();
  if (wishBusy || !initialized) return;
  const content = element("wish-input").value;
  const target = Number(element("wish-target").value);
  if (normalizeWishInput(content, target) === null || !isWishTarget(target)) {
    element("wish-error").textContent = t("wishCreateFailed");
    return;
  }
  wishBusy = true;
  updateWishInput();
  element("wish-error").textContent = "";
  try {
    const result = await cloud.createWish(content, target as WishTarget);
    syncFromCloud();
    render();
    if (result.ok) {
      element("wish-dialog").close();
      element("wish-input").value = "";
      updateWishInput();
      showNotice("wishCreated");
    } else if (result.status === "active-wish-exists") {
      openWishDialog();
    } else {
      element("wish-error").textContent = result.status === "sync-failed"
        ? t("syncPaused")
        : t("wishCreateFailed");
    }
  } finally {
    wishBusy = false;
    updateWishInput();
  }
}

let lastPointerHitAt = 0;

element("fish").addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  lastPointerHitAt = Date.now();
  hit();
});
element("fish").addEventListener("pointerup", () => {
  audio.unlock();
});
element("fish").addEventListener("click", (event) => {
  audio.unlock();
  if (event.detail === 0 || Date.now() - lastPointerHitAt > 450) {
    hit();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat ||
    (event.target as HTMLElement | null)?.closest?.("button, input, textarea, select, dialog")) return;
  event.preventDefault();
  hit();
});
element("sound-toggle").addEventListener("click", () => updateSound(!state.sound));
element("sound-checkbox").addEventListener("change", (event) => updateSound((event.target as HTMLInputElement).checked));
element("fullscreen-toggle").addEventListener("click", () => void toggleFullscreen());
document.addEventListener("fullscreenchange", () => {
  if (import.meta.env.DEV) {
    fullscreenActive = Boolean(document.fullscreenElement);
    updateControls();
  }
});
element("settings-open").addEventListener("click", () => element("settings-dialog").showModal());
element("settings-close").addEventListener("click", () => element("settings-dialog").close());
for (const id of ["settings-dialog", "wish-dialog", "wish-complete-dialog"] as const) {
  element(id).addEventListener("click", (event) => {
    if (id === "wish-complete-dialog" && completionLocked) return;
    const dialog = element(id);
    if (event.target !== dialog || (event.clientX === 0 && event.clientY === 0)) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      dialog.close();
    }
  });
}
element("wish-complete-dialog").addEventListener("cancel", (event) => {
  if (completionLocked) event.preventDefault();
});
element("gate-retry").addEventListener("click", () => void connectCloud());
element("wish-open").addEventListener("click", openWishDialog);
element("wish-current").addEventListener("click", openWishDialog);
element("wish-close").addEventListener("click", () => element("wish-dialog").close());
element("wish-input").addEventListener("input", updateWishInput);
element("wish-target").addEventListener("change", updateWishInput);
element("wish-create").addEventListener("click", (event) => void createWish(event));
element("wish-form").addEventListener("submit", (event) => void createWish(event));
element("wish-complete-close").addEventListener("click", () => {
  if (completionLocked) return;
  element("wish-complete-dialog").close();
});

async function refreshCloud() {
  if (!initialized || syncing) return;
  const success = await cloud.refresh();
  syncFromCloud();
  syncPaused = !success;
  render();
  renderSyncStatus();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flushCloud();
  else void refreshCloud();
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    void flushCloud();
    return;
  }
  if (fishUrl) URL.revokeObjectURL(fishUrl);
  audio.dispose();
  void cloud?.dispose();
  void host.dispose();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refreshCloud();
});
setInterval(() => void flushCloud(), 5000);
localize();
render();
renderGate();
setControlsEnabled(false);
void (async () => {
  audio.warmup();
  await host.connect();
  await connectCloud();
})().catch(async (error: MiniAppError) => {
  console.error("[muyu] Initialization failed", error);
  showNotice("communityError");
  gateStatus = "offline";
  initialized = false;
  renderGate();
  await host.rendered();
});
