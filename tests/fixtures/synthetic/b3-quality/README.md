# B3 本地质量矩阵

全部原文为本轮手工编写的虚构资料，未改写用户企业资料。三组输入共 6 份资料、6 个可读取段落、357 个原文字符；coverage 另有一个明确解析失败的空段落。当前只做离线测试，没有真实模型质量成绩。

| 案例 | 原文／参考／人工核对清单 | 重点 |
| --- | --- | --- |
| quantities | [input](quantities-input.json)／[reference](quantities-reference.json)／[rubric](quantities-rubric.json) | 小数与原始精度、万元/元、显式零值、0.8%、季度和抽样口径、收入缺失 |
| reconciliation | [input](reconciliation-input.json)／[reference](reconciliation-reference.json)／[rubric](reconciliation-rubric.json) | 同口径18/19人真冲突、全年21人与年末人数的口径差异、跨年变化、重复16人的双来源合并 |
| coverage | [input](coverage-input.json)／[reference](coverage-reference.json)／[rubric](coverage-rubric.json) | 样例外滤芯属性、完整启用日期、负温度范围、未知条件/数量、解析失败空段落 |

`*-input.json` 是提取任务可见的资料与范围；原文只经 `read_document` 返回。`*-reference.json` 是测试作者编写的参考成果，用于模拟 SSE 网关回放。`*-rubric.json` 是另存的人工语义核对清单，不是评分模型或生产判定规则。参考成果及清单不得提供给真实提取模型。

本地测试使用真实 Pi SDK，但模型响应由环回 HTTP 服务按参考成果返回。这只能证明结构表示、来源绑定、受控读取、预算、候选保存及修正路径。改变编号、顺序和合法同义属性名仍应通过，不把参考编号、字段次序或措辞当作语义正确的必要条件。

7 个有意构造的语义错误仍可能通过程序检查：错金额单位、错年份、丢抽样口径、少保留一份佐证、擅自选取冲突值、丢温度负号、把装置启用变成组织成立。测试显式保留这些边界，候选始终 pending，不将规则匹配冒充 B4 独立审查。

完整页区/图片定位目前在输入校验处拒绝，即使解析器标为 unsupported 也不自动放行。coverage 的正例使用已支持的段落定位和空文本解析失败标记；另外的负例确认页区定位在零模型调用时被拒绝。本轮没有实现图片解析，也没有放宽 B1 来源约束。

离线运行：`node --test tests/integration/evidence-quality.test.ts`，或纳入 `pnpm test:b3` / `pnpm test`。运行须在项目开发容器内。待批准的真实测试材料、限额及停止条件见 [测试方案](../../../../evals/cases/b3-quality-matrix.md)。
