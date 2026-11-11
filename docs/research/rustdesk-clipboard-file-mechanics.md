# RustDesk 剪贴板同步与文件传输机制（源码级），及向 AYA（ADB + scrcpy）的映射

> 研究对象一：RustDesk，仓库 `/media/kang/software/rustdesk`（下称 **RD**）。
> 研究对象二：AYA，仓库 `/media/kang/myworkspace/aada`，一个 Electron 桌面应用，通过对本地 Android 设备的 ADB 控制 + scrcpy 投屏（下称 **AYA**）。
> 本文所有机制性结论均回溯到上述两个仓库的源码，并在每处给出 `文件:行号` 引用。文中「机制」一节只描述 RD 实际做了什么，「映射」一节只描述在 AYA 上对应/不对应什么。

---

## 目录

- [Part A — RustDesk 跨设备剪贴板同步（机制）](#part-a--rustdesk-跨设备剪贴板同步机制)
- [Part B — RustDesk 文件传输 / 移动 / 上传（机制）](#part-b--rustdesk-文件传输--移动--上传机制)
- [Part C — 映射到 AYA（ADB + scrcpy）](#part-c--映射到-ayaadb--scrcpy)
- [Part D — 引用索引](#part-d--引用索引)

---

## Part A — RustDesk 跨设备剪贴板同步（机制）

### A.1 参与者与总体架构

RD 的连接模型里有两个角色，剪贴板代码用 `ClipboardSide` 显式区分（`src/clipboard.rs:604`）：

- `ClipboardSide::Host` —— 被控端（host / 服务端）。
- `ClipboardSide::Client` —— 主控端（client / 控制端）。

剪贴板同步的核心文件：

| 文件 | 作用 |
|---|---|
| `src/clipboard.rs`（1136 行） | 本地剪贴板读写（`arboard`）、protobuf 编解码、owner 标记、监听器（`clipboard_listener`） |
| `src/server/clipboard_service.rs`（363 行） | Host 侧的剪贴板监听**服务进程**：检测本机变化 → 打包成 `Message` → 发送 |
| `src/client.rs` + `src/client/io_loop.rs` | Client 侧的检测循环与入站应用 |
| `src/server/connection.rs` | Host 侧收到入站剪贴板/文件消息后的分发 |
| `src/clipboard_file.rs`（498 行） | 文件剪贴板（CLIPRDR 风格）消息翻译 |
| `libs/clipboard/` | 底层 `arboard` 的封装与各平台（含 unix FUSE 文件剪贴板）实现 |

关键常量（`src/clipboard.rs:12-29`）：

- `CLIPBOARD_NAME = "clipboard"`，`FILE_CLIPBOARD_NAME = "file-clipboard"`（feature `unix-file-copy-paste` 时启用）。
- `CLIPBOARD_INTERVAL: u64 = 333` —— 监听循环的轮询/超时间隔（毫秒），见 `src/clipboard.rs:15`。
- `RUSTDESK_CLIPBOARD_OWNER_FORMAT = "dyn.com.rustdesk.owner"` —— 用于**回声抑制**的特殊剪贴板格式（见 A.6）。

### A.2 本地剪贴板访问（`arboard`）

本地读写统一走 `arboard` crate。`ClipboardContext` 包装了 `arboard::Clipboard`（`src/clipboard.rs:319-321`），并用全局互斥 `ARBOARD_MTX` 串行化访问（`src/clipboard.rs:36`）。支持的多格式集合见 `SUPPORTED_FORMATS`（`src/clipboard.rs:61-72`）：

```
Text, Html, Rtf, ImageRgba, ImagePng, ImageSvg,
[unix-file-copy-paste] FileUrl,
Special("XML Spreadsheet"),
Special(RUSTDESK_CLIPBOARD_OWNER_FORMAT)
```

读取用 `ClipboardContext::get()`（`src/clipboard.rs:392`）→ `get_formats_filter()`（`src/clipboard.rs:405`）。写入用 `set()`（`src/clipboard.rs:456`）/`set_formats()`。Windows 下读取会因「剪贴板被占用」重试（`CLIPBOARD_GET_MAX_RETRY = 3`、间隔 33ms，`src/clipboard.rs:45-47`、`src/clipboard.rs:359-390`）。Linux 上 `arboard::Clipboard::new()` 会重试最多 5 次以连接 X/Wayland（`src/clipboard.rs:332-354`）。

### A.3 线上数据模型（protobuf）

剪贴板内容被序列化为 `Message`，两种承载方式（`libs/base/protos/message.proto`）：

- 旧/单条：`Message.clipboard = Clipboard`（仅文本，向后兼容老 peer）。
- 新/多条：`Message.multi_clipboards = MultiClipboards{ clipboards: repeated Clipboard }`。

`Clipboard` 结构（由 `proto::plain_to_proto` / `image_to_proto` / `special_to_proto` 构造，`src/clipboard.rs:646-721`）：

```
Clipboard {
  bool compress;
  bytes content;        // 可能是压缩后的字节
  int32 width, height;  // 仅图像
  ClipboardFormat format;  // Text/Html/Rtf/ImageRgba/ImagePng/ImageSvg/Special
  string special_name;  // 仅 Special
}
```

`create_multi_clipboards`（`src/clipboard.rs:737`）把本地 `Vec<arboard::ClipboardData>` 转成 `MultiClipboards`；反向 `from_multi_clipboards`/`from_clipboard`（`src/clipboard.rs:748-786`）还原。压缩策略：内容先过 `hbb_common::compress::compress`，**只有当压缩后更小才置 `compress=true`**（`src/clipboard.rs:646-660` 等）。

**多剪贴板降级**：`is_support_multi_clipboard(peer_version, peer_platform)`（`src/clipboard.rs:549`）要求 peer 版本 ≥ `1.3.0`；iOS/未知平台返回 false；Android 要求 ≥ `1.3.3`。不支持时 `get_msg_if_not_support_multi_clip`（`src/clipboard.rs:788`）只挑第一个 `Text` 格式的 clipboard 用单条 `Message.clipboard` 发送。

### A.4 变化检测与推送（两侧对称）

底层变化事件来自 `clipboard_master` crate 的 `Master`，封装在 `pub mod clipboard_listener`（`src/clipboard.rs:899`）：

- 全局 `CLIPBOARD_LISTENER`（`src/clipboard.rs:914`）+ 代际计数 `CLIPBOARD_GENERATION`（`src/clipboard.rs:917`）。
- `ClipboardEvent { Changed, InitialSelection(Linux+file), Stop, StopWithError }`（`src/clipboard.rs:919-925`）。
- 只有**一个**共享 master 线程（x11 只允许一个剪贴板 master），但可多订阅者（`subscribers: HashMap<String, Sender<ClipboardEvent>>`），`subscribe`/`unsubscribe` 做引用计数（`src/clipboard.rs:1025`、`1087`）。
- `Handler::on_clipboard_change` 每次变化都 `CLIPBOARD_GENERATION.fetch_add(1)` 并向所有订阅者广播 `Changed`（`src/clipboard.rs:977-985`）。

**Host 侧检测 → 推送**：`src/server/clipboard_service.rs` 是一个常驻服务进程：

- `run()`（`src/server/clipboard_service.rs:54`）创建 `ClipboardContext` 并 `clipboard_listener::subscribe(sp.name(), tx_cb_result)`（`:71`）。
- 循环 `rx_cb_result.recv_timeout(Duration::from_millis(INTERVAL))`（`:82`）；收到 `ClipboardEvent::Changed` 后：若是文件剪贴板（`sp.name()==FILE_NAME`）→ `check_clipboard_file()`（`:174`）；否则 `handler.get_clipboard_msg()` 取内容并 `sp.send(msg)`。
- `Handler::get_clipboard_msg()`（`src/server/clipboard_service.rs:197`）：Windows 且 root 时从 CM 进程走 IPC 读（`read_clipboard_from_cm_ipc`，`:256`）；Linux 用 `peek_clipboard()` 并做 Wayland 键盘注入去抖（`should_skip_wayland_clipboard_sync`，上限 `WAYLAND_CLIPBOARD_INPUT_MAX_TEXT_CHARS * 4` 字节）；其余平台 `check_clipboard(ctx, Host, false)`。

**Client 侧检测 → 推送**：`Client::try_start_clipboard`（`src/client.rs:1926`）为**所有会话共享**一个线程（`CLIPBOARD_STATE` 全局，`src/client.rs:175`）：

- 订阅 `clipboard_listener` 后 `rx_cb_result.recv_timeout(CLIPBOARD_INTERVAL)`（`src/client.rs:1958`）。
- `Changed` → `handler.check_clipboard(true)`；`InitialSelection` → `check_clipboard(false)`（Android 走另一套 `try_start_clipboard(_p)`，`src/client.rs:1990`，用 `crate::clipboard::get_clipboards_msg(true)`）。
- `ClientClipboardHandler::check_clipboard(check_text)`（`src/client.rs:2073`）：文件优先 `check_clipboard_files(Client,false)` → `unix_file_clip::get_format_list()`；文本 `check_clipboard(ctx, Client, false)`。发送前对老 peer 用 `get_msg_if_not_support_multi_clip` 做多→单降级（`src/client.rs:2130-2140` 附近）。

### A.5 入站应用（应用到本机剪贴板）

- **Host 收到**（`src/server/connection.rs`）：
  - `Some(message::Union::Clipboard(cb))`（`:3400`）：`should_handle_text_clipboard_message() && clipboard_enabled()` 时 `update_clipboard(vec![cb], ClipboardSide::Host)`。
  - `Some(message::Union::MultiClipboards(_mcb))`（`:3428`）：`update_clipboard(_mcb.clipboards, ClipboardSide::Host)`。
- **Client 收到**（`src/client/io_loop.rs`）：
  - `Some(message::Union::Clipboard(cb))`（`:1858`）：`!disable_clipboard.v && !view_only.v` 时 `update_clipboard(vec![cb], ClipboardSide::Client)`（移动端走 `handle_msg_clipboard`）。
  - `Some(message::Union::MultiClipboards(_mcb))`（`:1896`）：同理。

`update_clipboard`（`src/clipboard.rs:312`）开线程 → `update_clipboard_` → `proto::from_multi_clipboards` 反序列化 → `do_update_clipboard_`（`src/clipboard.rs:259`）→ 加 owner 标记 → `ctx.set()`。

### A.6 回声/回环抑制（owner 标记）——关键

问题：A 端把内容推到 B 端，B 端把它写进本机剪贴板，B 端的监听线程会把它当成「用户新复制」再推回 A，形成无限回环。RD 的方案是**在剪贴板里塞一个私有 owner 标记格式**：

- 写入时 `append_owner_marker`（`src/clipboard.rs:283`）往数据里加一条 `Special(RUSTDESK_CLIPBOARD_OWNER_FORMAT, side.get_owner_data())`。Windows 把它插到**最前**（setter 遇到第一个失败格式就停，放末尾可能被跳过），其他平台放到**末尾**（`src/clipboard.rs:288-294`）。
- owner 数据：Host = `[0b01]`，Client = `[0b10]`（`get_owner_data`，`src/clipboard.rs:613`）。
- 读取时 `get_formats_filter`（`src/clipboard.rs:405`）：当 `!force` 且数据里有 `Special(RUSTDESK_CLIPBOARD_OWNER_FORMAT, d)` 且 `side.is_owner(d)`（即 `d[0] & 0b11 != 0`，`src/clipboard.rs:620`）→ 认为「是我自己刚写进去的」，**返回空**，不推送。
- 输出时还会把 owner 标记这一项从最终数据里剔除（`src/clipboard.rs:427-432`）。

这等价于一个「内容指纹/来源戳」：只有非本端写入的剪贴板变化才会被同步出去。

### A.7 尺寸、压缩与其他边界

- **压缩**：所有文本/图像/Special 都可能被压缩，只有更小才标记 `compress`（见 A.3）。接收方 `from_clipboard` 依 `compress` 决定是否 `decompress`（`src/clipboard.rs:748-753`）。图像还校验 RGBA 尺寸与字节数一致（`valid_rgba_dimensions`，`src/clipboard.rs:49-58`），防越界。
- **空文本**：`get_formats_filter` 会过滤掉空的 `Text`（`src/clipboard.rs:429-430`），避免把空串同步过去。
- **Wayland 去抖**：Linux/Wayland 下，注入键盘后紧邻的剪贴板变化会被跳过，避免「模拟粘贴触发的复制」被误同步（`src/server/clipboard_service.rs` 的 `should_skip_wayland_clipboard_sync`）。这是一处以字符数（`* 4` 字节）为界的软尺寸限制。
- **文件剪贴板独立**：`get()` 若发现含 `FileUrl` 直接返回空（`src/clipboard.rs:396-401`），文件走单独的 `file-clipboard` 服务（见 A.8）。

### A.8 文件剪贴板（CLIPRDR 风格）——独立路径

文件（不是文本）的「复制/粘贴」走的是 **RDP CLIPRDR 协议形状** 的消息通道，而不是文本 `Clipboard`。核心在 `src/clipboard_file.rs`：

- `clip_2_msg(clip: clipboard::ClipboardFile) -> Message`（`src/clipboard_file.rs:4`）把内部枚举翻成 protobuf `Cliprdr` 的 oneof：`MonitorReady / FormatList / FormatListResponse / FormatDataRequest / FormatDataResponse / FileContentsRequest / FileContentsResponse / TryEmpty / Files`。`msg_2_clip`（`:183`）反向。文件里注释明说「main logic from freeRDP」（`libs/base/protos/message.proto` 的 Cliprdr 段同源）。
- 这些 oneof 直接对应 CLIPRDR 的 `FormatList`、`FormatDataRequest/Response`（传文件描述符 `FILEDESCRIPTOR`）、`FileContentsRequest/Response`（分块拉文件字节），见 `libs/base/protos/message.proto` 的 `Cliprdr*` 消息。
- `unix_file_clip::serve_clip_messages(side, clip, conn_id)`（`src/clipboard_file.rs:283`）是 host 侧状态机：收到 `FormatList` → 选 `file_descriptor` id 发 `FormatDataRequest`；`FormatDataRequest` → `serv_files::get_file_list_pdu(conn_id)` 回 `FormatDataResponse`；`FormatDataResponse` → 用 **FUSE** 把文件描述符物化成本地 url（`fuse::init_fuse_context` / `format_data_response_to_urls`）再 `update_clipboard_files`；`FileContentsRequest` → `serv_files::read_file_contents(...)` 按需拉字节。
- Host 侧拉取/投递：`Handler::check_clipboard_file`（`src/server/clipboard_service.rs:174`）读 `FileUrl` → `serv_files::sync_files(urls)` → `clipboard::send_data(0, get_format_list())`，最终路由到 `connection.rs::handle_file_clip`（`src/server/connection.rs:6231`）发出。

**要点**：RD 的「文件剪贴板」= 远端剪贴板里出现一组文件 → 通过 CLIPRDR 的 format-list + file-contents 分块流式拉取 → 本地用 FUSE 挂载成真实文件，从而可「粘贴到本地文件夹」。它与文本剪贴板是两条独立管线。

---

## Part B — RustDesk 文件传输 / 移动 / 上传（机制）

> 说明：RD 的「文件传输」指的是一套独立的**文件管理器/传输窗口**（不是剪贴板），通过同一 `Message` 通道传输目录结构与文件块。核心在 `libs/base/src/fs.rs`（1920 行）。

### B.1 消息模型（`FileAction` / `FileResponse`）

`libs/base/protos/message.proto`（行 360–530）：

```
message FileEntry { FileType entry_type; string name; bool is_hidden; uint64 size; uint64 modified_time; }
enum FileType { Dir=0; DirLink=2; DirDrive=3; File=4; FileLink=5; }
message FileDirectory { int32 id; string path; repeated FileEntry entries; }

message FileAction {                 // 请求方向（主控 → 被控，或反向的响应动作）
  oneof union {
    ReadDir read_dir = 1;            // 列目录
    FileTransferSendRequest send = 2;        // 请求发送文件（下载/上传启动）
    FileTransferReceiveRequest receive = 3;  // 告知对端将要接收的清单
    FileDirCreate create = 4;        // 建目录
    FileRemoveDir remove_dir = 5;    // 删目录
    FileRemoveFile remove_file = 6;  // 删文件
    ReadAllFiles all_files = 7;      // 递归列出全部文件（用于整目录删除）
    FileTransferCancel cancel = 8;   // 取消
    FileTransferSendConfirmRequest send_confirm = 9;  // 覆盖/续传确认
    FileRename rename = 10;          // 重命名
    ReadEmptyDirs read_empty_dirs = 11;
  }
}

message FileResponse {               // 响应方向
  oneof union {
    FileDirectory dir = 1;           // 目录列表响应
    FileTransferBlock block = 2;     // 文件数据块
    FileTransferError error = 3;
    FileTransferDone done = 4;
    FileTransferDigest digest = 5;   // 覆盖检测/续传摘要
    ReadEmptyDirsResponse empty_dirs = 6;
  }
}
```

任务描述里的 `create_dir / remove_dir / remove_file / send_files / send_file / read_dir / read_all_files / read_all_files_response` 对应的正是上面 `FileAction.union` 的 `create / remove_dir / remove_file / send / read_dir / all_files` 以及 `FileResponse` 的 `dir / empty_dirs`（`read_all_files` 的「响应」是 `FileResponse.dir`/`empty_dirs`，而非单独的 FileAction 分支）。

附带结构（`libs/base/protos/message.proto`）：

- `FileTransferSendRequest { id; path; include_hidden; file_num; FileType{Generic=0,Printer=1} file_type; }`
- `FileTransferReceiveRequest { id; path /*写入目标*/; repeated FileEntry files; file_num; total_size; }`
- `FileTransferBlock { id; file_num; bytes data; bool compressed; blk_id; }`
- `FileTransferDigest { id; file_num; last_modified; file_size; is_upload; is_identical; transferred_size; is_resume; }`
- `FileTransferSendConfirmRequest { id; file_num; oneof { bool skip=3; uint32 offset_blk=4; } }`
- `FileTransferDone { id; file_num; }`、`FileTransferError { id; error; file_num; }`、`FileTransferCancel { id; }`
- `FileRemoveDir { id; path; recursive; }`、`FileRemoveFile { id; path; file_num; }`、`FileDirCreate { id; path; }`、`FileRename { id; path; new_name; }`、`ReadAllFiles { id; path; include_hidden; }`、`ReadDir { path; include_hidden; }`

顶级 `Message.file_action = 17`、`Message.file_response`、`Message.cliprdr`、`Message.clipboard`、`Message.multi_clipboards` 都在同一 `Message`（`libs/base/protos/message.proto`）。

### B.2 `TransferJob` 状态机（read / write）

`pub struct TransferJob`（`libs/base/src/fs.rs:429`）是一次传输的完整状态：

```
id, type(JobType: Generic|Printer), remote, data_source(FilePath|MemoryCursor),
show_hidden, is_remote, is_last_job, is_resume, file_num,
files: Vec<FileEntry>, conn_id, data_stream: Option<DataStream>,
total_size, finished_size, transferred, enable_overwrite_detection,
file_confirmed, file_skipped, file_is_waiting, default_overwrite_strategy,
digest: FileDigest, download: Option<DownloadState>
```

- 两个构造器：`new_write(...)`（`libs/base/src/fs.rs:614`）——**接收方**；`new_read(...)`（`libs/base/src/fs.rs:650`）——**发送方**，会调用 `get_recursive_files(p, show_hidden)` 递归枚举文件并累加 `total_size`。
- 每个 `TransferJob` 用 `id` 唯一标识；多个 job 存在 `read_jobs`/`write_jobs: Vec<TransferJob>` 里（见 `src/client/io_loop.rs:82-83`、`src/server/connection.rs:364`）。`get_job`/`remove_job` 按 id 查找（`libs/base/src/fs.rs:1445-1459`）。

发送循环 `handle_read_jobs(jobs, stream)`（`libs/base/src/fs.rs:1475`）：`init_jobs` 初始化数据流 → 对每个未结束 job 调 `read()` 取一块 → `new_block()` 发送；读完 `job_completed()` 时发 `new_done()` 或 `new_error()`，并从 `jobs` 移除。每次只处理一个 job 再 `break`（逐个推进）。

### B.3 分块与压缩

发送方 `read(&mut self) -> ResultType<Option<FileTransferBlock>>`（`libs/base/src/fs.rs:1035`）：

- 固定块大小 `const BUF_SIZE: usize = 128 * 1024`（128 KiB，`libs/base/src/fs.rs:1059`）。
- 读满一块后：若来源是 `FilePath` **且扩展名不是已压缩类型**（`is_compressed_file`: xz/gz/zip/7z/rar/bz2/tgz/png/jpg，`libs/base/src/fs.rs:497-502`），尝试 `compress(&buf)`，变小才 `compressed=true`（`libs/base/src/fs.rs:1090-1098`）。
- 读到 0 字节 = 当前文件结束 → `file_num += 1`；若整体读完 → 返回 `None`。
- 返回 `FileTransferBlock { id, file_num, data, compressed, .. }`。`finished_size`/`transferred` 累计。

接收方 `write(&mut self, block)`（`libs/base/src/fs.rs:847`）：

- `block.file_num` 变化或数据流未建时：`modify_time()` 收尾上一个文件 → 新建 `File::create(&path)`（先写 `<path>.download`，并写 `<path>.digest` = json(FileDigest)）。
- `block.compressed` 为真先 `decompress(&block.data)` 再写；`finished_size += len`。
- `modify_time()`（`libs/base/src/fs.rs:774`）在文件完成时把 `<path>.download` **rename** 成正式 `<path>`，设置 mtime，并删掉 `.digest`。

### B.4 覆盖检测 / 续传（digest）

- `get_current_digest()`（`libs/base/src/fs.rs:979`）返回 `(last_modified_secs, file_size)`。
- 若 `enable_overwrite_detection` 且尚未确认，`init_data_stream`（`:999`）/发送前 `send_current_digest`（`libs/base/src/fs.rs:1125`）先发一个 `FileTransferDigest` 并挂起等待对端确认（`file_is_waiting=true`），发端 `read()` 此时返回 `None` 不推进（`libs/base/src/fs.rs:1037-1039`）。
- 接收侧逻辑在 `DigestCheckResult`（`libs/base/src/fs.rs:1599` 附近 `check_digest`）：比对本地 `FileEntry` 的 size/mtime 与 `.digest` 文件，决定 `NeedConfirm`（需用户确认覆盖）还是 `is_identical`（相同则跳过）还是无文件。
- `FileTransferSendConfirmRequest` 回包：`skip=true` 表示跳过，`offset_blk=0` 表示覆盖/从头传（`src/client/io_loop.rs` 的 `Data::SetConfirmOverrideFile` 段，约 `:1090-1155`）。续传时 `set_finished_size_on_resume`（`libs/base/src/fs.rs:835`）按已完成文件累计 `finished_size`。

### B.5 文件操作（增删改查、递归删除）

客户端 `src/client/io_loop.rs` 把 UI 的 `Data::*` 事件翻译成 `FileAction` 消息（对 remote 生效），或本地直接执行（对 local 生效）：

| UI 事件（`Data::`） | 发向对端 | 本地执行 | 引用 |
|---|---|---|---|
| `RemoveDirAll((id,path,is_remote,include_hidden))` | `FileAction.all_files(ReadAllFiles)` | `fs::get_recursive_files` + `RemoveJob` | `src/client/io_loop.rs:1156` |
| `RemoveDir((id,path))` | `FileAction.remove_dir(FileRemoveDir{recursive:true})` | — | `src/client/io_loop.rs` 约 `:1207` |
| `RemoveFile((id,path,file_num,is_remote))` | `FileAction.remove_file(FileRemoveFile)` | `fs::remove_file` | `src/client/io_loop.rs` 约 `:1219` |
| `CreateDir((id,path,is_remote))` | `FileAction.create(FileDirCreate)` | `fs::create_dir` | `src/client/io_loop.rs:1253` |
| `RenameFile((id,path,new_name,is_remote))` | `FileAction.rename(FileRename)` | `fs::rename_file` | `src/client/io_loop.rs:1286` |
| `SendFiles((id,type,path,to,file_num,include_hidden,is_remote))` | `fs::new_send(...)` / `fs::new_receive(...)` | 建 TransferJob | `src/client/io_loop.rs:852` |

`src/client/file_trait.rs` 提供薄封装：`remove_file`、`remove_dir_all`、`remove_dir`、`create_dir`、`send_files`（约 `:57-127`）。

Host 侧收到 `FileAction`（`src/server/connection.rs:3516`）：先看是否启用文件传输 / 是否 one-way-file-transfer（`OPTION_ONE_WAY_FILE_TRANSFER`，单向时拒绝 peer 主动拉取/删除）；对 `Send/RemoveFile/Rename/Create/RemoveDir` 逐分支处理，用 `handle_read_jobs` + `TransferJob` 服务对端。目录列表用 `read_dir`（`libs/base/src/fs.rs:53`，Windows 对 `/` 会列出所有盘符 `GetLogicalDrives`，并识别隐藏文件/符号链接）。

### B.6 安全校验（trust boundary）

由于对端可控，`TransferJob` 对文件名做严格校验：

- `validate_file_name_no_traversal`（`libs/base/src/fs.rs:504`）：拒空字节、拒 `..` 路径穿越、Windows 拒盘符/绝对路径、非 Windows 拒前导 `/`。
- `validate_no_symlink_components`（`libs/base/src/fs.rs:560`）：逐段 `symlink_metadata`，拒符号链接（best-effort，注释承认 TOCTOU 窗口）。
- `join_validated_path`（`libs/base/src/fs.rs:606`）：校验后 join。
- Android 额外做 scoped-storage 路径约束（`connection.rs` 里 android 分支拒绝越出 app workspace 的路径）。

### B.7 端到端流程小结

- **上传（local→remote）**：UI `Data::SendFiles(is_remote=true)` → `write_jobs.push(new_write)` + 发 `FileAction.send(FileTransferSendRequest)`；对端（Host）收到后建 `read_jobs.push(new_read)` 并 `handle_read_jobs` 逐块发 `FileResponse.block`；本端 `write()` 落盘到 `<path>.download`，完成后 rename。
- **下载（remote→local）**：UI `Data::SendFiles(is_remote=false)` → `read_jobs.push(new_read)` + 发 `FileAction.receive(FileTransferReceiveRequest{files,total_size})`；对端按清单回 `FileResponse.block`。
- 全程 `FileResponse.digest` 做覆盖/续传协商，`FileResponse.done/error` 收尾，`FileAction.cancel` 取消。

---

## Part C — 映射到 AYA（ADB + scrcpy）

### C.1 AYA 的架构事实

AYA 是一个 Electron 应用（`package.json`：`electron 30.5.1`、`appId io.liriliri.aya`、`version 1.14.2`），靠 **ADB** 控制本地 Android 设备，靠 **scrcpy** 投屏与注入输入。它使用 `@yume-chan/scrcpy 3.0.0-beta.4`（Web 端 scrcpy 客户端实现）。

- ADB 文件操作：`src/main/lib/adb/file.ts`（Node 侧，走 `@devicefarmer/adbkit` 的 `device.push/pull/readdir` 与 `adb shell`）。
- scrcpy 控制/投屏：`src/renderer/screencast/lib/ScrcpyClient.ts`（renderer 侧，`@yume-chan/scrcpy` 的 `ScrcpyControlMessageWriter`、`options.clipboard`、`options.deviceMessageParsers`）。
- 会话状态：`src/renderer/screencast/store.ts`。

### C.2 剪贴板映射：文本可映射，文件剪贴板不可映射

**RD 机制（回顾）**：主机本地剪贴板变化 → 监听器 → 打包 `Clipboard/MultiClipboards`（多格式：Text/Html/Rtf/Image/Special + owner 标记抑制回声）→ 发送 → 对端反序列化写入本地剪贴板；此外还有一整套 CLIPRDR + FUSE 的**文件剪贴板**。

**AYA 实际**：scrcpy 的控制协议只提供**纯文本**剪贴板消息：

- Host→设备：`ScrcpyClient.setClipboard(text, paste)`（`src/renderer/screencast/lib/ScrcpyClient.ts:139-148`）→ `ScrcpyControlMessageWriter.setClipboard({sequence:0n, content:text, paste})`。
- 设备→Host：`options.clipboard`（scrcpy 的 `clipboardAutosync` 打开时，`store.ts:74` `clipboardAutosync: true`）是一条**字符串流**，在 `ScrcpyClient.ts:507-511` 被 `pipeTo` 到 `navigator.clipboard.writeText(content)`。
- 触发时机：窗口获得焦点时 AYA 主动把**宿主剪贴板文本**推给设备：`store.ts:114-115` `const text = await navigator.clipboard.readText(); this.scrcpyClient.setClipboard(text)`。

scrcpy 协议本身（`node_modules/@yume-chan/scrcpy/src/base/control-message-type-value.ts`）：控制消息类型 `GetClipboard = 8`、`SetClipboard = 9`；`SetClipboardControlMessage` 结构（`.../src/1_21/impl/set-clipboard.ts`）只有 `{type, sequence:u64, paste:bool, content:text}` —— **struct 里只有文本，没有格式/图像/文件通道**。

由此得到的映射表：

| RD 能力 | AYA 是否有对应 | 适配说明 |
|---|---|---|
| 文本剪贴板双向同步 | ✅ | scrcpy `set_clipboard`(type 9) 下发；`options.clipboard` 流上行写入系统剪贴板。仅纯文本 `string`。 |
| 多格式（HTML/RTF/图片） | ❌ | scrcpy 协议消息里没有格式枚举，只有 `content:string`。 |
| 剪贴板 owner 标记回声抑制 | ⚠️ 需另做 | scrcpy 有 `sequence` + `paste` 位与 `AckClipboard` 机制可用于去重/抑制回环，但不是 RD 那种「塞私有剪贴板格式」。AYA 目前靠焦点触发 + `clipboardAutosync`，回环风险由 scrcpy 的 sequence/ack 协商规避。 |
| 文件剪贴板（复制文件→对端 FUSE 挂载→粘贴） | ❌ | **scrcpy 无任何文件剪贴板/CLIPRDR 通道**（见 C.4）。文件只能走 ADB push/pull。 |
| Android 端系统性剪贴板管理（后台读多格式） | ❌ | scrcpy 只在会话内、`clipboardAutosync` 开启时同步文本；无 RD 那种 `scrap::android::ffi::call_clipboard_manager_update_clipboard` 级别的系统剪贴板直写多格式能力。 |

**结论**：AYA 的剪贴板是「scrcpy 文本剪贴板桥」，等价于 RD 的最小子集（仅 `ClipboardFormat::Text`），完全可以映射；RD 的多格式与回声抑制机制在 scrcpy 侧需要降级到「文本 + sequence 去重」。

### C.3 文件传输映射：adb push/pull + shell mv/cp

**RD 机制（回顾）**：自有 `FileAction/FileResponse` over `Message`，`TransferJob` 分块（128 KiB）、可压缩、带 digest 覆盖检测/续传，支持建目录/删/改名/递归列举，安全校验路径穿越。

**AYA 实际**：文件传输没有自有协议，直接借 Android 调试桥：

- **上传（local→device）**：`pushFile(deviceId, src, dest)`（`src/main/lib/adb/file.ts:160`）。目录递归 `createDir` + 逐文件 `pushFile`（`:166-176`）；受限目录 `/data/data/...` 先推到 `/data/local/tmp/<uuid>` 再用 `fileShell(deviceId,'cp',tmp,dest)`（`:184-209`）；主体 `device.push(src, dest)`（adb push，`:192`）；进度用 `transfer.on('progress')` 节流上报 `window.sendTo('main','updateTransfer',...)`（`:199-215`）。
- **下载（device→local）**：`pullFile(deviceId, src, dest)`（`src/main/lib/adb/file.ts:44`）。目录递归；`/data/data` 用 root/`cp` 先搬到 `/data/local/tmp`；主体 `device.pull(src)`（adb pull，`:79`）→ `fs.createWriteStream(dest)`，进度节流上报。
- **移动/改名**：`moveFile(deviceId, src, dest)` = `fileShell(deviceId, 'mv', src, dest)`（`src/main/lib/adb/file.ts:232`）。
- **删除**：`deleteFile` = `fileShell(...,'rm', path)`（`:149`）；`deleteDir` 同理。
- **建目录**：`createDir`（`src/main/lib/adb/file.ts:156`）。
- **列目录**：`readDir`（`:235`），普通目录走 `device.readdir`，`/data/data` 等受限目录走 `readDataDir`/`readDirByShell`（`rootShell(ls -al)` 解析，`:288-300`）。
- 并发与节流：`fileSemaphore = new Semaphore(5)` 限制并发 5（`src/main/lib/adb/file.ts:37-42`），进度 `throttle(..., 500)`。
- IPC 事件：`pullFile/pushFile/deleteFile/deleteDir/...` 通过 `handleEvent` 注册到 main（`src/main/lib/adb/file.ts:490-498`）。

映射表：

| RD 能力 | AYA 对应 | 适配说明 |
|---|---|---|
| 上传/下载（分块流式） | ✅ `adb push` / `adb pull` | 分块与背压由 adbkit 的 `Sync` 完成；AYA 只订阅 `progress` 事件做进度条。 |
| 传输压缩（`compress`/`compress` 小块） | ⚠️ 无 | adb sync 不压缩；RD 的「小块 gzip」在 AYA 不存在。大文件靠网络/带宽，无应用层压缩。 |
| digest 覆盖检测 / 断点续传 | ⚠️ 需另做 | adb push/pull 无内建续传语义；AYA 目前是整文件覆盖。若要续传需自己在 `pushFile/pullFile` 里维护 offset（adb sync 不支持 seek 续传，通常改用 `dd`/分片或第三方库）。 |
| 建目录 / 删文件 / 删目录 / 改名 | ✅ | `createDir`、`deleteFile('rm')`、`deleteDir`、`moveFile('mv')`，见上。 |
| 递归删除整目录 | ✅ | 递归 `deleteDir`（ADB shell `rm -r`）。RD 用 `ReadAllFiles` + 逐个 `remove_file`，AYA 直接 shell。 |
| 路径穿越/符号链接安全校验 | ⚠️ 需另做 | RD 有 `validate_file_name_no_traversal`/`validate_no_symlink_components`；AYA 直接拼 shell/push 路径，需要在 `fileShell`/`pushFile` 入口自行做校验（尤其 `dest` 来自用户输入时）。 |
| 文件剪贴板（复制→粘贴文件） | ❌ | 无对应物（见 C.4）。 |

### C.4 明确「不能直接照搬」的部分

1. **RDP/CLIPRDR 文件剪贴板重定向没有 scrcpy 对应物**。RD 的 `src/clipboard_file.rs` + `libs/clipboard/.../fuse` 依赖 CLIPRDR 的 `FormatList`/`FileContentsRequest` 拉取远端文件并通过 FUSE 挂载成本地可粘贴文件。scrcpy 控制协议只有文本 `SetClipboard`/`GetClipboard`，**没有文件描述符、没有文件内容分块、没有 FUSE 挂载**。AYA 若要「复制文件到设备/从设备复制文件」，只能落到 `adb push/pull`，不存在「剪贴板里的一段文件列表」这种语义。
2. **多格式剪贴板（HTML/RTF/图片/Special 格式）无对应物**。scrcpy `content` 是单一 `string`。
3. **RD 的 owner 标记回声抑制机制无直接对应物**。scrcpy 用 `sequence`(u64) + `paste` 位 + `AckClipboard` 设备消息做去重，机制不同：RD 是把「来源戳」塞进系统剪贴板格式里；scrcpy 是消息级序号。
4. **RD 的应用层压缩 + digest 续传在 scrcpy/adb 侧不存在**。要等价能力得在 AYA 自己的传输层实现。
5. **RD 的 `Message` 复用通道（同一 protobuf 里既有视频也有文件/剪贴板）无对应物**。scrcpy 用独立 socket（video/audio/control）+ 各自二进制协议；adb 文件走 `adb` 的 sync 子协议。AYA 的「控制」与「文件」是两套完全不同的传输栈。

### C.5 给 AYA 的落地建议（如果要向 RD 的语义靠拢）

- **剪贴板**：保持 scrcpy 文本桥即可；若需多格式，需在设备端装一个辅助 app 用 `ClipboardManager` 读写多格式（相当于替代 RD 的 `scrap::android::ffi`）。回声抑制可复用 scrcpy `sequence`/`AckClipboard`，或加「最近写入指纹」去重。
- **文件传输**：以 `adb push/pull` 为基座，若要 RD 式体验可加：(a) 传输队列与 UI 进度（AYA 已有 `startTransfer/updateTransfer/finishTransfer` 事件链）；(b) 覆盖检测（比较 mtime/size，落 `.download`+`.digest` 再 rename，完全可照搬 RD 的 `fs.rs` 落盘模式）；(c) 续传需自研分片（adb sync 不支持 seek）。
- **安全性**：务必把 RD 的 `validate_file_name_no_traversal` + `validate_no_symlink_components` 思路移植到 AYA 的 `pushFile/pullFile/fileShell` 入口，因为 `dest`/`path` 可能来自对端或用户输入。

---

## Part D — 引用索引

### RustDesk（`/media/kang/software/rustdesk`）

- `src/clipboard.rs`
  - 常量/间隔 `:12-29`；`SUPPORTED_FORMATS` `:61-72`；`check_clipboard` `:75`；`read_clipboard_message` `:95`；`check_clipboard_files` `:139`；`do_update_clipboard_` `:259`；`append_owner_marker` `:283`；`update_clipboard` `:312`；`ClipboardContext` `:319`；`get()` `:392`；`get_formats_filter` `:405`；`is_support_multi_clipboard` `:549`；`ClipboardSide` `:604`；`get_owner_data` `:613`；`is_owner` `:620`；proto 模块 `:638`；`create_multi_clipboards` `:737`；`from_multi_clipboards` `:781`；`get_msg_if_not_support_multi_clip` `:788`；Android `handle_msg_clipboard` `:850`；`clipboard_listener` `:899-1136`
- `src/clipboard_file.rs`：`clip_2_msg` `:4`；`msg_2_clip` `:183`；`is_file_data_request` `:227`；`unix_file_clip` / `serve_clip_messages` `:234-448`
- `src/server/clipboard_service.rs`：`run` `:54`；`subscribe` `:71`；`Changed` 分支 `:82`；`check_clipboard_file` `:174`；`get_clipboard_msg` `:197`；`read_clipboard_from_cm_ipc` `:256`
- `src/server/connection.rs`：`Clipboard(cb)` `:3400`；`MultiClipboards` `:3428`；`Cliprdr(clip)` `:3437`；`FileAction(fa)` `:3516`；`handle_file_clip` `:6231`
- `src/client.rs`：`try_stop_clipboard` `:1899`；`try_start_clipboard` `:1926`（desktop）/`:1990`（android）；`check_clipboard` `:2073`
- `src/client/io_loop.rs`：`Clipboard(cb)` `:1858`；`MultiClipboards` `:1896`；`Cliprdr` `:1941`；`FileResponse` `:1944`；`Data::SendFiles` `:852`；`RemoveDirAll` `:1156`；`CreateDir` `:1253`；`RenameFile` `:1286`；`handle_cliprdr_msg` `:2803`
- `libs/base/src/fs.rs`：`read_dir` `:53`；`is_compressed_file` `:497-502`；`validate_file_name_no_traversal` `:504`；`validate_no_symlink_components` `:560`；`join_validated_path` `:606`；`TransferJob` `:429`；`new_write` `:614`；`new_read` `:650`；`modify_time` `:774`；`write` `:847`；`get_current_digest` `:979`；`init_data_stream` `:999`；`read` `:1035`；`BUF_SIZE` `:1059`；`send_current_digest` `:1125`；`job_completed` `:1196`；`confirm` `:1284`；`new_send_confirm` `:1377`；`new_receive` `:1386`；`new_send` `:1408`；`remove_job`/`get_job` `:1445-1459`；`init_jobs` `:1461`；`handle_read_jobs` `:1475`；`DigestCheckResult`/`check_digest` `~:1599-1690`
- `libs/base/protos/message.proto`：`FileTransfer` `:56`；`FileEntry` `:368`；`FileDirectory` `:376`；`ReadDir` `:382`；`ReadEmptyDirs` `:387`；`ReadAllFiles` `:397`；`FileRename` `:403`；`FileAction` `:409`；`FileResponse` `:427`；`FileTransferDigest` `:438`；`FileTransferBlock` `:452`；`FileTransferSendRequest` `:466`；`FileTransferSendConfirmRequest` `:479`；`FileTransferReceiveRequest` `:493`；`FileRemoveDir` `:501`；`FileRemoveFile` `:507`；`FileDirCreate` `:513`；`Message.file_action=17` `:1021`

### AYA（`/media/kang/myworkspace/aada`）

- `src/renderer/screencast/lib/ScrcpyClient.ts`：`setClipboard` `:139-148`；`createControl` + `options.clipboard.pipeTo(navigator.clipboard.writeText)` `:507-511`；`new ScrcpyControlMessageWriter` `:502`
- `src/renderer/screencast/store.ts`：`clipboardAutosync: true` `:74`；焦点时 `navigator.clipboard.readText()` → `setClipboard` `:114-115`
- `src/main/lib/adb/file.ts`：`pullFile` `:44`；`deleteFile('rm')` `:149`；`createDir` `:156`；`pushFile` `:160`；`moveFile('mv')` `:232`；`readDir` `:235`；`readDataDir` `:288`；`fileShell` `:415`；IPC 注册 `:490-498`；并发 `Semaphore(5)` `:37-42`
- `node_modules/@yume-chan/scrcpy/src/base/control-message-type-value.ts`：`GetClipboard=8`、`SetClipboard=9`
- `node_modules/@yume-chan/scrcpy/src/1_21/impl/set-clipboard.ts`：`SetClipboardControlMessage{ type, sequence:u64, paste:bool, content:text }`、`AckClipboardDeviceMessage{sequence:u64}`
- `node_modules/@yume-chan/scrcpy/src/{1_21,1_24}/options.ts`：`clipboardAutosync` → `deviceMessageParsers.add(...clipboard...)`（`options.clipboard` 文本流）

> 说明：`libs/clipboard/` 是 RD 的剪贴板底层 crate（含 `platform/unix/fuse`、`serv_files`），本文对其中 `serv_files::get_file_list_pdu`、`read_file_contents`、`sync_files`、`fuse::format_data_response_to_urls` 等的引用来自 `src/clipboard_file.rs` / `src/server/clipboard_service.rs` 的调用点，未逐一展开该 crate 内部实现。
