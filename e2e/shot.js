/* UI 截图工具：node e2e/shot.js [输出文件名] [--theme=dark|light] [--view=chat|welcome]
 * 用真实 Electron 窗口加载界面，注入演示数据后截图，便于检查视觉效果。
 * 产物输出到 e2e/_artifacts/。
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const out = { file: "ui.png", theme: "dark", view: "chat", scroll: "top" };
  process.argv.slice(2).forEach((a) => {
    if (a.startsWith("--theme=")) out.theme = a.split("=")[1];
    else if (a.startsWith("--view=")) out.view = a.split("=")[1];
    else if (a.startsWith("--scroll=")) out.scroll = a.split("=")[1];
    else if (a.startsWith("--w=")) out.w = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("--h=")) out.h = parseInt(a.split("=")[1], 10);
    else if (a && !a.startsWith("--")) out.file = a;
  });
  return out;
}

if (process.versions && process.versions.electron) {
  /* ---------------- Electron 主进程 ---------------- */
  const { app, BrowserWindow } = require("electron");
  const args = parseArgs();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const artifactDir = path.join(__dirname, "_artifacts");
    fs.mkdirSync(artifactDir, { recursive: true });
    const outFile = path.join(artifactDir, args.file);

    try {
      require(path.join(ROOT, "electron", "main.js"));
      await sleep(1000);

      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("未找到应用窗口");
      if (args.w && args.h) {
        win.setSize(args.w, args.h);
        // 窗口处于隐藏状态时渲染进程收不到原生 resize 事件（Chromium 会节流），
        // 手动派发一次，让响应式逻辑（如窄屏自动收起右栏）生效
        await win.webContents.executeJavaScript("window.dispatchEvent(new Event('resize')); true;", true).catch(() => {});
      }

      win.webContents.on("console-message", (_e, _level, message) => {
        console.log("[renderer] " + message);
      });
      win.webContents.on("render-process-gone", (_e, details) => {
        console.log("[renderer] 崩溃: " + JSON.stringify(details));
      });

      if (args.view === "welcome") {
        await win.webContents.executeJavaScript("try{localStorage.clear()}catch(e){}; true;", true);
        await new Promise((resolve) => {
          win.webContents.once("did-finish-load", resolve);
          win.webContents.reload();
        });
        await sleep(900);
        // 主题必须在 reload 之后再设：应用启动时 applyTheme() 会用 localStorage 里的
        // 默认值（light）覆盖 data-theme，先前设置会被冲掉
      }

      // 统一在 reload 之后应用主题
      await win.webContents.executeJavaScript(
        'document.documentElement.setAttribute("data-theme","' + args.theme + '"); true;',
        true
      );

      const probe = await win.webContents.executeJavaScript(
        "(function(){ try { var S=window.CubeApp && CubeApp.state(); var m=document.getElementById('main'); var c=document.getElementById('ctx-bar'); return 'CubeApp='+(!!window.CubeApp)+' CubeContext='+(!!window.CubeContext)+' Store='+(!!window.Store)+' state='+(!!S)+' sessions='+(S?S.sessions.length:'-')+' active='+(S?String(S.activeSessionId):'-')+' innerW='+window.innerWidth+' panelHidden='+(m?m.classList.contains('panel-hidden'):'-')+' ctxBar='+(c?(c.style.width||'0%'):'MISSING')+' bootErr='+(window.__cubeBootError||'none'); } catch(e){ return 'ERR: '+(e&&e.message)+' @ '+(e&&e.stack||'').split('\\n').slice(0,3).join(' | ') } })()",
        true
      );
      console.log("[shot] probe: " + probe);

      if (args.view === "chat") {
        const demo = fs.readFileSync(path.join(__dirname, "demo.js"), "utf8");
        const r = await win.webContents.executeJavaScript(
          "(function(){ try { return String(" + demo + ") } catch(e){ return 'ERR: '+String((e && e.stack)||e) } })()",
          true
        );
        console.log("[shot] demo 返回: " + r);
      } else if (args.view === "settings") {
        const demo = fs.readFileSync(path.join(__dirname, "demo.js"), "utf8");
        await win.webContents.executeJavaScript("(function(){ try { " + demo + " } catch(e){} return true })()", true);
        await win.webContents.executeJavaScript("CubeApp.openSettings(); true;", true);
      } else if (args.view === "masks") {
        await win.webContents.executeJavaScript(
          'document.getElementById("btn-masks").click(); true;',
          true
        );
      }

      await win.webContents.executeJavaScript(
        '(function(){ var m=document.getElementById("messages"); if(m) m.scrollTop = ' +
          (args.scroll === "bottom" ? "m.scrollHeight" : "0") +
          '; return true; })()',
        true
      );

      await sleep(1400);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(outFile, img.toPNG());
      console.log("[shot] 已保存 " + outFile);
    } catch (e) {
      console.error("[shot] 失败: " + ((e && e.stack) || e));
    }
    app.quit();
  });
} else {
  /* ---------------- Node 启动器 ---------------- */
  const { spawnSync } = require("child_process");
  delete process.env.ELECTRON_RUN_AS_NODE;
  const electronPath = require("electron");
  const r = spawnSync(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  process.exit(r.status == null ? 1 : r.status);
}
