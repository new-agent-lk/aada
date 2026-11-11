# AYA 无缝剪贴板与文件传输 — 实施规格

> 状态：已锁定（wayfinder 地图「AYA 无缝剪贴板与文件传输（含 scrcpy 升级 + 更新器）」的终点产物）
> 仓库：`/media/kang/myworkspace/aada`（AYA 1.14.2，Electron 30.5.1 + `@devicefarmer/adbkit` + `@yume-chan/scrcpy`）
> 生成日期：2026-11-11
> 来源决策：研究 R1/R2、设计 #4（剪贴板）、#5（文件）、#6（更新器），详见 `docs/research/` 与各 issue 的 Resolution 评论。

---

## 0. 范围

本文档是**规划交付物**，锁定四个模块的决策与文件级改动，供后续独立实施 effort 直接照做。不含代码实现。

四个模块：

| 代号 | 模块 | 来源决策 | 一句话 |
|---|---|---|---|
| **S1** | scrcpy 升级到 v5.0.1 | R2 | server v5.0.1 + `@yume-chan/scrcpy 3.0.0-beta.5` + `ScrcpyOptions5_0_1` |
| **S2** | 剪贴板文本双向自动同步 | #4（D1） | 主进程 500ms 轮询 + 单一 `lastSynced` 去重 + 递增 sequence/ack |
| **S3** | 文件「粘贴导入」+ 设备内移动/复制 | #5（D2） | 右键/快捷键粘贴宿主文件 + 设备内 cp/mv + 路径校验 |
| **S4** | scrcpy-server 更新器 | #6（D3） | 设置里检查/更新 + 启动自动检查 + 三层版本耦合防护 |

**不在范围**（见地图 Out of scope）：应用级 `electron-updater` 升级 AYA 本体；rustdesk 式多格式/文件剪贴板与 FUSE；本规划不做实际代码改动。

---

## 1. 背景与目标

AYA 目前：

- 剪贴板只在 screencast 窗口**获得焦点**时把宿主文本推给设备（`src/renderer/screencast/store.ts:113-116`），设备→宿主靠 `navigator.clipboard.writeText`（`src/renderer/screencast/lib/ScrcpyClient.ts:507-511`）；失焦即断，且无回环抑制。
- 文件只在本地选/拖拽上传（`src/renderer/main/components/file/File.tsx` `uploadFiles`），没有「复制文件→在设备目录粘贴」，且**静默覆盖**同名文件；设备内只能改名（`moveFile` = `mv`），无「复制到/移动到」。
- scrcpy-server 固定在 v4.0（`script/scrcpy.mjs:4`），客户端选项类固定 `ScrcpyOptions4_0`，没有任何升级入口。

目标（可交接的验收面）：复制粘贴在 AYA 里像本地一样无缝；文件可「复制后在设备当前目录粘贴」并可设备内移动/复制；scrcpy 升到最新且带一键更新器。形态参考 rustdesk（机制映射见 `docs/research/rustdesk-clipboard-file-mechanics.md`），但受 scrcpy/adb 能力边界约束——**剪贴板只有纯文本通道**。

---

## 2. 总体架构与改动地图

```
主进程 (Electron main)
├─ S4 src/main/lib/scrcpy-updater.ts       ← 检查/下载/校验/原子安装 jar
├─ S4 src/main/lib/scrcpy-version.json     ← bundled / maxSupported 清单
├─ S2 src/main/lib/clipboard-sync.ts       ← 500ms 轮询 readText + lastSynced + 平台文件剪贴板解析
├─ src/main/lib/adb/scrcpy.ts              ← 选 jar + server version 来自实际 jar
└─ src/main/lib/adb/file.ts                ← push/pull/mv/rm + 路径校验

IPC (src/share/main/lib/ipc.ts + src/share/preload/main.ts + src/share/common/types.ts)

渲染进程 screencast (ScrcpyClient.ts / store.ts / SettingsModal.tsx)
└─ S2 只桥 scrcpy 控制通道 + IPC 转发；不直接读写系统剪贴板

渲染进程 main (File.tsx / store/file.ts)
└─ S3 粘贴/复制到/移动到 UI + 冲突改名
```

关键原则：**系统剪贴板的读写都在主进程**（Electron `clipboard`），因为失焦时渲染进程 `navigator.clipboard` 可能被拒。`lastSynced` 指纹单一存在主进程。

---

## 3. S1 — scrcpy 升级到 v5.0.1（R2）

### 决策

- server **v5.0.1**；客户端 `@yume-chan/scrcpy` **3.0.0-beta.5**（或保留已装 3.0.0-beta.4，两者都内置 `ScrcpyOptions5_0_1`）；选项类换 `ScrcpyOptions5_0_1`（它是 `4_1` 实现的别名，协议 4.1→5.0.1 不变）。
- 唯一编译改动：加 `videoCodec: undefined`（`4_1/5_0_1` 把该字段改必填，传 undefined 仍回落 h264，序列化逐字节一致）。
- 陷阱：npm `latest`=2.3.0 只支持到 server 3.3.3，**勿升**。

### 文件级改动

| 文件:行 | 改动 |
|---|---|
| `script/scrcpy.mjs:4` | `const version = '4.0'` → `'5.0.1'` |
| `src/main/lib/adb/scrcpy.ts:23` | `com.genymobile.scrcpy.Server 4.0` 的版本号 → 取自**实际选中 jar** 的 version（S4 提供；默认 5.0.1）。必须与 jar 一致，否则 server abort（`The server version (x) does not match the client`） |
| `src/renderer/screencast/store.ts:5` | `import { ScrcpyOptions4_0 }` → `ScrcpyOptions5_0_1` |
| `src/renderer/screencast/store.ts:70` | `new ScrcpyOptions4_0<...>({` → `new ScrcpyOptions5_0_1<...>({`，并在 init 对象内加 `videoCodec: undefined,` |
| `src/renderer/screencast/lib/ScrcpyClient.ts:6` | import `ScrcpyOptions4_0` → `ScrcpyOptions5_0_1` |
| `src/renderer/screencast/lib/ScrcpyClient.ts:53` | 字段类型 `ScrcpyOptions4_0<...Init>` → `ScrcpyOptions5_0_1<...Init>` |
| `src/renderer/screencast/lib/ScrcpyClient.ts:63` | 构造参数类型同上 |
| `package.json:48-53` | （可选，推荐）六个 `@yume-chan/*` `3.0.0-beta.4` → `3.0.0-beta.5`，`npm install` |
| `resources/scrcpy.jar` | `npm run scrcpy` 重取 → v5.0.1（733,930 B；现 v4.0 = 732,226 B）。`resources/` 已 gitignore，untracked |

### 验证

`npm run build`（或 `tsc --noEmit`）确认 `videoCodec` 类型满足；实机验证投屏/音频/输入/剪贴板/录制。失败看 `src/main/lib/adb/scrcpy.ts:27-32` 的 server stderr。

---

## 4. S2 — 剪贴板文本双向自动同步（#4 / D1）

### 决策

- **读写都在主进程**：主进程 `clipboard.readText()` **500ms 轮询**，文本变化才推；`clipboard.writeText()` 处理设备→宿主写回。
- **回环抑制**：主进程持单一 `lastSynced: string` 指纹，双向比较去重。
- **仅纯文本**，上限 **1 MiB**；超限/空串/失败静默跳过 + `logger.warn`。
- **setClipboard 用递增 `sequence` 并 await ack** 串行化（`sequence===0n` 不发 ack；非 0 才 await `AckClipboard`）。
- **per-device「剪贴板同步」开关**，默认开，放 screencast `SettingsModal`，一开关管双向。
- **生命周期**：设备连接成功且开关开 → 启动；断连/关窗/关开关/退出 → 停止；**失焦/最小化继续**；锁屏/休眠用 `powerMonitor`（suspend / lock-screen 暂停，resume / unlock 恢复）。
- 删除旧的 focusWin 剪贴板逻辑。

### 文件级改动

| 文件:行 | 改动 |
|---|---|
| **新增** `src/main/lib/clipboard-sync.ts` | 主进程模块：`start(deviceId)` / `stop()` 起停 500ms 定时器；持 `lastSynced`；`pushHostText()` 轮询 readText，变化且 ≤1MiB → `lastSynced=text`，`window.sendTo('screencast','clipboardFromHost',text)`；`writeFromDevice(text)`：`lastSynced=text`，`clipboard.writeText(text)`；挂 `powerMonitor` suspend/lock-screen/resume/unlock。导出 `getClipboardFiles()`（见 S3）。 |
| `src/main/index.ts` | 初始化剪贴板模块（在 `adb.init()` 之后引入/注册 IPC，参照 `src/main/index.ts:22-25` 的 init 结构）。 |
| `src/share/main/lib/ipc.ts` | 注册 `handleEvent('setClipboardSync', ({enabled, deviceId}) => …)`、`handleEvent('clipboardFromDevice', (text) => …)`、`handleEvent('getClipboardFiles', () => …)`（`handleEvent` 定义见 `src/share/main/lib/util.ts:59`）。 |
| `src/share/common/types.ts` | 新增 `IpcSetClipboardSync`、`IpcClipboardFromDevice`、`IpcGetClipboardFiles` 类型。 |
| `src/share/preload/main.ts` | 新增 `setClipboardSync: invoke(...)`、`clipboardFromDevice: invoke(...)`、`getClipboardFiles: invoke(...)`；`on` 已通用，可直接 `main.on('clipboardFromHost', ...)`。 |
| `src/renderer/screencast/store.ts:113-116` | **删除** focusWin 剪贴板 handler（被主进程轮询取代）。 |
| `src/renderer/screencast/store.ts`（bindEvent 区） | 新增 `main.on('clipboardFromHost', (text) => this.scrcpyClient?.setClipboard(text))`。 |
| `src/renderer/screencast/store.ts`（`setDevice` / `setSettings`） | 设备连接且 `settings.clipboardSync` 开 → `main.setClipboardSync({enabled:true, deviceId:device.id})`；断连/开关关 → `{enabled:false}`。 |
| `src/renderer/screencast/store.ts:120-123` | `defaultSettings` 增加 `clipboardSync: true`。 |
| `src/renderer/screencast/lib/ScrcpyClient.ts:139-148` | `setClipboard(text,paste)` 改为持私有递增计数器 `seq`（`++this.clipboardSeq`），`controller.setClipboard({sequence: this.clipboardSeq, content:text, paste})` 并 `await`（触发 Ack 串行化）；空串/超 1MiB 直接 return。 |
| `src/renderer/screencast/lib/ScrcpyClient.ts:507-511` | `options.clipboard` 写回目标由 `navigator.clipboard.writeText(content)` 改为 `main.clipboardFromDevice(content)`（失焦也能写）。 |
| `src/renderer/screencast/components/SettingsModal.tsx` | 增加一个 `LunaSettingSwitch`（`keyName="clipboardSync"`），`onChange` 走 `store.setSettings`。 |

### 数据流

- **宿主→设备**：`clipboard-sync` 轮询 readText → 变化 → `lastSynced=text` → `sendTo screencast 'clipboardFromHost'` → renderer `setClipboard(text)`（递增 seq + ack）→ 设备。
- **设备→宿主**：scrcpy `options.clipboard` 流 → renderer `main.clipboardFromDevice(text)` → main `lastSynced=text` + `clipboard.writeText(text)` → 主进程下一轮轮询读到相等 → 跳过（回环抑制）。

---

## 5. S3 — 文件「粘贴导入」+ 设备内移动/复制（#5 / D2）

### 决策

- **入口**：设备文件列表当前目录空白处右键「粘贴文件」+ `Ctrl/Cmd+V`，统一 `pasteFromClipboard()` → 复用 `uploadFiles(path)`/`pushFile`。
- **捕获宿主文件列表**：主进程 `clipboard.availableFormats()/readBuffer` 解析三平台 → IPC `getClipboardFiles()` 返回绝对路径数组。
  - Windows：`FileNameW`(UTF-16 null 分隔) / `CF_HDROP`
  - macOS：`public.file-url` / `NSFilenamesPboardType`
  - Linux：`text/uri-list` + `x-special/gnome-copied-files`
- 与 S2 的**文本同步开关解耦**：文件粘贴是独立手动动作，不受文本自动同步开关影响。
- **冲突**：目标同名**自动重命名**「name (1).ext」，绝不静默覆盖。
- **进度/并发**：复用现有 `startTransfer/updateTransfer(500ms 节流)/finishTransfer` + `Semaphore(5)` + 目录递归。
- **设备内操作**：右键「复制到…/移动到…」（`cp -r` / `mv`）+ 同目录 `Ctrl+C/X → Ctrl+V`；剪贴板区分「宿主文件」与「设备内」两种状态。
- **安全**：路径穿越/符号链接校验移植到 `pushFile/moveFile/deleteFile/deleteDir/fileShell/pullFile` 入口。

### 文件级改动

| 文件:行 | 改动 |
|---|---|
| `src/main/lib/clipboard-sync.ts`（S2 同文件新建） | `getClipboardFiles(): Promise<string[]>`：`clipboard.availableFormats()` 判平台 → `readBuffer` 解析为绝对路径数组；无文件返回 `[]`。 |
| `src/share/common/types.ts` / `src/share/preload/main.ts` | `IpcGetClipboardFiles` + `getClipboardFiles`（同 S2 表已列）。 |
| `src/renderer/main/components/file/File.tsx` | 空区域右键菜单加「粘贴文件」项 + 组件级 `keydown` 监听 `Ctrl/Cmd+V`（焦点在列表而非输入框时）；`pasteFromClipboard()`：`const files = await main.getClipboardFiles()` → `uploadFiles(files)`。上传前 `readDir(dest)` 算唯一名（`name (1).ext`）再 `pushFile`。 |
| `src/renderer/main/components/file/File.tsx`（文件项右键） | 加「复制到…/移动到…」→ 设备目录选择器 → `main` 侧 `cp -r` / `mv`。加 `Ctrl+C`/`Ctrl+X` 记录设备内选中项到本地状态；`Ctrl+V` 在目标目录执行设备内复制/剪切。 |
| `src/renderer/main/store/file.ts` | 新增「设备内剪贴板状态」（`{mode:'copy'|'cut', paths:string[]}` 或 `{mode:'host', files:string[]}`），供 File.tsx 区分两种粘贴来源。 |
| `src/main/lib/adb/file.ts:44` `pullFile` | 入口校验 `dest`（本地）与 `src`（设备）安全。 |
| `src/main/lib/adb/file.ts:148` `deleteFile` / `:152` `deleteDir` / `:156` `createDir` | 入口调用 `assertSafePath(path)`。 |
| `src/main/lib/adb/file.ts:160` `pushFile` | 入口校验 `src`/`dest`；目录递归保持现状。 |
| `src/main/lib/adb/file.ts:231` `moveFile` | 入口校验 `src`/`dest`。 |
| `src/main/lib/adb/file.ts:415` `fileShell` | 用安全的 shell 参数引用（替换当前 `"${path}"` 双引号拼接；禁 `\0`、拒绝含 `..` 的逃逸）；新增 `copyFile`（`cmd='cp'`、`cp -r`）辅助或参数化 `fileShell` 支持 `-r`。 |
| **新增辅助**（同文件或 `src/main/lib/adb/path-safety.ts`） | `assertSafePath(p)`：禁 `/`（文件名级）、`\0`、`..` 段；`quoteShellArg(s)`：单引号转义。移植自 rustdesk `validate_file_name_no_traversal`/`validate_no_symlink_components` 思路。 |

> 现有 `fileShell` 用双引号包围 path（`src/main/lib/adb/file.ts:415-445`），含 `"`、`$()`、反引号可注入；这是本次必须修掉的边界。

### 冲突改名规则

`uniqueName(dir, name)`：若 `dir/name` 存在，拆 `base`/`ext` → `base (1).ext`、`base (2).ext`… 直到不存在。在 renderer 用已有 `readDir` 取得目标目录清单后计算。

---

## 6. S4 — scrcpy-server 更新器（#6 / D3）

### 决策

- **语义**：从 GitHub 拉**最新 release**，加版本闸门（不是只重取固定 5.0.1）；保留「重取当前 bundled 版本」作为修复入口。
- **source of truth**：`https://api.github.com/repos/Genymobile/scrcpy/releases/latest` 的 `tag_name` + 内置清单 `scrcpy-version.json`（`bundled`、`maxSupported`）。
- **闸门 + 动态版本**：常量 `MAX_SUPPORTED_SERVER`（= `@yume-chan/scrcpy` 上限 5.0.1，落清单 `maxSupported`）；`scrcpy.ts:23` 版本改读**实际选中 jar 的 version**；上游 > `maxSupported` **拒绝安装**并提示。
- **UI**：主应用设置全局区块（`src/renderer/main/components/toolbar/SettingsModal.tsx`）——当前/最新版本、`检查更新` 按钮、`启动时自动检查更新` 开关（默认开）；安装后**下次连接生效**（不热替换运行中的 server）。
- **校验/回滚**：下载到 `<tmp>` → 校验非空 + 大小合理（可加 sha256）→ 原子 `rename` 到 `userData/scrcpy/<ver>/scrcpy.jar`；失败保留旧 jar + `logger.warn`，不打断连接。

### 文件级改动

| 文件:行 | 改动 |
|---|---|
| **新增** `src/main/lib/scrcpy-version.json` | `{ "bundled": "5.0.1", "maxSupported": "5.0.1" }`（与 S1 一致）。 |
| **新增** `src/main/lib/scrcpy-updater.ts` | `checkLatest()`：GET releases/latest → 返回 `{version, assetUrl}`；`getVersions()`：返回 `{bundled, installed, latest, maxSupported}`；`install(version)`：下载临时文件→大小校验→原子 rename 到 `getUserDataPath('scrcpy/'+version+'/scrcpy.jar')`；`resolveJarVersion()`：选中的 jar 路径 + version（安装目录有效且 `<=maxSupported` 优先，否则回落 `resolveResources('scrcpy.jar')`）。 |
| `src/main/lib/adb/scrcpy.ts:23` | server version 由 `resolveJarVersion().version` 注入（替换硬编码 `4.0`）。 |
| `src/main/lib/adb/scrcpy.ts:39-41`（`push()`） | 推送源由 `resolveResources('scrcpy.jar')` 改为 `resolveJarVersion().path`（优先用户更新目录，回落打包资源）。 |
| `src/share/main/lib/ipc.ts` | 注册 `scrcpyCheckUpdate`、`scrcpyGetVersions`、`scrcpyUpdateNow`。 |
| `src/share/common/types.ts` / `src/share/preload/main.ts` | 对应 IPC 类型 + invoke。 |
| `src/renderer/main/store/settings.ts` | 增加 `scrcpyAutoCheck = true`（含 init names 数组与 `set`），持久化。 |
| `src/renderer/main/components/toolbar/SettingsModal.tsx` | 新增 scrcpy 版本区块：当前/最新版本文本、检查更新按钮（调用 `scrcpyCheckUpdate`）、自动检查开关（`scrcpyAutoCheck`）。 |
| `src/main/index.ts` | 启动时若 `scrcpyAutoCheck` 开则触发一次 `checkLatest()`（失败静默）。 |

### 版本三层耦合（必须一致）

1. `scrcpy-version.json`（source of truth：bundled / maxSupported）
2. `src/main/lib/adb/scrcpy.ts`（server 启动参数 version = 实际 jar 的 version）
3. `ScrcpyOptions5_0_1`（协议类，须匹配 jar 协议；4.1→5.0.1 协议不变，故固定 5_0_1 即可覆盖）

---

## 7. 依赖与实施顺序

```
S1 (scrcpy 升级)  ── 无依赖，先做（改动最小、可先验证投屏）
   │
S2 (剪贴板) ── 依赖 S1 的 ScrcpyClient options 类型（setClipboard/sequence）
   │
S3 (文件)   ── 依赖 S2 的主进程剪贴板读取通道（getClipboardFiles 同文件）
   │
S4 (更新器) ── 依赖 S1 的 version 注入点（scrcpy.ts:23）；可与 S2/S3 并行
```

建议顺序：**S1 → S4（可并行 S2）→ S2 → S3**。S1 与 S4 都动 `scrcpy.ts:23`，先合并 S1 再做 S4 的动态注入以减少冲突。

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| server/client 版本字符串不一致 → server abort | S4 统一由实际 jar 提供 version；S1 手改时确保 `scrcpy.mjs` 与 `scrcpy.ts:23` 同步 |
| 剪贴板回环风暴 | 单一 `lastSynced` 双向去重 + setClipboard 递增 seq/ack |
| 失焦时渲染进程写剪贴板被拒 | 读写全搬主进程（S2） |
| 文件名/shell 注入（`fileShell` 双引号拼接） | S3 的 `assertSafePath` + `quoteShellArg` 覆盖所有入口 |
| 静默覆盖用户文件 | S3 自动改名「name (1).ext」 |
| 更新器装坏 jar | 临时文件 + 校验 + 原子 rename + 失败保留旧 jar |
| 上游超 maxSupported | 版本闸门拒绝并提示 |

**回滚**：S1 撤 3 处版本/类型改动 + `npm run scrcpy` 重取 4.0 jar（`resources/` gitignore，需重下）；S4 删除 `userData/scrcpy/<ver>` 即回落打包 jar；代码级改动均单文件、可 `git revert`。

---

## 9. 验收标准

- **S1**：升级后投屏/音频/触控/键盘/剪贴板/录制全部正常；`tsc --noEmit` 通过。
- **S2**：宿主复制文本 → 设备粘贴板得到；设备复制文本 → 宿主剪贴板得到；两者在**失焦**状态下也生效；无回环抖动；关开关后停止；锁屏暂停、解锁恢复；>1MiB 跳过不崩。
- **S3**：三平台复制文件后能在设备当前目录「粘贴」，进度可见；同名自动改名不覆盖；设备内「复制到/移动到」可用；`../`、含 `/`、NUL 的恶意路径被拒并有日志；大批量受 `Semaphore(5)` 限流。
- **S4**：设置显示当前/最新版本，检查按钮可用，自动检查生效；下载→校验→原子替换成功，失败保留旧 jar；超 maxSupported 被拒并提示；下次连接用新 jar 且三层版本一致；离线时启动不阻塞连接仅告警。

---

## 10. 参考

- `docs/research/scrcpy-upgrade-path.md` — scrcpy 版本矩阵、精确改动、验证/回滚。
- `docs/research/rustdesk-clipboard-file-mechanics.md` — rustdesk 机制与 AYA 映射（Part C）。
- 设计票 Resolution：[剪贴板 #4](https://github.com/new-agent-lk/aada/issues/4)、[文件 #5](https://github.com/new-agent-lk/aada/issues/5)、[更新器 #6](https://github.com/new-agent-lk/aada/issues/6)。
