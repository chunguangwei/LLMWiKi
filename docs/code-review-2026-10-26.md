# LLMWiki 代码逻辑审查

审查基线：`ff52c45`（v0.8.0）。本次为关键数据路径的静态审查与现有测试验证，不代表全仓库已无其他问题。未修改业务逻辑。

后续处理：以下四项发现已在 0.8.1 修复，新增真实 ZIP 导入/导出 Rust 回归用例与完整刷新管线测试。下文保留原始审查记录；具体发布验证见 `docs/release-0.8.1.md`。

## 产品与架构

React / Zustand 前端编排资料解析、LLM 摄入、检索问答、审核与刷新；Tauri Rust 后端提供文件、历史、向量库、导入导出等能力。核心资产是用户持有的 Markdown Wiki，而非单次对话。摄入队列通过 IngestCommitCoordinator 保留提交顺序，通过 withProjectLock 串行化项目共享文件修改。

## 发现（按优先级）

### P1：导入包可写出目标目录

位置：`src-tauri/src/commands/package.rs:281`、`:325–330`。

ZIP 条目名称未经安全路径校验，直接交给 PathBuf::join。包含 `../outside.md`、`shared/../../outside.md` 或绝对路径的归档可以写出用户选择的目录；导入前检查仅解析 manifest，不约束条目路径。SkipExisting 仍可在目录外创建新文件，OverwriteAll 还可覆盖已有文件。现有目标目录中的符号链接也需要考虑。

建议：先完整预检归档，限制允许的根目录与文件，拒绝绝对路径、父目录、Windows 前缀与重复映射路径；验证目标祖先不经符号链接逃逸；校验通过后再写入，并使用暂存及原子替换。

### P1：后台刷新可覆盖刷新期间的已保存编辑

位置：`src/lib/refresh-runner.ts:28`、`:191–208`。

runPageRefresh 先读取整页，再等待搜索和 LLM，最后 stampResult 将最初的正文整体写回。用户或摄入流程在等待期间更新页面后，这次回写会恢复旧正文；刷新没有加入项目提交锁。刷新期间删除页面也可能被重新创建。

建议：在最终提交阶段重新读取最新文件，只修改最新 frontmatter，并与其他页面写入入口共享并发控制；采用内容版本校验以覆盖编辑器等不使用项目锁的入口。页面已删除时放弃回写。

### P1：导出到空目录后无法作为项目打开

位置：`src-tauri/src/commands/package.rs:127–158`；`src-tauri/src/commands/project.rs:350`。

导出只包含 raw、wiki、shared，遗漏根目录 schema.md 与 purpose.md。导入 UI 允许选择空目录，导入也会报告成功；但打开项目要求 schema.md 存在，因此正常导出/导入链路不能在空目录恢复一个可打开的 Wiki。即使另建项目绕过校验，自定义 schema 与 purpose 也无法还原。

建议：将必需的项目定义文件纳入包格式与校验；旧包给出明确恢复方式。增加“导出 → 空目录导入 → 打开”端到端测试。

### P2：模型请求失败被记录成页面无需更新

位置：`src/lib/refresh-runner.ts:176–182`、`:78`。

streamChat 的网络、HTTP 等错误通过 onError 回调报告后正常返回（见 llm-client.ts:283–314），但这里的回调为空。空响应和不符合协议的响应均因未匹配 STATUS=stale 而被视为 fresh，随后写入 no-change 与刷新时间，导致下一周期前不再检查。

建议：记录并传播回调错误，要求明确且有效的 STATUS=fresh/stale，异常应记录 error；调度器应按返回结果统计 errored，而非仅靠 throw。

## 验证

- `npm run typecheck`：通过。
- `npx vitest run src/lib/refresh-runner.test.ts src/lib/ingest-commit-coordinator.test.ts src/lib/ingest-queue.integration.test.ts src/lib/brand-assets.test.ts`：4 个文件、41 项测试全部通过。
- 现有 refresh-runner 测试主要覆盖配置、到期判断和字段替换，没有覆盖完整刷新流程中的并发编辑或模型错误。
- 未执行真实 LLM 调用、Rust 构建、桌面端到端导入或恶意包实际写入。本报告中问题来自代码分支与调用链核对。

## Logo 设计建议（待确认）

以“知识编织成册”为主题，将打开的书页轮廓与相互连接的页面融成单一符号，隐含 W。使用墨绿底、暖白主体与少量玉石绿，通过轮廓、负空间与克制明暗表达质感。避免现版中书页、折角、连线、空心节点叠加造成的小尺寸拥挤。

交付应包含 SVG 主图标、透明符号、单色版，重新生成桌面安装包图标、favicon 与扩展 16/48/128px 资产，并在 16/24/32px 和明暗背景检查识别度。保留现有名称与 UI 配色，不增加运行时依赖。
