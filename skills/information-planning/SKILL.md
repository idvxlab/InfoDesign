---
name: information-planning
description: "设计首次生成的内容选择与组织方法，限受控业务会话。"
---

# 信息组织 v1

1. 保持输入 audience 和 goal 原样，阅读索引中的实体、属性、缺失与冲突。
2. 读取候选事实，按读者问题选择信息；sections 顺序代表阅读顺序，不固定公司首页栏目。
3. 每个 section 写 purpose、questionIds、sourceRefs、priority、presentationIntent 和 selectionReason。所有 readerQuestions 都应被覆盖。
4. 数值、时间、单位、条件从事实引用获得；重要内容不能无理由遗漏。明确省略记录与原因，不把 pending/conflicted 事实展示为确定事实。
5. 缺少完成任务所需信息时报告 needs_information。完成的计划不能留下 openIssues。

这些步骤是设计方法，权限和事实可用性由程序校验；没有原文工具回执时不宣称原文已读。
