const installLink = document.getElementById("installLink");
const installSection = document.getElementById("installSection");

const isStandalone =
  (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;

if (installLink && isStandalone) {
  installLink.hidden = true;
}

if (installSection && isStandalone) {
  installSection.hidden = true;
}

let deferredInstallPrompt = null;

// Chrome/Edge on Android: capture the install prompt so we can trigger it from our own UI.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  if (installLink) installLink.hidden = true;
  if (installSection) installSection.hidden = true;
});

if (installLink) {
  installLink.addEventListener("click", async (event) => {
    if (!deferredInstallPrompt) return; // fallback: follow the link to /install/

    event.preventDefault();
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } finally {
      deferredInstallPrompt = null;
    }
  });
}

if (!("serviceWorker" in navigator)) {
  // No-op in browsers / webviews without Service Worker support.
} else {
  const swUrl = new URL("./sw.js", import.meta.url);
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(swUrl.href).catch(() => {
      // Ignore registration errors (e.g. non-HTTPS).
    });
  });
}
