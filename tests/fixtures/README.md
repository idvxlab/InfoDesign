# 测试资料

本目录只存放脱敏或合成的企业资料，并登记文件版本、预期事实、来源位置和冲突。
不得把未知数据与模型生成结论当作真实标注。

## `synthetic/`（B0/B1 合成夹具）

- `raw/company-profile.txt`、`raw/company-profile-v2.txt`：两份合成公司资料；第二份给出与第一份不同口径的研发人员数，用于制造冲突。
- `build-fixtures.mjs`：由原始文本计算指纹并生成下列 JSON；修改原始文本后需重新运行。
- `document-ir.json`、`document-ir-v2.json`：两份资料的 DocumentIR，`contentHash` 为原始文本的 SHA-256 指纹。
- `snapshot.json`：候选 EvidenceSnapshot，含 5 个实体、7 条事实、7 条证据、1 个冲突与 1 个缺失。
- `task.json`、`evidence-input.json`、`evidence-output.json`、`review-input.json`、`review-report.json`、`review-output.json`：贯穿事实阶段的正例。
- `expected-facts.json`：期望抽取结果，供后续真实模型抽取对照。
- `invalid/` 与 `cases.json`：结构层负例清单（现 16 个，含候选单条事实审查状态、非法集合类型与无效日期）；服务层负例在 `tests/integration/contracts-service.test.ts`，复核回归在 `tests/integration/contracts-regressions.test.ts`。

所有内容均为合成，不含企业真实资料、密钥或会话日志。`pnpm check:contracts` 与 `pnpm test` 会读取这些夹具。

## B3 合成提取案例

`synthetic/b3-evidence-input.json` 包含 2 份资料、6 个段落；`contentHash` 为每份资料按换行拼接原文的 SHA-256。`b3-evidence-expected.json` 是独立的预期候选：不同年份、不同统计口径、同口径数值冲突、重复来源归并、未披露收入、样例外的能源比例，以及关系和事件。另有一段提示注入测试文本。预期文件仅供程序模拟和真实验收后的核对，不送入模型提示；已有 `build-fixtures.mjs` 不生成这两份文件。

本地网关按预期文件返回候选，用于验证运行和校验机制，不能证明模型真的完成了语义提取，也不能证明提示注入防护已通过真实模型测试。

`synthetic/b3-replay/` 按两次已保存候选的结构重建全合成材料，区分重复覆盖等程序错误和待独立审查的语义问题；说明与隐私边界见 [回放说明](synthetic/b3-replay/README.md)。历史第三次失败响应缺失，新的异常 SSE 场景均为合成，不假称复现了其真实原因。
