const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    session,
    protocol,
    net,
    Menu,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createWriteStream } = require("fs");
const unzipper = require("unzipper");

let mainWindow = null;
let isQuitting = false;

const PRELOAD_PATH = path.join(__dirname, "preload.js");
const SETTINGS_FILE = path.join(app.getPath("userData"), "app-settings.json");

const folders = {
    home: path.join(__dirname, "public"),
    editor: path.join(__dirname, "build"),
    turbowarp: path.join(__dirname, "TurboWarp-ExtensionsGallery"),
    penguinmod: path.join(__dirname, "PenguinMod-ExtensionsGallery"),
    sharkpools: path.join(__dirname, "SharkPools-Extensions"),
};

function getInstallDir() {
    const platformFolder = os.platform() === "win32" ? "win-unpacked" : "linux-unpacked";
    let dir = __dirname;
    while (true) {
        if (path.basename(dir) === platformFolder) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return __dirname;
        dir = parent;
    }
}

function getStartupSetting() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
            return data.startupPage || "home";
        }
    } catch (err) {
        console.error("[Settings] Load error:", err);
    }
    return "home";
}

function setStartupSetting(value) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ startupPage: value }, null, 2), "utf8");
    } catch (err) {
        console.error("[Settings] Save error:", err);
    }
}

function getLocalFile(url) {
    const parsed = new URL(url);
    const pathClean = parsed.pathname.replace(/^\/+/, "");

    if (/^https:\/\/extensions\.turbowarp\.org\//.test(url)) {
        return path.join(folders.turbowarp, pathClean);
    }
    if (/^https:\/\/extensions\.penguinmod\.com\//.test(url)) {
        return path.join(folders.penguinmod, pathClean);
    }
    if (/^https:\/\/sharkpool-sp\.github\.io\/SharkPools-Extensions/.test(url)) {
        const localPath = parsed.pathname.replace(/^\/SharkPools-Extensions\/?/, "");
        return path.join(folders.sharkpools, localPath);
    }
    if (/^https:\/\/sharkpools-extensions\.vercel\.app\//.test(url)) {
        return path.join(folders.sharkpools, pathClean);
    }
    if (/^https:\/\/raw\.githubusercontent\.com\/SharkPool-SP\/SharkPools-Extensions\/refs\/heads\/main\//.test(url)) {
        const localPath = parsed.pathname.replace(/^\/SharkPools-Extensions\/refs\/heads\/main\/?/, "");
        return path.join(folders.sharkpools, localPath);
    }
    return null;
}

function setupAppMenu(win) {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ label: app.name, submenu: [{ role: 'quit' }] }] : []),
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Startup: Home Page',
                    type: 'radio',
                    checked: getStartupSetting() === 'home',
                    click: () => setStartupSetting('home')
                },
                {
                    label: 'Startup: Editor',
                    type: 'radio',
                    checked: getStartupSetting() === 'editor',
                    click: () => setStartupSetting('editor')
                }
            ]
        },
        {
            label: 'System',
            submenu: [
                { label: 'Check for Updates', click: () => runUpdateCheck(win) },
                { label: 'Reload', click: () => win.webContents.reloadIgnoringCache() }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// download logic with updates
async function downloadFile(url, destPath) {
    const res = await net.fetch(url, { headers: { Accept: "application/octet-stream" } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    const total = parseInt(res.headers.get("content-length") || "0", 10);
    let received = 0;

    const reader = res.body.getReader();
    const fileStream = createWriteStream(destPath);

    await new Promise((resolve, reject) => {
        fileStream.on("error", reject);
        function pump() {
            reader.read().then(({ done, value }) => {
                if (done) {
                    fileStream.end(resolve);
                    return;
                }
                received += value.length;
                const mb = (received / 1024 / 1024).toFixed(1);
                if (total > 0) {
                    const totalMb = (total / 1024 / 1024).toFixed(1);
                    const pct = Math.round((received / total) * 100);
                    sendUpdateProgress("download", pct, `Downloading… ${mb} / ${totalMb} MB`);
                } else {
                    sendUpdateProgress("download", -1, `Downloading… ${mb} MB`);
                }
                fileStream.write(Buffer.from(value), (err) => {
                    if (err) return reject(err);
                    pump();
                });
            }).catch(reject);
        }
        pump();
    });
}

// bypass windows locking issues by renaming first
function safeWriteFile(targetPath, data) {
    if (os.platform() === "win32") {
        if (fs.existsSync(targetPath)) {
            const tomb = targetPath + ".old";
            try {
                if (fs.existsSync(tomb)) fs.unlinkSync(tomb);
                fs.renameSync(targetPath, tomb);
            } catch (err) {
                console.warn("[update] rename failed, fallback write:", path.basename(targetPath), err.code);
            }
        }
        fs.writeFileSync(targetPath, data);
        const tomb = targetPath + ".old";
        try {
            if (fs.existsSync(tomb)) fs.unlinkSync(tomb);
        } catch { }
    } else {
        try {
            if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        } catch { }
        fs.writeFileSync(targetPath, data);
    }
}

async function extractChangedFiles(zipPath, targetDir) {
    const directory = await unzipper.Open.file(zipPath);
    const platformFolder = os.platform() === "win32" ? "win-unpacked" : "linux-unpacked";
    const stripPrefix = `builds/${platformFolder}/`;

    const eligible = directory.files.filter(
        (entry) => entry.type === "File" && entry.path.startsWith(stripPrefix)
    );
    const total = eligible.length;
    let i = 0;

    for (const entry of eligible) {
        i++;
        const relativePath = entry.path.slice(stripPrefix.length);
        if (!relativePath) continue;

        const pct = Math.round((i / total) * 100);
        sendUpdateProgress("extract", pct, relativePath);

        const targetPath = path.join(targetDir, relativePath);
        const rel = path.relative(targetDir, targetPath);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;

        const remoteData = await entry.buffer();
        if (fs.existsSync(targetPath)) {
            const localData = fs.readFileSync(targetPath);
            if (Buffer.compare(localData, remoteData) === 0) continue;
        } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        }

        safeWriteFile(targetPath, remoteData);

        if (os.platform() !== "win32") {
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            if (unixMode !== 0) {
                try {
                    fs.chmodSync(targetPath, unixMode);
                } catch (err) {
                    console.warn("[update] chmod failed:", relativePath, err.code);
                }
            }
        }
    }
}

function sendUpdateProgress(phase, percent, status) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-progress", { phase, percent, status });
    }
}

async function runUpdateCheck(win) {
    const GITHUB_REPO = "PenguinMod/PenguinMod-Desktop";
    try {
        const res = await net.fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
            headers: { Accept: "application/vnd.github+json" },
        });

        if (!res.ok) return { success: false, message: `GitHub API error: HTTP ${res.status}` };

        const releases = await res.json();
        const release = releases[0];
        if (!release || !release.assets?.length) {
            return { success: false, message: "No release assets found." };
        }

        const assetName = os.platform() === "win32" ? "win-unpacked.zip" : "linux-unpacked.zip";
        const asset = release.assets.find((a) => a.name === assetName);
        if (!asset) {
            return { success: false, message: `No matching asset (${assetName}) found in latest release.` };
        }

        const choice = dialog.showMessageBoxSync(win, {
            type: "question",
            buttons: ["Install Update", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            title: "Update Available",
            message: `Update available: ${release.name || release.tag_name}`,
            detail: [
                `Release: ${release.name || release.tag_name}`,
                `Published: ${new Date(release.published_at).toLocaleString()}`,
                `Asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`,
                release.body ? `\nNotes:\n${release.body.slice(0, 300)}${release.body.length > 300 ? "…" : ""}` : "",
            ].join("\n"),
            noLink: true,
        });

        if (choice !== 0) return { success: false, message: "Update cancelled." };

        const tmpZip = path.join(os.tmpdir(), `penguinmod-update-${Date.now()}.zip`);
        await downloadFile(asset.browser_download_url, tmpZip);
        await extractChangedFiles(tmpZip, getInstallDir());

        try { fs.unlinkSync(tmpZip); } catch { }

        app.relaunch();
        app.exit(0);
        return { success: true, message: "Update installed. Restarting…" };
    } catch (err) {
        console.error("[update-checker]", err);
        return { success: false, message: `Update failed: ${err.message}` };
    }
}

function setupProtocol() {
    protocol.handle("https", (request) => {
        try {
            const url = new URL(request.url);
            const hostMap = {
                "studio.penguinmod.com": { dir: folders.editor, def: "editor.html" },
                "penguinmod.com": { dir: folders.home, def: "index.html" },
                "extensions.penguinmod.com": { dir: folders.penguinmod, def: "index.html" },
                "extensions.turbowarp.org": { dir: folders.turbowarp, def: "index.html" }
            };

            if (hostMap[url.host]) {
                const cfg = hostMap[url.host];
                let filename = url.pathname.replace(/^\/+/, "");
                if (!filename || filename === cfg.def) filename = cfg.def;

                const filePath = path.join(cfg.dir, filename);
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    return net.fetch("file://" + filePath);
                }
            }

            if (["sharkpools-extensions.vercel.app", "sharkpool-sp.github.io"].includes(url.host)) {
                let filename = url.pathname.replace(/^\/+/, "");
                if (filename.startsWith("SharkPools-Extensions")) {
                    filename = filename.replace("SharkPools-Extensions", "");
                }
                filename = filename.replace(/^\/+/, "");
                if (!filename) filename = "index.html";

                const filePath = path.join(folders.sharkpools, filename);
                const decoded = decodeURIComponent(filePath);
                if (fs.existsSync(decoded) && fs.statSync(decoded).isFile()) {
                    return net.fetch("file://" + filePath);
                }
            }

            const filePath = getLocalFile(request.url);
            if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return net.fetch("file://" + filePath);
            }
        } catch (err) {
            console.error(`[HTTPS Interceptor] Error parsing ${request.url}:`, err);
        }
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
    });
}

function setupHeaderSpoofing() {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders;
        delete headers["x-frame-options"];
        delete headers["X-Frame-Options"];
        callback({ responseHeaders: headers });
    });

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const { requestHeaders, url } = details;
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.host === "www.youtube.com" || parsedUrl.host === "www.youtube-nocookie.com") {
                requestHeaders["Origin"] = "https://penguinmod.com";
                requestHeaders["Referer"] = "https://penguinmod.com/";
            }
        } catch (_) { }
        callback({ requestHeaders });
    });
}

if (process.env.NOPROXY === "true") {
    app.commandLine.appendSwitch('no-proxy-server');
}

app.whenReady().then(() => {
    ipcMain.handle("get-startup-setting", () => getStartupSetting());
    ipcMain.on("set-startup-setting", (event, value) => setStartupSetting(value));

    ipcMain.handle("manual-check-update", async (event) => {
        const senderFrame = event.senderFrame;
        if (!senderFrame || senderFrame.parent !== null) {
            throw new Error("Security Violation: Update requests must originate from main frame context.");
        }

        const originUrl = senderFrame.url;
        if (!originUrl.startsWith("https://penguinmod.com") && !originUrl.startsWith("https://studio.penguinmod.com")) {
            throw new Error("Security Violation: Unauthorized origin.");
        }
        return await runUpdateCheck(mainWindow);
    });

    setupProtocol();
    setupHeaderSpoofing();
    createWindow();
});

function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.destroy(); } catch { }
        mainWindow = null;
    }

    mainWindow = new BrowserWindow({
        width: 1100,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            nativeWindowOpen: true,
            preload: PRELOAD_PATH,
            webSecurity: true,
        },
    });

    const startupTarget = getStartupSetting();
    mainWindow.loadURL(startupTarget === "editor" ? "https://studio.penguinmod.com/editor.html" : "https://penguinmod.com/index.html");

    mainWindow.webContents.on("console-message", ({ level, message, lineNumber, sourceId, frame }) => {
        const prefix = `[renderer:${sourceId}:${lineNumber}]`;
        if (level >= 2) console.error(prefix, message);
        else console.log(prefix, message);
    });

    mainWindow.webContents.setWindowOpenHandler(() => {
        return {
            action: "allow",
            overrideBrowserWindowOptions: {
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: false,
                    preload: PRELOAD_PATH,
                    webSecurity: true
                }
            }
        };
    });

    setupDialogs();
    setupAppMenu(mainWindow);

    mainWindow.on("closed", () => (mainWindow = null));

    let isUnloadDialogOpen = false;
    mainWindow.webContents.on("will-prevent-unload", (event) => {
        if (isUnloadDialogOpen) return;
        isUnloadDialogOpen = true;

        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: "warning",
            buttons: ["Leave", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: "The page is trying to prevent unload. Do you want to leave?",
            detail: "Any unsaved changes may be lost.",
        });

        isUnloadDialogOpen = false;
        if (choice === 0) event.preventDefault();
    });

    mainWindow.webContents.on("render-process-gone", () => createWindow());
    mainWindow.webContents.on("crashed", () => createWindow());

    // reload on window unresponsiveness
    mainWindow.on("unresponsive", () => {
        try { mainWindow.webContents.reloadIgnoringCache(); } catch { }
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                try { mainWindow.destroy(); } catch { }
                createWindow();
            }
        }, 1500);
    });
}

app.on("before-quit", () => {
    isQuitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
});

app.on("activate", () => {
    if (mainWindow) {
        mainWindow.show();
    } else {
        createWindow();
    }
});

app.on("window-all-closed", () => {
    app.quit();
});

process.on("uncaughtException", (err) => console.error("[main] uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("[main] unhandledRejection:", reason));

function setupDialogs() {
    ipcMain.on("electron-alert", (event, message, opts = {}) => {
        try {
            dialog.showMessageBoxSync(BrowserWindow.fromWebContents(event.sender), {
                type: opts.type || "info",
                buttons: ["OK"],
                defaultId: 0,
                message: String(message ?? ""),
                detail: opts.detail || undefined,
                noLink: true,
            });
        } catch (e) {
            console.error("[main] alert dialog fail", e);
        }
        event.returnValue = null;
    });

    ipcMain.on("electron-confirm", (event, message, opts = {}) => {
        try {
            const choice = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(event.sender), {
                type: opts.type || "question",
                buttons: opts.buttons || ["OK", "Cancel"],
                defaultId: opts.defaultId === 1 ? 1 : 0,
                cancelId: opts.cancelId === 1 ? 1 : 1,
                message: String(message ?? ""),
                detail: opts.detail || undefined,
                noLink: true,
            });
            event.returnValue = choice === 0;
        } catch (e) {
            console.error("[main] confirm dialog fail", e);
            event.returnValue = false;
        }
    });

    ipcMain.on("electron-prompt-sync", (event, { message, defaultValue }) => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        let result = null;

        const promptWindow = new BrowserWindow({
            width: 400,
            height: 150,
            parent,
            modal: true,
            show: false,
            frame: false,
            transparent: false,
            backgroundColor: "#ffffff",
            resizable: false,
            alwaysOnTop: true,
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });

        const escapeHtml = (s) => String(s ?? "").replace(/[&<>"'`]/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;"
        })[c]);

        // basic custom prompts template
        const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><style>
    html, body { margin:0; height:100%; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: transparent; }
    .wrapper { height:100%; display:flex; align-items:center; justify-content:center; padding:14px; box-sizing:border-box; }
    .dialog { width:100%; background:white; border-radius:12px; padding:18px; box-sizing:border-box; }
    .message { font-size:14px; margin-bottom:14px; line-height:1.45; max-height:90px; overflow:auto; }
    input { width:100%; padding:8px 10px; font-size:14px; border-radius:6px; border:1px solid #ccc; margin-bottom:18px; box-sizing:border-box; }
    input:focus { outline:none; border-color:#007aff; box-shadow:0 0 0 2px rgba(0,122,255,0.25); }
    .buttons { display:flex; justify-content:flex-end; gap:10px; }
    button { font-size:13px; padding:6px 14px; border-radius:6px; border:none; cursor:pointer; }
    #cancel { background:#f1f1f1; } #cancel:hover { background:#e4e4e4; }
    #ok { background:#007aff; color:white; } #ok:hover { background:#0062cc; }
    </style></head>
    <body>
    <div class="wrapper"><div class="dialog">
    <div class="message">${escapeHtml(message)}</div>
    <input id="input" value="${escapeHtml(defaultValue)}">
    <div class="buttons">
    <button id="cancel">Cancel</button>
    <button id="ok">OK</button>
    </div>
    </div></div>
    <script>
    const { ipcRenderer } = require('electron');
    const input = document.getElementById('input');
    const ok = document.getElementById('ok');
    const cancel = document.getElementById('cancel');
    ok.onclick = () => ipcRenderer.send('electron-prompt-done-sync', input.value);
    cancel.onclick = () => ipcRenderer.send('electron-prompt-done-sync', null);
    input.addEventListener('keydown', e => { if(e.key==='Enter') ok.click(); if(e.key==='Escape') cancel.click(); });
    input.focus(); input.select();
    </script>
    </body></html>`;

        ipcMain.once("electron-prompt-done-sync", (ev, val) => {
            result = val;
            try { promptWindow.destroy(); } catch { }
            event.returnValue = result;
        });

        promptWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        promptWindow.once("ready-to-show", () => promptWindow.show());
    });
}
