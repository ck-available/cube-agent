/* ============ CubeAgent Electron 主进程 ============
 * 1) 便携模式：数据目录跟随 exe，不写注册表、不需要管理员权限
 * 2) 文件 / 命令 / MCP 全部委托给 electron/runtime.js —— 与免安装 HTTP 服务
 *    引用同一份实现，因此桌面模式与浏览器模式能力完全一致
 * 3) IPC 通道名与 electron/preload.js、app/js/bridge.js 的契约严格一致
 */
const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createRuntime } = require("./runtime");

/* ---------- 便携模式：数据目录跟随 exe ---------- */
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    const dataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, "CubeAgent-data");
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath("userData", dataDir);
  } catch (e) {
    console.error("便携数据目录不可用，回退到默认用户目录", e);
  }
}

let mainWindow = null;
let runtime = null;

app.whenReady().then(() => {
  // 对话框参数必须是字符串：Electron 收到非字符串 title 会抛
  // "Title must be a string"，表现为点击后毫无反应。
  const safeTitle = (t, fallback) =>
    typeof t === "string" && t.trim() ? t
      : (t && typeof t === "object" && typeof t.title === "string" && t.title.trim() ? t.title : fallback);

  runtime = createRuntime({
    version: app.getVersion(),
    dataDir: app.getPath("userData"),
    pickDirectory: async (title) => {
      const cap = safeTitle(title, "选择目录");
      // 端到端测试里弹模态框会永久阻塞，直接返回测试工作区
      if (process.env.CUBEAGENT_E2E && process.env.CUBEAGENT_TEST_WS) {
        return process.env.CUBEAGENT_TEST_WS;
      }
      const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], title: cap });
      return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
    },
    pickFile: async () => {
      if (process.env.CUBEAGENT_E2E && process.env.CUBEAGENT_TEST_WS) {
        return require("path").join(process.env.CUBEAGENT_TEST_WS, "e2e-ws.txt");
      }
      const res = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], title: "选择文件" });
      return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
    },
    openPathExternally: (abs) => { shell.openPath(abs); }
  });

  Object.keys(runtime.handlers).forEach((channel) => {
    ipcMain.handle(channel, (_, ...args) => runtime.handlers[channel](...args));
  });
  ipcMain.handle("app:info", () => ({
    home: os.homedir(),
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    admin: false
  }));

  createWindow();
  if (process.env.CUBEAGENT_LIVE) {
    // 实况测试：窗口可见，逐步截图，用户能亲眼看到测试过程
    try { require("../e2e/live-driver")(mainWindow, app); } catch (e) {
      console.error("实况驱动加载失败", e);
      app.quit(1);
    }
  } else if (process.env.CUBEAGENT_E2E) {
    // 无头端到端测试：由 e2e/driver.js 驱动真实界面与真实模型
    try { require("../e2e/driver")(mainWindow, app); } catch (e) {
      console.error("E2E 驱动加载失败", e);
      app.quit(1);
    }
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#0a0c10",
    title: "CubeAgent",
    // E2E 与截图模式下不显示窗口（离屏渲染，仍可 capturePage）
    // 实况模式要显示出来 —— 用户要求亲眼看到测试过程
    show: (!!process.env.CUBEAGENT_LIVE)
      || (!process.env.CUBEAGENT_E2E && !process.env.CUBEAGENT_SHOT),
    icon: path.join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../app/index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.setTitle("CubeAgent");
  });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("before-quit", () => { if (runtime) runtime.dispose(); });