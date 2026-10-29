# 发版、自动更新与配置安全（运维手册）

本文是 **LLMWiKi fork（`chunguangwei/LLMWiKi`）** 的发版与更新运维手册：怎么下载、怎么发新版本、自动更新原理、签名密钥与配置 Key 的安全。面向**维护者本人**。

---

## 当前发布记录

截至 2026-10-29，最新正式版本为 [v0.8.3](https://github.com/chunguangwei/LLMWiKi/releases/tag/v0.8.3)。四个平台构建及浏览器扩展打包均成功，21 个发布文件齐全，更新清单和签名文件一致性已核对。详见 [v0.8.3 发布记录](release-0.8.3.md)。

## 1. 下载最新版（终端用户视角）

**统一入口（永远是最新版）**：
👉 https://github.com/chunguangwei/LLMWiKi/releases/latest

| 平台 | 下载文件 |
|---|---|
| **macOS（Apple Silicon / M 系列）** | `LLM.Wiki_<版本>_aarch64.dmg` |
| **Windows（x64）** | `LLM.Wiki_<版本>_x64-setup.exe`（推荐）/ `_x64_en-US.msi` |
| Linux (Debian/Ubuntu) | `_amd64.deb` / `_arm64.deb` |
| Linux (通用) | `_amd64.AppImage` / `_aarch64.AppImage` |
| Linux (Fedora/RHEL) | `-1.x86_64.rpm` / `-1.aarch64.rpm` |

> ⚠️ Windows 只有 **x64（64 位 Intel/AMD）** 包，**没有 ARM64（Windows on ARM）** 版本。绝大多数 Windows PC 是 x64，按上表下载即可。

- **macOS** 首次打开提示「已损坏」（未签名 Gatekeeper 拦截）：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/LLM Wiki.app"
  ```
- **Windows** 首次运行弹「Windows 已保护你的电脑」（SmartScreen，因安装包未用商业证书签名）：
  点 **更多信息（More info）** → **仍要运行（Run anyway）** 即可。
  - `-setup.exe`（NSIS）：双击安装，普通用户推荐。
  - `_en-US.msi`（MSI）：适合企业批量部署 / 组策略；同样会触发 SmartScreen。
  - 这与 macOS 的 `xattr` 是同类问题——产物未做平台级商业代码签名（只有自动更新用的 minisign 签名），不影响功能与安全。
- **装过一次后无需再手动下载**：新版本会在 app 内提示「立即更新」，一键就地更新（见 §3）。

---

## 2. 发布一个新版本（维护者视角）

代码改完后，发版只需 4 步：

```bash
cd app

# 1. 提升版本号 —— 四处必须完全一致（下面以 0.7.0 为例，发版时替换成你的新版本号）
#    package.json:              "version": "0.7.0"
#    src-tauri/tauri.conf.json: "version": "0.7.0"
#    src-tauri/Cargo.toml:      version = "0.7.0"   ← [package] 段顶部那一行
#    src-tauri/Cargo.lock:      llm-wiki 包的 version —— 别手改，跑下面这条命令同步：
(cd src-tauri && cargo update -p llm-wiki --precise 0.7.0)
#    校验四处一致：
grep -h '"version"' package.json src-tauri/tauri.conf.json | head -2
grep '^version' src-tauri/Cargo.toml | head -1
grep -A1 'name = "llm-wiki"' src-tauri/Cargo.lock | head -2

# 2. 在 src/lib/changelog.ts 顶部 prepend 一条该版本的 entry（version + date + en/zh highlights）
#    只写用户可见的变化；纯重构 / CI / 测试不要写进来。
npm run typecheck   # changelog.ts 是 TS，顺手确认没写崩

# 3. 提交并推送（一次提交带上全部 5 个文件：上面 4 个版本文件 + changelog.ts）
git commit -am "release v0.7.0"
git push origin main

# 4. 打 tag 触发 CI（tag 名必须是 v<版本>）
git tag v0.7.0
git push origin v0.7.0
```

> ⚠️ **版本号没同步 = 自动更新失效**：`latest.json` 取的是 `tauri.conf.json` 的 version；只要它没比已安装版本高，客户端就检测不到更新（见 §3.1）。`Cargo.lock` 不同步则会在 CI 构建时被改动、留下脏 diff。所以四处务必一致、且严格大于上一版。

GitHub Actions（`.github/workflows/build.yml`）随后自动：
跨平台构建（macOS arm64 / Windows x64 / Linux x64+arm64）→ 用 updater 私钥签名 → 生成 `latest.json` → 创建 GitHub Release 并上传所有产物（dmg / exe / msi / deb / AppImage / rpm + 各自 `.sig` + `latest.json` + Chrome 扩展 zip）。

各台已安装的 app 在下次启动（或手动「检查更新」）时发现新版，一键就地更新。

### 2.1 看 CI 进度

- 工作流：https://github.com/chunguangwei/LLMWiKi/actions
- 命令行：`gh run watch <run-id> --repo chunguangwei/LLMWiKi --exit-status`

### 2.2 重发同一个版本（CI 失败后修复重跑）

```bash
# 删掉不完整的 release + tag
gh release delete v0.6.3 --repo chunguangwei/LLMWiKi --yes --cleanup-tag
git tag -d v0.6.3
git push origin :refs/tags/v0.6.3   # 确保远程 tag 也删掉
# 修完代码后重新打 tag
git tag v0.6.3 && git push origin v0.6.3
```

### 2.3 已知约束

- **仓库必须 Public**：updater 公开抓取 `latest.json`；私有仓库的 release 需要 token，而 token 不能塞进 app。
- **macOS 使用 ad-hoc 签名**：`build.yml` 设置 `APPLE_SIGNING_IDENTITY: "-"`，避免没有 Apple Developer 证书时生成无法启动的 arm64 二进制。它不是 Apple 公证，Gatekeeper 仍可能要求首次执行 `xattr -dr com.apple.quarantine "/Applications/LLM Wiki.app"`。自动更新产物另用 minisign 签名，不要把两种签名混为一谈。
- **当前不提供 Intel Mac 包**：CI 仅构建 macOS arm64。Windows 仅 x64；Linux 提供 x64 与 arm64。不要把 arm64 安装包写成支持全部架构。

### 2.4 0.7.0 发版检查

本版包含编辑可靠性、内部 Wiki 研究、DeepSeek Search & Fetch、嵌入批量/超时和快照性能改动。发布前至少执行：

```bash
npm run test:mocks
npm run mcp:test
npm run build:desktop
npm audit
(cd src-tauri && cargo check && cargo test)
```

- 确认编辑保存、退出握手、内部研究 resolved/unresolved、DeepSeek mock、嵌入超时拆分和快照失败恢复测试通过。
- `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 均为 **0.7.0**。
- tag 后检查四个平台 job、扩展 zip、安装包、`.sig` 与 `latest.json`；只有 `gh release view v0.7.0` 中产物完整且非 draft 才算发版完成。
- 真实 DeepSeek、Ollama、特定 PDF 和其他平台硬件没有覆盖到时，应在发布说明中明确，不要把 mock 验证写成真实服务或全平台验收。

---

## 3. 自动更新原理（in-place）

- 基于 `tauri-plugin-updater` + `tauri-plugin-process`。
- 更新源：`tauri.conf.json` 的 `plugins.updater.endpoints` →
  `https://github.com/chunguangwei/LLMWiKi/releases/latest/download/latest.json`
- 流程：app 后台检查 → 命中新版 → 顶部横幅 / 设置 → 关于 出现「立即更新」→ 下载签名产物 → **用内置 minisign 公钥验签** → 就地替换 app → 「重启以应用」。
- **关键点**：就地更新**不卸载不重装**，OS 应用数据目录（配置 + API Key）从不被动 → 更新永远保留设置。
- 代码：`src/lib/updater.ts`（更新逻辑）、`src/lib/app-repo.ts`（更新源 slug）、`src/components/layout/update-banner.tsx` + `settings/sections/about-section.tsx`（UI）。

### 3.1 更新检测不到新版？

- `package.json` / `tauri.conf.json` 的 `version` 必须真的比已安装版本高。
- 仓库必须 Public（否则抓不到 `latest.json`）。
- 验签失败 = app 内置公钥与签名私钥不匹配（换过密钥但 app 没重新构建）。

---

## 4. 签名密钥（⚠️ 最重要，务必备份）

自动更新的 release 产物用一对 **minisign 密钥**签名（与 Apple/Windows 代码签名无关）。

| 文件 | 用途 | 去向 |
|---|---|---|
| `~/.tauri/llmwiki_updater.key` | **私钥（绝密）** | GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` |
| `~/.tauri/llmwiki_updater.password` | 私钥密码 | GitHub Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| `~/.tauri/llmwiki_updater.key.pub` | 公钥（不敏感）| 已写入 `tauri.conf.json` 的 `plugins.updater.pubkey` |

> 🔴 **私钥 + 密码丢失 = 再也无法签新版本，所有端的自动更新永久失效**（验签不过）。
> 立刻把 `~/.tauri/llmwiki_updater.key` 和 `.password` 复制到密码管理器 / 离线备份。

两个 secret 已配置在 `chunguangwei/LLMWiKi`。换电脑或重建密钥时需要重新设置：
```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo chunguangwei/LLMWiKi < ~/.tauri/llmwiki_updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo chunguangwei/LLMWiKi --body "$(cat ~/.tauri/llmwiki_updater.password)"
```

重新生成密钥对（仅当私钥确实丢失；旧版本将无法再更新到新版，用户需手动重装一次）：
```bash
npx tauri signer generate -w ~/.tauri/llmwiki_updater.key -p "<新密码>" -f
# 然后把新公钥写进 tauri.conf.json 的 plugins.updater.pubkey，重新配两个 secret，重新发版
```

---

## 5. 配置与 API Key 的安全

### 5.1 配置存哪

所有配置（LLM/provider/嵌入/多模态/搜索 Key 等）都在一个文件：
```
macOS:   ~/Library/Application Support/com.llmwiki.app/app-state.json
Windows: %APPDATA%\com.llmwiki.app\app-state.json
Linux:   ~/.config/com.llmwiki.app/app-state.json
```

### 5.2 identifier 锁定

bundle identifier 锁死在 **`com.llmwiki.app`**（自 0.4.10）。它决定上面的配置目录路径 **和** 自动备份的钥匙串服务名。**永不更改**——改了会孤立所有用户的配置和解密密钥。代码 `src-tauri/src/lib.rs` 顶部有注释警告。

### 5.3 加密配置备份（设置 → 配置备份）

- **导出 / 导入（换机器迁移）**：设口令 → 导出加密文件 `.llmwiki-config`（Argon2id + AES-256-GCM）；新机输同口令导入。口令是唯一解钥，**app 二进制里不含任何密钥，反编译拿不到明文**。
- **启动自动备份（同机重装恢复）**：每次启动把配置加密备份到 `~/Documents/LLMWiki/config-backup.enc`（密钥存系统钥匙串）；全新安装时自动解密恢复，无需口令。
- 代码：`src-tauri/src/commands/config_crypto.rs`（口令加密）、`config_backup.rs`（钥匙串自动备份）。

### 5.4 别用深度卸载工具

AppCleaner 等会连带删掉 `~/Library/Application Support/com.llmwiki.app/`，丢失配置。就地更新本来就不需要卸载；真要卸载，先在 **设置 → 配置备份 → 导出** 备一份。即便误删，自动备份（5.3）通常也能在重装后恢复。

---

## 6. 相关文档

- [`features.md §6`](features.md#6-自己-github-自动更新就地更新--加密配置备份) — 自动更新 + 加密备份的功能说明
- [`getting-started.md §1.5.4`](getting-started.md#154-打包命令与产物位置) — 打包命令与产物路径
- [`user-manual.md §5.5`](user-manual.md#55-自动更新就地-加密配置备份) — 终端用户操作步骤
- [`UPSTREAM.md`](../UPSTREAM.md) — fork 来源、与 upstream 同步流程
