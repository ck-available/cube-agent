/* ============ CubeAgent 预加载脚本 ============
 * 只向渲染进程暴露受控、经过安全校验的能力；渲染进程永远拿不到 Node API。
 */
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  platform: process.platform,
  version: process.env.npm_package_version || "0.2.0",
  isElectron: true,

  // 工作区
  openDirectory: (title) => ipcRenderer.invoke("dialog:openDirectory", title),
  openFile: () => ipcRenderer.invoke("dialog:openFile"),
  getWorkspace: () => ipcRenderer.invoke("fs:getWorkspace"),
  setWorkspace: (dir) => ipcRenderer.invoke("fs:setWorkspace", dir),

  // 文件工具
  list: (p) => ipcRenderer.invoke("fs:list", p || "."),
  read: (p, opts) => ipcRenderer.invoke("fs:read", p, opts || {}),
  write: (p, content) => ipcRenderer.invoke("fs:write", p, content),
  search: (pattern, opts) => ipcRenderer.invoke("fs:search", pattern, opts || {}),
  glob: (pattern, opts) => ipcRenderer.invoke("fs:glob", pattern, opts || {}),
  stat: (p) => ipcRenderer.invoke("fs:stat", p),

  // 命令执行
  run: (command, opts) => ipcRenderer.invoke("shell:run", command, opts || {}),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),

  // MCP
  mcpConnect: (cfg) => ipcRenderer.invoke("mcp:connect", cfg),
  mcpCall: (cfg) => ipcRenderer.invoke("mcp:call", cfg),
  mcpDisconnect: (cfg) => ipcRenderer.invoke("mcp:disconnect", cfg),
  skillList: () => ipcRenderer.invoke("skill:list"),
  skillSave: (body) => ipcRenderer.invoke("skill:save", body),
  skillRemove: (name) => ipcRenderer.invoke("skill:remove", name),
  toolboxStore: (payload) => ipcRenderer.invoke("toolbox:store", payload),
  mcpList: () => ipcRenderer.invoke("mcp:list")
};

contextBridge.exposeInMainWorld("cube", api);
