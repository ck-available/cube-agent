/* ============ 免安装模式的浏览器桥 ============
 * Electron 下 window.cube 由 preload 注入；浏览器模式下由本文件用 fetch 补齐，
 * 接口签名与 electron/preload.js 严格一致，因此 app/js/tools.js 与 app.js
 * 不需要为两种形态写任何分支代码。
 *
 * 令牌：服务启动时以 ?t=<token> 形式打开页面，这里取走并从地址栏抹掉。
 */
(function () {
  "use strict";

  if (window.cube && window.cube.isElectron) return;   // 桌面模式：preload 已经就位

  var qs = new URLSearchParams(location.search);
  var token = qs.get("t") || "";
  if (token) {
    try { sessionStorage.setItem("cube.token", token); } catch (e) { /* ignore */ }
    qs.delete("t");
    var q = qs.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  } else {
    try { token = sessionStorage.getItem("cube.token") || ""; } catch (e) { token = ""; }
  }

  async function call(channel, args) {
    if (!token) throw { __error: "缺少访问令牌，请通过服务启动时打印的地址访问本页面" };
    var res = await fetch("/api/" + channel, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cube-Token": token },
      body: JSON.stringify(args == null ? [] : Array.prototype.slice.call(args))
    });
    if (!res.ok) {
      var t = "";
      try { t = (await res.json()).__error || ""; } catch (e) { t = res.statusText; }
      return { __error: t || ("HTTP " + res.status) };
    }
    return await res.json();
  }

  window.cube = {
    isElectron: false,
    isServer: true,
    platform: "browser",
    version: "web",

    openDirectory: (title) => call("dialog:openDirectory", [title]),
    openFile: () => call("dialog:openFile", []),
    getWorkspace: () => call("fs:getWorkspace", []),
    setWorkspace: (dir) => call("fs:setWorkspace", [dir]),

    list: (p) => call("fs:list", [p || "."]),
    read: (p, opts) => call("fs:read", [p, opts || {}]),
    write: (p, content) => call("fs:write", [p, content]),
    search: (pattern, opts) => call("fs:search", [pattern, opts || {}]),
    glob: (pattern, opts) => call("fs:glob", [pattern, opts || {}]),
    stat: (p) => call("fs:stat", [p]),

    run: (command, opts) => call("shell:run", [command, opts || {}]),
    openPath: (p) => call("shell:openPath", [p]),

    mcpConnect: (cfg) => call("mcp:connect", [cfg]),
    mcpCall: (cfg) => call("mcp:call", [cfg]),
    mcpDisconnect: (cfg) => call("mcp:disconnect", [cfg]),
    skillList: () => call("skill:list"),
    skillSave: (body) => call("skill:save", [body]),
    skillRemove: (name) => call("skill:remove", [name]),
    toolboxStore: (payload) => call("toolbox:store", [payload]),
    mcpList: () => call("mcp:list", [])
  };

  /* 启动信息（版本号 / 上次工作区），失败不阻塞界面 */
  window.cube.boot = function () {
    return call("api-boot", []).catch(function () { return null; });
  };
})();