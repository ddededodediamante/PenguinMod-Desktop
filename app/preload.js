const { contextBridge, ipcRenderer, webFrame } = require("electron");

function sendSync(channel, payload) {
  try {
    return ipcRenderer.sendSync(channel, payload);
  } catch (err) {
    console.error("[preload] sync ipc failed", channel, err);
    return null;
  }
}

contextBridge.exposeInMainWorld("__electronInternalBridge", {
  alert: msg => sendSync("electron-alert", String(msg ?? "")),
  confirm: msg => !!sendSync("electron-confirm", String(msg ?? "")),
  prompt: (msg, def) => sendSync("electron-prompt-sync", { message: msg, defaultValue: def }),
  notifyThemeChanged: () => { } // dummy stub to prevent page exceptions
});

contextBridge.exposeInMainWorld("__electronUpdaterBridge", {
  checkForUpdate: () => ipcRenderer.invoke("manual-check-update"),
});

window.addEventListener("DOMContentLoaded", async () => {
  webFrame.executeJavaScript(`
  (() => {
    window.alert = (msg) => window.__electronInternalBridge.alert(msg);
    window.confirm = (msg) => window.__electronInternalBridge.confirm(msg);
    window.prompt = (msg, def) => window.__electronInternalBridge.prompt(msg, def);
  })();
  `);

  // bypass target blank redirect to open in standard tab
  const enforceSelfTarget = () => {
    document.querySelectorAll("a[href]").forEach(a => {
      try {
        const url = new URL(a.href, window.location.href);
        const isPenguin = url.host === "penguinmod.com" || url.protocol === "home:";
        const isEditor = url.host === "studio.penguinmod.com" || url.protocol === "editor:";
        if ((isPenguin || isEditor) && a.getAttribute("target") !== "_self") {
          a.setAttribute("target", "_self");
        }
      } catch { }
    });
  };

  enforceSelfTarget();
  new MutationObserver(enforceSelfTarget).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  const overlay = document.createElement("div");
  overlay.id = "electron-update-overlay";
  overlay.style.cssText = `display:none; position:fixed; inset:0; z-index:9999999; background:rgba(0,0,0,0.65); backdrop-filter:blur(4px); align-items:center; justify-content:center; font-family:system-ui;`;
  overlay.innerHTML = `
  <div style="background:#1c1c1e; color:#f0f0f0; border-radius:16px; padding:28px 32px; width:420px; box-sizing:border-box; display:flex; flex-direction:column; gap:14px;">
    <div style="font-size:16px; font-weight:600;" id="update-phase-label">Preparing update...</div>
    <div style="background:#3a3a3c; border-radius:999px; height:8px; overflow:hidden;"><div id="update-bar" style="height:100%; width:0%; background:#007aff; transition:width 0.15s ease;"></div></div>
    <div id="update-status" style="font-size:11px; color:#8e8e93;">Starting...</div>
  </div>`;
  document.body.appendChild(overlay);

  ipcRenderer.on("update-progress", (_event, { phase, percent, status }) => {
    overlay.style.display = "flex";
    document.getElementById("update-phase-label").textContent = phase === "download" ? "Downloading..." : "Extracting...";
    const bar = document.getElementById("update-bar");
    if (percent >= 0) bar.style.width = `${percent}%`;
    document.getElementById("update-status").textContent = status;
  });
});
