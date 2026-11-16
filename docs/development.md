# 开发与维护指南

## 工程边界

本仓库是 Tauri 2 + Rust 后端、React 19 + TypeScript 前端的桌面知识库。外层 `LLMWiKi/` 可能另有本地 Git 仓库；实际发布仓库为 `app/`，远程 `chunguangwei/LLMWiKi`。执行提交、测试和 tag 前检查 `git rev-parse --show-toplevel`。

## 代码地图

| 模块 | 入口 / 职责 |
|---|---|
| 前端启动 | `src/App.tsx`，初始化、项目切换、后台任务 |
| UI / 状态 | `src/components/`、`src/stores/`，设置、资料、编辑、聊天、审核 |
| 知识摄取 | `src/lib/ingest.ts` 及相关队列、恢复模块 |
| 搜索 | `src-tauri/src/commands/search.rs`，关键词、向量、图谱与证据融合 |
| 关键词索引 | `src-tauri/src/commands/fts_index.rs`，jieba 分词、FTS5 BM25、哈希增量写入 |
| JEV | `src-tauri/src/commands/jev.rs`，HTTP 打分、超时、熔断、恢复探针 |
| 外部 Agent | `mcp-server/` 与 Rust HTTP API；桌面打包前先构建 MCP 资源 |
| 更新 | `src/lib/updater.ts`、`src/lib/changelog.ts`、`scripts/release-notes.mjs` |
| 发布 | `.github/workflows/ci.yml`（验证）、`build.yml`（跨平台草稿发布） |

## 数据与请求流程

原始资料进入项目 `raw/sources/`，摄取后生成 `wiki/` Markdown 和引用关系。查询扫描 Wiki 页面以构建图谱上下文，同步 `.llm-wiki/fts.db`，然后融合 BM25、可选向量、桌面可选 JEV 与图谱结果。FTS 更新跳过内容哈希未变化的页面，但扫描本身仍有成本。

JEV 每个候选截取最多 2,000 字符，桌面当前最多 10 个候选。自托管每批并发 1、请求超时 2 秒、批次预算最多 6 秒；OpenRouter 每批并发 8、请求超时 8 秒、预算按轮次计算。3 个完全失败批次触发 60 秒暂停，随后单探针恢复。成功的零分响应不算失败。超时/调用取消会取消剩余客户端工作任务；远端已开始的计算不保证取消。当前并发上限不跨批次共享。

HTTP API / Agent 调用没有传 JEV 配置，因此不启用证据臂。不要把桌面配置等同于所有检索入口的行为。配置/API Key 的本地存储与加密备份参见 [运维手册](release-and-update.md#5-配置与-api-key-的安全)。

## 本地开发与验证

前置 Node 22.13+、Rust 1.88+、系统 Tauri 构建依赖与 protoc。使用锁文件安装：

```bash
npm ci
npm --prefix mcp-server ci
npm run tauri dev
```

发布前运行：

```bash
npm run test:mocks
npm run mcp:test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1
npm audit
npm --prefix mcp-server audit
```

`test:llm` 会调用真实模型，需要明确配置与可用服务；普通回归使用 `test:mocks`。Rust 的 HTTP 回归需要本机临时监听端口，受限沙箱中出现 PermissionDenied 是环境限制，不能据此判断业务失败。若测试被忽略或真实服务未验证，在发布记录列明。

## 维护约定

- 保持应用 identifier `com.llmwiki.app` 和 updater 签名密钥稳定，避免配置隔离或更新验签失效。
- 版本同时更新 package.json、package-lock.json 的两处根版本、Tauri 配置、Cargo.toml/Cargo.lock、changelog；Cargo.lock 交给 Cargo 同步。
- 修复先补可复现回归，记录失败原因和修复后结果；不要用源码字符串断言替代行为测试。
- 新功能同步用户手册、功能说明和 README；发布状态只在产物验证后标记完成。
- 上游合并、数据格式修改、真实服务策略变更单独评估，不与补丁发布混做。
