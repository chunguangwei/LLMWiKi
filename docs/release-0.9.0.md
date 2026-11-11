# 0.9.0 发布记录

版本从 0.8.3 提升为 0.9.0（新增检索子系统，保留大版本、应用 identifier 和更新签名配置）。

## 用户可见变化

- **BM25 关键词检索（默认开启，零配置）**：关键词臂从"全量扫文件 + 手写加分"替换为 SQLite FTS5 BM25 倒排索引（SAG2 论文 arXiv:2610.22588 词法臂，参考 Zleap-AI/SAG-Benchmark、SAG-Wiki，MIT）。中文经 jieba 分词写入，查询与索引共用同一分词器；标题列 BM25 权重 5x；文件名词干精确匹配保持置顶。索引库在 `<project>/.llm-wiki/fts.db`，每次搜索前按 sha256 增量同步，页面删除后自动从结果消失；删除索引文件即可整体重建。
- **JEV 证据打分臂（可选）**：设置新增「JEV 证据检索」，支持 OpenRouter 官方（`typesafe/jev-1.13`）与自定义端点（应用根 / `/v1` / 完整 `/systemone`、`/decisions`），Bearer 或无鉴权；兼容快手内网 Kev-4B 自托管（model 填 `kev-latest`）。检索时对 BM25 top-10 候选做 noul 证据判定，命中作为第三路进 RRF；串行自托管服务已按并发闸 1、2 秒超时、失败回退纯 BM25 设计。API Key 进入既有加密配置备份。
- **测试连接**：`/v1` 类部署探测 `GET /v1/models`（官方健康检查，不占打分槽位并回报模型列表）；`/decisions` 端点退回一次最小 noul 往返。
- **降级链**：未配置 JEV → 纯 BM25；JEV 不可达 → 当次跳过证据臂；FTS 索引异常 → 自动跳过关键词臂，向量与图谱臂不受影响。
- `search_project` 响应契约与前端调用方不变；LanceDB 向量臂、一跳图谱臂保持原行为。API server 与 agent 工具路径暂不启用 JEV（传 None）。

## 回归证据

- Rust 全量 `cargo test --lib`：483 项通过、2 项原有忽略；新增 FTS 同步/增删/CJK 分词检索、BM25 排序（标题优先、OR 聚合、词干精确置顶）、删页后索引清理、JEV 端点解析、健康检查 URL 推导、串行降级等用例。旧的加分常量语义测试按 BM25 语义重写，未移植旧常量。
- 前端 `npm run typecheck` 通过；全量 mock：210 文件 / 2844 项通过；i18n 四语言 parity 通过（JEV 各 23 键）。
- Kev-4B 端点办公网外裸连返回网关 401（accessproxy），应用内「测试连接」为最终裁决。

真实外部 JEV 服务打分与人工桌面验收未在此轮完成；跨平台安装包由 GitHub Actions 构建。
