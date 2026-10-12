# B1 收尾：Ajv 与真正的类型检查

日期：2026-10-10。仓库：`<本地开发目录>`，分支 `initial_test_zjt`，
HEAD `678869e`。以用户原有未提交的 B0/B1、R1–R11 工作为基线；不提交或推送 Git。
本轮只完成 B1 剩余项，不进入 B2，不调用业务或开发模型。

## 实际修改

- `packages/contracts` 固定运行依赖 `ajv@8.20.0`、`ajv-formats@3.0.1`；根开发依赖固定
  `typescript@5.9.3`、`@types/node@24.10.1`。使用容器内 pnpm 11.3.0 生成锁文件，
  保留原 Pi SDK 及其传递依赖版本，没有新增供应链策略豁免。
- 以 Ajv `dist/2020.js` 替换自研关键字解释器，保持 `strict: true`、完整格式检查、同步校验。
  所有 Schema 加载后严格编译并缓存；错误仍返回可定位的结构化结果。未知关键字／格式、
  悬空引用和异步 Schema 阻止协议加载；校验不转换、补写或删除输入数据。
- 为现有输出叠加约束补等价的对象／数组类型与条件属性声明，标量扩展值改为等价 `anyOf`。
  生成类型重跑后没有变化；角色限制、候选 pending、服务层 R1–R11 和未实现协议的拒绝规则保持。
- `pnpm check:types` 改为 `tsc --noEmit`；`check:generated` 保留原生成文件一致性检查。
  根 `tsconfig.json` 覆盖协议源码、全部生成类型、测试加载器、五个协议测试文件和编译期契约正反例。
  编译期反例包括缺少必需采纳上下文、错误事实值、伪造已审状态与未实现协议。
- 新增 6 个 Ajv 行为回归：严格编译、2020-12 特性、日期时间、输入不变性、独立错误路径、异步拒绝。
- `.dockerignore` 纳入 `tsconfig.json`，确保开发镜像也能执行实际类型检查。同步 README、状态与相关说明。

## 隔离与依赖维护

先复制普通源码到独立临时目录 `/tmp/tju-mas-b1-20261010/b1-work`，不复制 Git 元数据、
依赖、运行数据、密钥或 Pi 状态。原开发容器中的 Pi 终端进程仍在运行，本轮未重启或终止该进程。
维护容器无凭据、普通用户、只读系统、移除 capabilities，无宿主端口；仅连接内部网络，
独立代理只放行 `registry.npmjs.org:443`，保留内网地址拒绝规则。原日常模型白名单未修改。

锁文件更新在该容器内完成；新增依赖安装禁用生命周期脚本。正式开发镜像构建继续使用原有
`allowBuilds` 清单。任务结束后清理临时维护容器与网络；原 Docker 卷、运行数据和 Pi 会话保持不变。
回写前逐文件校验原工作区哈希，避免覆盖并发修改；仅回写本轮增量。

## 已执行验证

| 阶段／命令 | 实际结果 |
| --- | --- |
| 原开发容器：`bash scripts/dev-container.sh exec pnpm test` | 基线 69/69，通过，退出 0 |
| 原开发容器：`bash scripts/dev-container.sh exec pnpm check:contracts` | 19 个生成文件一致；17 Schema、202 引用；9/9 正例通过、16/16 负例拒绝 |
| 维护容器：`pnpm generate:types` | 成功，生成类型内容无变化 |
| 维护容器：`pnpm check:types` | 真正执行 `tsc --noEmit`，退出 0，无类型错误 |
| 维护容器：`pnpm test` | 75/75，通过；0 失败、0 跳过，包含原 R1–R11 |
| 维护容器：`pnpm check:contracts` | 19 个生成文件一致；17 Schema 严格编译、202 引用；9/9 正例通过、16/16 负例拒绝 |
| `docker build -f deploy/Dockerfile.dev -t tju-mas-dev-dev:b1-20261010 .` | 新镜像构建成功，冻结锁文件安装及供应链策略校验通过 |
| 新镜像无网络、只读、普通用户，无宿主挂载：`pnpm check:types && pnpm test && pnpm check:contracts` | 独立复验全部通过，75/75，退出 0 |

迁移期间发现并修复了 CommonJS／NodeNext 类型导入和严格 Schema 编译差异，没有关闭严格检查。
维护容器最初的 Documents 挂载被 macOS 拒绝，改用允许的 `/tmp`；缓存移入容量充足的临时目录。
首次选到的过新 Node 类型触发 pnpm 发布龄规则，已改用成熟版本并从原锁文件重新生成增量，
没有放宽规则。这些问题均已在过程中解决，不计为最终验证失败。

回写收尾：24 个增量文件与已验证快照逐字节一致；未触及的基线源码保持原哈希。
原仓库 `git diff --check` 退出 0。随后从原仓库再次构建默认镜像
`tju-mas-dev-dev:latest` 与 `tju-mas-dev-dev:b1-20261010`，退出 0；
最终镜像 ID 为 `sha256:3caa3ed268980b19f93b7e65a53107930d7115527b4f3f35e49da1af9c3c5934`。
仅本轮临时容器和网络已清理，原开发／出口容器仍在运行。

## 范围与下一步

B1 本轮收尾通过。B2、真实 Pi 会话与受控工具、业务服务、真实解析、工作流、页面与部署均未执行；
没有可运行的业务 `build` 脚本，因此构建证据仅指开发镜像，不代表业务系统构建完成。
类型检查不能替代日期格式、非空集合、权限、引用关系等运行时与语义检查。

新开发镜像已构建，当前旧开发容器未切换依赖；结束现有 Pi 终端后再执行
`bash scripts/dev-container.sh up`，保留所有数据卷。下一开发阶段为 B2：独立业务 Pi 会话、
受控读资料工具、调用／权限／预算／取消及输出协议验证，不以普通聊天成功替代。

参考：[Ajv draft 2020-12](https://ajv.js.org/json-schema.html#draft-2020-12-breaking)、
[严格模式](https://ajv.js.org/strict-mode.html)、[格式插件](https://ajv.js.org/guide/formats.html)、
[TypeScript noEmit](https://www.typescriptlang.org/tsconfig/noEmit.html)。
