# Design Agent 首次真实试跑

本地日期 2026-10-11（容器 UTC 日志已为 2026-10-12）。用户配置网关及 `deepseek-v4.1-flash` 后，授权用合成资料试跑一次。

## 结果

真实 Pi SDK 发起 3 次请求，HTTP 状态均为 200；模型先读组件目录，再成功读取 4 条合成事实。最终响应的停止原因是 `length`，运行时返回 `failed / output_truncated`。没有返回或发布 InformationPlan/PageSpec，语义质量未验收。用时 39,166 ms，工具调用 5 次且全部成功，会话资源已清理。

SDK 汇总用量为 input 10,738、cacheRead 19,456、output 1,992、cacheWrite 0；三次响应均报告用量。供应商实际账单未知，不能据此声称免费或准确人民币费用。

## 执行范围

- 使用既有 `designTaskFixture`：4 条纯合成事实，审核状态由测试装配设置，不代表真实上游审核通过。没有发送客户 PDF、HTML 或实际企业资料；手写参考输出未传给模型。
- Node/Pi 运行在 `infodesign-design-live` 容器；只读源码、普通用户、只读根文件系统、资源限制与内部隔离网络。独立 Squid 出口仅允许配置的网关域名 HTTPS，密钥从被 Git 忽略的 pi.env 注入，不打印。
- 上限为 180 秒、4 次模型请求、12 次工具调用、单次输出 8,192 tokens、上下文 128,000 bytes。自动修正关闭；未设置人民币硬限额（网关费率尚未核实），这些限制仅约束调用量。
- 预检命令：`docker exec infodesign-design-live node /run/design/run.mjs`；真实命令：`docker exec -e APP_RUN_LIVE_EVAL=1 infodesign-design-live node /run/design/run.mjs`。本地脚本禁止覆盖已有结果，避免无意重跑。
- 本地输入、脚本与安全诊断保存在 `.local-data/design-live/`，受 Git 忽略。运行结束已停止业务容器与出口代理；无自动重试或追加付费请求。本轮未改业务代码，未重复完整回归测试。

## 结论与下一步

接口认证、真实模型工具调用和受控事实读取已获得本次证据；完整设计生成未通过。最后一次响应仅报告 1,718 output tokens，但仍返回 length；不能直接断定是达到请求的 8,192 token 上限。需核对 SDK 实际输出参数名与网关支持项、平台限制和推理 token 计量，再决定是否调整配置。不要通过接受截断 JSON 或放宽协议绕过失败。
