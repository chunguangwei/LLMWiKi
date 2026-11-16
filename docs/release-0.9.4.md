# v0.9.4 发布记录

状态：**已正式发布并核验**。发布时间：2026-11-16 11:23:40（北京时间）。GitHub 最新正式版及公开自动更新地址均为 **v0.9.4**。

## 用户变化

- 修复 Windows 文件历史写入和查询的路径分隔符不一致，兼容旧反斜杠键快照。
- 包含未发布的 v0.9.3 草稿修复：JEV 批次取消、恢复探针租约、MCP 网络依赖安全补丁。
- 完善文档索引、开发指南、检索/排障/发布运维手册和三语言 README。

## 验证

| 项目 | 结果 |
|---|---|
| 前端 mock 回归 | 210 文件、2,844 项通过 |
| MCP 测试与编译 | 25 项通过 |
| 本地 macOS Rust 串行回归 | 493 通过、0 失败、2 项原有忽略 |
| GitHub Windows Rust | 475 通过、0 失败、2 项原有忽略；两个新增迁移测试通过 |
| GitHub 三平台 CI | macOS / Windows / Linux 全部成功 |
| 类型检查与生产前端构建 | 三平台 CI 通过 |
| npm 审计 | 工具链 2 低、4 中、0 高/严重；MCP 0 |
| 版本与发布说明 | 根版本/锁文件/Tauri/Cargo 一致，发布说明生成成功 |

发布代码：`9e3b6648ea789d53a5b7e7c276ef0ef80a263b52`。

- [通过的三平台 CI](https://github.com/chunguangwei/LLMWiKi/actions/runs/43790386151)
- [v0.9.4 发布构建](https://github.com/chunguangwei/LLMWiKi/actions/runs/43791231543)

前一草稿验证与 Windows 失败原因见 [v0.9.3 记录](release-0.9.3.md)。本版本在三平台 CI 全部通过后才推送发布 tag。

## 发布产物核验

四个平台构建、浏览器扩展打包、Publish verified release 全部成功。Release 非 draft、非 prerelease，21 个附件均非空：10 个安装/更新包、9 个签名文件、latest.json 与扩展 zip。

公开 `releases/latest/download/latest.json` 返回版本 0.9.4，13 个平台/安装器条目覆盖 macOS arm64、Windows x64、Linux x64/arm64。每个 URL 指向本版本实际附件；清单签名与下载的对应 `.sig` 内容一致。扩展 zip 内 manifest 版本为 0.9.4。

这是产物、URL、版本和签名文件一致性核验，不代替每个平台上的安装/升级实测或客户端密码学验签。此前 v0.9.3 草稿未正式发布；本版是 v0.9.2 的后续正式更新。

## 限制

真实 LLM / OpenRouter / 内网 Kev 未调用；Windows/Linux 安装交互未实机验收。保留原有 2 项忽略测试、Vite 动态导入提示和前端工具链 6 项中低危依赖告警（0 高/严重），MCP 审计为 0。详见 [代码审查](code-review-2026-11-16.md)。

## 下载

使用 [v0.9.4 Release](https://github.com/chunguangwei/LLMWiKi/releases/tag/v0.9.4)，或在设置 → 关于检查更新；无需卸载或清空配置。
