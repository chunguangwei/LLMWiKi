# 云盘共享部署指南（团队 / 多设备）

LLMWiki 默认是「单机应用」。要让一个项目在多台 Mac/Win 之间，或者一个小团队里多人共用，最简单的方式是把**项目目录**放到 iCloud Drive、OneDrive、Dropbox 或 Google Drive 等云盘里。

---

## 0. 各人先把应用装好

每位团队成员先在自己机器上安装应用本体（应用本体并不需要同步，需要同步的是「项目目录」）：

- **macOS（Apple Silicon）**：用本仓库已生成的 dmg，路径 `app/src-tauri/target/release/bundle/dmg/LLM Wiki_0.6.4_aarch64.dmg`，或从源码 `npm run tauri build`
- **macOS（Intel）/ Windows / Linux**：通过 GitHub Actions（upstream 已带 `.github/workflows/release.yml`）；或在对应平台从源码构建

首次启动 macOS 拦截参见 [getting-started.md §1](getting-started.md#1-安装)。

每个人**各自**在 *设置 → LLM Models* 配自己的 API Key —— Key 存在 OS 应用数据目录，不会随项目目录同步，所以不会泄露。

## 一、目录是怎么分的

每个项目根目录下有两个隐藏文件夹：

| 目录 | 内容 | 是否随云盘同步 |
|---|---|---|
| `.llm-wiki/` | 项目共享元数据：摄入缓存、审核队列、页面历史、Schema 文件等 | **应该同步** |
| `.llm-wiki-local/` | 个人私密状态：聊天对话、临时草稿 | **必须排除** |

外加内容目录：`raw/`、`wiki/`、`schema.md`、`purpose.md` 等，都是要共享的。

LLM 的 API Key 通过 `tauri-plugin-store` 写在操作系统的应用数据目录（Mac: `~/Library/Application Support/com.llm-wiki.app/`；Windows: `%APPDATA%\com.llm-wiki.app\`），**完全不在项目目录里**，所以同步项目目录绝对不会泄露你的 Key。

## 二、各云盘排除 `.llm-wiki-local/` 的方法

### iCloud Drive
在项目根目录下创建一个名为 `.llm-wiki-local.nosync` 的占位文件（或把目录名直接重命名加 `.nosync` 后缀也可以）。这是苹果给开发者的「在 iCloud 中保留但不上传」的官方约定。

> 如果你不想改名，也可以放心忽略——iCloud 会同步 `.llm-wiki-local/`，但因为各人 macOS 上的应用都会把自己的聊天写到本地副本，会产生冲突文件。看到 `conversations 2.json`、`conversations 3.json` 这类是正常现象，但建议加 `.nosync` 后缀。

### Dropbox
在项目根目录运行：
```bash
xattr -w com.dropbox.ignored 1 .llm-wiki-local
```
或在 Dropbox 桌面应用里右键文件夹 → 「在 Dropbox 上忽略」。

### OneDrive
在 OneDrive 桌面应用里右键 `.llm-wiki-local/` → 「始终保留在此设备上」并取消勾选「在此设备上释放空间」，然后再右键 → 「停止同步」。或者用更彻底的：在该目录里建一个 `.UploaderDb` 文件触发 OneDrive 的默认忽略。

### Google Drive
桌面客户端 → 偏好设置 → 「我的笔记本电脑」→ 选择项目目录 → 在「文件夹设置」里把 `.llm-wiki-local/` 排除。

### Git
如果你用 Git 协作（推荐对技术团队）：在项目根 `.gitignore` 中加：
```
.llm-wiki-local/
```
仓库默认已经包含这条。Git 模式比云盘更可控，但需要团队都会用。

## 三、团队协作建议（关键）

LLMWiki 没有内置的多人写锁。如果同一时刻有两人在不同设备上摄入文件或编辑同一个 wiki 页面，**云盘同步会保留两份冲突副本**。规避方法：

1. **约定单写主**：建立「轮值编辑」制度，由一人负责一段时间内的写入。
2. **使用项目根的 `.lockfile`**：开始工作前手动 `touch .lockfile`，结束时 `rm .lockfile`。其他人看到该文件就读模式打开。
3. **重大变更走 PR**：如果你们用 Git，wiki 修改建议在分支上完成，合并前先 `git pull`。

如果团队 ≥ 5 人或写入冲突频繁，建议升级到自建后端方案（不在 MVP 内）。

## 四、跨设备使用（个人）

最朴素的做法：
1. Mac 上创建项目，让它落在 iCloud Drive；
2. Windows 上安装 LLMWiki，OneDrive 同步同一目录（如果跨云不同步，可用 Resilio Sync）；
3. 在 Windows 上「打开项目」选这个共享路径即可。

进阶：用 `.llmwiki` 包做「快照式同步」——在 A 设备点「导出 .llmwiki」，复制到 B 设备点「导入」。适合不愿一直挂云盘的场景。

## 五、一致性校验

`.llmwiki` 包内含 `manifest.json`，所有文件的 SHA256 在导入时会自动校验。出现 `checksum_mismatches` 时，意味着包在传输过程中被改动过（少见），应在源头重新导出。

## 六、NAS 部署（群晖 / 飞牛 / QNAP / TerraMaster）

把项目放在家庭/办公 NAS 上，本质上和放云盘一样：**只要 NAS 共享在你的操作系统里挂载成一个本地路径**，应用就把它当成普通本地目录读写。下面分三类场景给出具体做法。

### 6.0 共同前置：在 OS 上把 NAS 挂上

| 客户端系统 | 通用 SMB 挂载方式 | 备注 |
|---|---|---|
| macOS | Finder → 顶部菜单「前往」→「连接服务器」→ `smb://<nas-ip>/<共享名>`，输入账号密码后点「连接」。挂载点会出现在 `/Volumes/<共享名>` | 想开机自动重连：系统设置 → 用户与群组 → 登录项 → 把 `/Volumes/<共享名>` 拖进去 |
| Windows | 文件资源管理器 → 此电脑 → 顶栏「映射网络驱动器」→ 填 `\\<nas-ip>\<共享名>` → 勾「登录时重新连接」 | 推荐勾「使用其他凭据连接」并填 NAS 账号 |
| Linux | `sudo mount -t cifs //<nas-ip>/<共享名> /mnt/wiki -o username=...,uid=$(id -u),gid=$(id -g)` | 持久化写 `/etc/fstab` |

各 NAS 厂商也有自己的客户端（推荐用厂商客户端，比裸 SMB 体验更好）：

| 厂商 | 客户端 | 工作模式 | 与 LLMWiki 配合 |
|---|---|---|---|
| **群晖 (Synology)** | Synology Drive Client | 双向同步到本地缓存目录 | 项目目录指向 Drive 同步出来的本地路径，相当于「本地 + 后台同步到 NAS」，断网仍可工作 |
| **飞牛 (fnOS)** | fnOS Drive 客户端（Win/Mac） | 双向同步 | 同上。fnOS 同时提供原生 SMB/WebDAV，可任选 |
| **QNAP** | Qsync Client | 双向同步 | 同上。或用 Qfile Sync |
| **TerraMaster** | TNAS PC / Mac 客户端 | 多为 SMB/WebDAV 挂载 | 推荐 SMB 挂 + 配合 TerraSync 备份套件 |

> 「客户端同步到本地缓存」(Synology Drive / fnOS Drive / Qsync) 比「裸 SMB 挂载」更稳：FSEvents / inotify 在网络挂载上不工作，而同步客户端写到的是真正的本地路径，应用里的「资料文件夹监控」(Source Watch) 才会触发。**追求实时摄入的话，优先选客户端同步方案**。

### 6.1 场景一：个人多设备（Mac + Win + iPad/手机看）

目标：在 Mac 和 Win 上都能打开同一个项目，读写都直接落到 NAS。

**推荐方案**：每台机器各装一份 **厂商客户端**（Drive / Qsync / fnOS Drive），同步到本地一个固定目录，例如：

- Mac: `~/SynologyDrive/llm-wiki-projects/<项目名>`
- Win: `C:\Users\<你>\SynologyDrive\llm-wiki-projects\<项目名>`

然后在每台机器的 LLMWiki 里「打开项目」选这个本地路径就行。

注意点：

1. **同一时刻只在一台设备上写**（这是所有同步方案的通用红线，见 §三）。两台同时打开同一个项目摄入文件 → 会出现 `conversations 2.json` / `xxx.md (Conflict)` 之类的冲突副本
2. **路径里不要带中文或空格**：群晖/飞牛默认共享名可能是中文，路径里有中文一般也能跑，但摄入 PDF/DOCX 时少数三方解析库对路径特殊字符敏感，建议英文路径
3. **iPad / 手机**只用厂商客户端浏览查看 wiki 文件（Markdown 直接可读）。LLMWiki 应用本身没有移动端，移动端不参与写入

### 6.2 场景二：小团队共享（多人同时访问）

目标：3-5 人共用一个 wiki，能并发查看，写入有序进行。

**步骤**：

1. **NAS 侧**：
   - 群晖：控制面板 → 共享文件夹 → 新建 `team-wiki` → 设置权限：每位成员账号 RW
   - 飞牛：fnOS 设置 → 共享文件夹 → 同上
   - QNAP：控制台 → 权限设置 → 共享文件夹 → 同上
   - 给共享文件夹**开启回收站**（误删时能救回来）+ **启用快照** (BTRFS/ZFS，群晖/QNAP 有；fnOS 基于 ZFS 也支持)：每天 1 张快照，保留 7 天
2. **客户端侧**：所有成员装厂商客户端，同步同一个 `team-wiki` 共享到本地
3. **写锁约定**（应用本身没有内置多人写锁）：
   - 简单做法：项目根的 `.lockfile` 协议（见 §三），开始工作前 `touch .lockfile`，结束 `rm .lockfile`，他人看到则只读模式打开
   - 进阶：用群晖 Calendar / 飞书日历约定「当周编辑值班」
4. **必须排除 `.llm-wiki-local/`**（每人有各自的聊天记录，强行同步会大量冲突）—— 见 §6.4 的厂商命令
5. **重大变更走 Git 模式**：把项目目录初始化成 Git 仓库 (`git init` + `.gitignore` 已默认含 `.llm-wiki-local/`)，推到 NAS 上的 Gitea/Gogs/自建 Git；同步走 git pull/push 而不是 NAS 同步

> 团队 ≥ 5 人或写入很频繁，**不要再用文件级同步**，转向自建 Git 服务（Gitea on NAS 是最轻量方案）。

### 6.3 场景三：纯本地备份（NAS 只做仓库）

目标：日常在本地 SSD 上读写，NAS 只是定时备份目的地。

这是最稳的方式（性能最好、零冲突、不依赖 NAS 在线）。做法：

1. **项目放本地**：例如 `~/Documents/llm-wiki/<项目>`
2. **用厂商备份套件定时复制到 NAS**：

| 厂商 | 推荐套件 | 配置要点 |
|---|---|---|
| 群晖 | **Hyper Backup** | 任务类型选「数据备份任务」，源选本地项目目录，目的地选 NAS 共享或云 (B2/S3)；勾「按计划运行」每天一次；启用版本保留 |
| 飞牛 | **fnOS 备份**（系统自带）或 rclone | 源 → 目的地 → 计划；保留快照 ≥ 7 天 |
| QNAP | **Hybrid Backup Sync 3 (HBS)** | 同步任务 + 计划；启用「客户端去重」省空间 |
| TerraMaster | **TerraSync** | 类似 HBS，单向同步任务即可 |

3. **统一勾选「排除以下模式」**：把 `**/.llm-wiki-local/**` 加进排除规则（备份私密聊天没意义，还占额外空间）。同时建议排除 `**/node_modules/**`、`**/.DS_Store`
4. **恢复演练**：每季度从 NAS 还原一次到临时目录确认能用 —— 没演练过的备份等于没备份

### 6.4 排除 `.llm-wiki-local/` 的具体做法（按 NAS 厂商）

不管哪个场景，都建议排除 `.llm-wiki-local/`（聊天记录是个人的，同步上去除了产生冲突和泄露个人对话没别的用）。

| 方案 | 排除方法 |
|---|---|
| **裸 SMB 挂载**（Mac/Win/Linux 通用） | 在项目根目录创建 `.llm-wiki-local/` 同级的 `.nomedia` / `.nobackup` 标记没用。**最可靠：在 NAS 侧的共享文件夹「索引排除」里加 `.llm-wiki-local/`**，或者干脆把 `.llm-wiki-local/` 用 `mv` 移到挂载点之外的本地目录，然后做软链接：`ln -s ~/local-cache/llm-wiki-local /Volumes/team-wiki/<项目>/.llm-wiki-local`（macOS/Linux）|
| **Synology Drive Client** | Drive Client → 全局设置 → 「同步规则」→ 「过滤器」→ 添加 `.llm-wiki-local` 到「不同步的文件夹名」列表 |
| **fnOS Drive 客户端** | 客户端 → 同步任务 → 编辑 → 「过滤规则」→ 添加 `.llm-wiki-local`（fnOS 0.9+ 支持，旧版本只能在 NAS 侧排除） |
| **Qsync (QNAP)** | Qsync 客户端 → 偏好设置 → 「过滤器设置」→ 添加文件夹 `.llm-wiki-local` |
| **TerraSync / TNAS Client** | 偏好设置 → 排除规则 → `.llm-wiki-local`（或在备份任务里设排除） |
| **Hyper Backup / HBS 备份任务** | 任务设置 → 「应用程序选择」/「文件过滤器」→ 排除模式 `**/.llm-wiki-local/**` |

### 6.5 NAS 部署的已知坑

| 现象 | 原因 | 处理 |
|---|---|---|
| Source Watch（资料文件夹监控）不触发 | FSEvents (Mac) / inotify (Linux) / ReadDirectoryChangesW (Win) 在 SMB/AFP/NFS 挂载上无法监听跨网事件 | 改用厂商同步客户端（同步到本地路径后再 watch），或者手动点「重新扫描」 |
| 摄入大 PDF 偶尔卡住 / 超时 | NAS 网络抖动；SMB 缓存策略 | 文件先复制到本地 → 摄入 → 再放回 NAS；或检查 NAS 的 SMB 协议版本（强制 SMB3，关闭 SMB1） |
| 多人写出现 `xxx (Conflict).md` | 同步客户端检测到双方都改了同一份 | 见 §三 的写锁约定；或转 Git 模式 |
| 路径里中文导致摄入失败 | 三方解析库（pdfium / docx / xlsx）少数对路径中非 ASCII 字符敏感 | 把共享名 / 项目名改为英文；或在本地用英文路径 + 同步到 NAS |
| `.DS_Store` / `Thumbs.db` 大量出现 | Finder / 资源管理器写的元数据 | NAS 共享设置里关闭「索引此目录」，或在共享侧设置「不创建系统文件」 |
| 突然「断流」/ 应用卡死几秒 | NAS 挂载断开但 OS 仍在挂载状态 | macOS: `sudo umount -f /Volumes/<共享名>` 后重新连接；推荐用同步客户端模式回避本问题 |
| Windows 上看不到 macOS 创建的文件 | SMB 在某些场景下大小写敏感差异（macOS 共享名出现大写 vs Windows 不区分大小写） | 共享名 / 子目录都用纯小写英文 |

### 6.6 一键检测：用应用内的「存储位置」面板

**设置 → 存储位置** 会自动检测当前项目所在路径是不是网络挂载（SMB / AFP / NFS），如果是的话：
- 显示挂载点 + 文件系统类型
- 提供「测试可写」按钮（检测连接是否健在）
- 一键复制对应厂商的「排除 .llm-wiki-local/」命令
- 如果开了 Source Watch，会提示「网络挂载下不触发，建议改用厂商同步客户端」

iCloud / Dropbox / OneDrive / Google Drive 也会在这里显示出来（基于路径前缀识别），同样给出针对性提示。

---
导出与导入入口：**设置 → 导入 / 导出**。
联网刷新入口：**设置 → 定时联网刷新**，以及打开任意 wiki 页面后，frontmatter 上方的小按钮。
存储位置检测入口：**设置 → 存储位置**。
