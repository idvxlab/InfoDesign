# 在隔离容器里开发

Mac 运行 Docker Desktop，Pi、工具和测试运行在 Linux ARM64 容器中。项目根目录直接挂载到容器 `/workspace`，编辑器与 Pi 修改同一份源码，无需导出同步。开发环境已可用，完整业务系统仍待实现。

## 日常使用

在 Mac 终端进入项目根目录后执行：

```bash
bash scripts/dev-container.sh up       # 启动／重新创建容器，保留依赖与 Pi 状态
bash scripts/dev-container.sh shell    # 打开容器终端
```

容器终端中的项目路径是 `/workspace`。退出终端用 `exit`；结束工作后在 Mac 执行：

```bash
bash scripts/dev-container.sh stop
```

首次安装、修改镜像配置或更新锁定依赖时，先执行 `bash scripts/dev-container.sh build`。
启动时会使用镜像内的缓存离线安装锁定依赖；缓存不足会明确报错，不自行扩大联网范围。
即使 Docker Desktop 未加入终端 PATH，脚本也可使用，无需修改 Mac 的 shell 配置。
`up` 会重新创建容器并中断正在运行的任务，应先结束 Pi 会话。

## 自己填写模型接口

配置保存在根目录 `.local-data/dev-container/`，已被 Git 忽略，不会进入镜像。初始化不会覆盖已有配置。

1. **models.json**：初始为 `{"providers":{}}`。参考 [模型配置模板](../../deploy/models.example.json)，填入真实的接口基础地址（Base URL）和模型 ID，保留 `apiKey` 中的 `${APP_MODEL_API_KEY}`。
2. **pi.env**：在 `APP_MODEL_API_KEY=` 后填写 API 密钥。此文件使用原始值格式，不加引号，不写 `export`。
3. **allowed-hosts.txt**：每行一个允许访问的完整域名，如 `api.example.com`，不含 `https://`、端口或路径。删除初始的 `disabled.invalid`，只填写需要的 API 域名。

模板的 `openai-completions` 适用于 OpenAI Chat Completions 兼容接口。如果平台使用其他协议，需要按平台说明和已安装的 Pi 版本调整，不能仅凭 DeepSeek／Kimi 名称判断。这里配置的是开发 Pi CLI；业务运行层另行显式读取 `APP_MODEL_*`，不能自动沿用 CLI 配置。

当前初步选用 DeepSeek。本地配置使用第三方平台模型列表返回的 `deepseek-v4.1-flash`；此前的三个示例模型已替换。2026-10-09 已验证模型目录查询及 Pi CLI 的一次短文本回复；业务工具调用、图片输入及编程质量仍需分别验证。型号使用第三方平台的准确 ID，不直接套用 DeepSeek 官方接口的别名。

填写后，在 Mac 运行：

```bash
bash scripts/dev-container.sh up
bash scripts/dev-container.sh pi
```

进入 Pi 后，用 `/model` 选择 `company-gateway` 下的模型。更换接口、API 密钥或模型后，应重新验证连接和实际回复。

仅修改 `models.json` 时，再次打开 `/model` 即会重新读取配置，选择 `DeepSeek V4.1 Flash [company-gateway]`，可用 `Ctrl+S` 保存为新会话的默认模型。恢复旧会话可能沿用旧模型，应重新选择；仅修改模型列表无需重新创建容器。修改 `pi.env` 后则需先结束现有会话，再执行 `up` 以载入新的环境变量。

代理只允许白名单域名的 HTTPS 443 端口。若接口需要其他域名，核对平台文档后逐个添加；不要放行整个互联网。OAuth、联网搜索、下载依赖等额外功能也需要对应域名。私有／局域网 API 当前会被拒绝，需要另行评估网络规则。

## 显示人民币费用估算

项目扩展 [rmb-cost](../../.pi/extensions/rmb-cost/index.js) 在 Pi 底部状态区增加人民币费用，原有 token 行保留。当前会话中的任务结束后，输入 `/reload`，即可加载新扩展；重新启动项目中的 Pi 也会发现它，不需要重建容器。输入 `/rmb-cost` 查看分类金额和计价假设。

价格保存在 [rates.json](../../.pi/extensions/rmb-cost/rates.json)，按人民币／百万 token 暂估：

| 项目 | 暂用单价 | 依据 |
| --- | --- | --- |
| 普通输入 | ¥1.92 | 用户第三方平台截图，币种暂按人民币 |
| 输出 | ¥7.68 | 同上 |
| 缓存读取 | ¥0.04 | 用户提供的参考截图高峰价，尚待第三方平台确认 |
| 缓存写入 | 未知 | 配置为 `null`；出现用量时标为待定，不默认免费 |

输入与输出价格相当于参考截图高峰价的 96%，但不能据此认定平台缓存也打 96 折，或自动套用参考平台的空闲时段价格。费率修改后执行 `/reload`。

例如用户提供的 `↑448k ↓111k R5.7M` 按上述费率约为 `¥1.94064`，状态区显示 `💰 会话≈¥1.94（暂估）`。界面显示的 token 数经过取整，实际费用估算使用已记录的精确用量。

扩展按当前费率重算当前会话的全部已加载用量记录，包括压缩前的记录。即使历史 Pi 美元费用保存为 0，也不影响人民币估算；扩展不会改写日志。这里显示的是当前会话的费用估算，不是最后一条任务的单独费用，也不代表平台实际扣款。无法归属模型的摘要／工具用量、其他模型及未知费率显示“已计部分／待定”，不把漏计项当作免费。Pi 原有 `/session` 美元字段与此估算独立。

扩展只读取当前会话内存中的用量元数据，不访问密钥、扫描会话文件或发起联网请求，不增加模型工具。该扩展用于开发 CLI；业务运行层仍需按业务要求显式限制扩展与工具。

已在容器执行 `bash scripts/dev-container.sh exec node --test tests/dev-tools/pi-rmb-cost.test.mjs`，7 项检查通过，含实际 Pi 0.99.1 扩展加载器、事件与命令注册、历史费用回算、混合模型及未知价格处理；使用合成用量，未调用模型。用户当前终端的显示需执行 `/reload` 后查看。

## 隔离范围

- Pi 容器使用普通用户、只读系统文件、禁止提权、移除 Linux capabilities；最多 4 核、8 GB 内存和 512 个进程。
- 宿主项目根目录以读写方式挂载到 `/workspace`。Pi 能直接修改和删除其中的源码；通过 Mac 上的 Git 检查差异、提交和恢复。
- `.git` 另行只读挂载：容器能查看当前分支和差异，提交、推送与切换分支在 Mac 上操作。Pi 正在修改文件时不要切换分支。没有共享个人主目录、个人 SSH 凭据或 Docker 控制接口。
- 根目录与五个工作区包的 `node_modules` 使用 Linux 命名卷，遮蔽 Mac 依赖。新增工作区包时同步增加其依赖挂载，避免在 Mac 项目中生成 Linux 依赖。
- `/workspace/.local-data` 使用独立运行数据卷，遮蔽宿主同名目录中的密钥、备份和记录；Pi 用户目录仍使用 `agent-home` 卷。项目其他共享文件对 Pi 可见，不要在普通源码目录存放无关密钥或私人资料。
- 宿主 `models.json` 单独只读提供到 Pi 用户目录；域名白名单只读提供给代理。不要在这些文件中存放不需要的内容。
- Pi 所在 Docker 网络为内部隔离网络，没有默认外联路由。外部 HTTPS 请求经过独立 Squid 代理，拒绝内网／回环／链路本地地址和未允许的域名。本地白名单已配置用户的第三方 API 域名，新成员初始化时仍默认拒绝真实外部访问。
- 没有发布宿主机端口，也没有接入 Jetson 或 PocketBase。网页预览端口后续按实际业务服务配置。
- 构建镜像需要联网安装锁定依赖；构建期间不运行 Pi 任务，不读取本机 `.env` 或运行数据。基础镜像已固定摘要，Node 为 24.11.1，pnpm 为 11.3.0，Pi SDK 为 0.99.1。
- 镜像预装 `ripgrep` 和 Debian 的 `fd-find`（命令名 `fdfind`，Pi 可识别），不依赖启动时从 GitHub 下载文件查找工具。出口代理使用独立 DNS `223.5.5.5`、`1.1.1.1`，避免继承宿主的 Fake-IP；域名白名单和目标地址拒绝规则仍生效。

注入的 API 密钥可以被容器内进程读取，允许的外部域名也可能接收文件内容。当前配置不等同于把凭据隐藏在外部代理中，也不提供对所有恶意代码和 DNS 外传的完整防护。只向环境提供任务需要的数据。

## 修改和提交代码

Pi 在 `/workspace` 修改文件后，Mac 编辑器立即可见；Mac 修改源码或拉取 Git 提交后，容器也能看到。源码只有一份，不再初始化另一套 Git 历史。

开发完成后，在 Mac 项目目录运行 `git status`、`git diff` 检查修改，再按 [协作指南](contributing.md) 提交和发起 PR。每位成员使用自己的仓库、容器和任务分支。

`bash scripts/dev-container.sh export` 仅保留为可选的源码归档工具，日常开发无需使用。它排除依赖、Git 元数据、本地运行数据和常见密钥文件，但不能识别写在普通源码中的秘密。

### 从旧副本方式切换

旧方式的 `tju-mas-dev_workspace` 卷会保留，不自动删除。切换前需核对旧副本是否有独有修改并备份；新方式不会自动用旧卷内容覆盖 Mac 项目。现有 Pi 会话须先结束，再执行 `build` 和 `up` 使用新挂载。`tju-mas-dev_agent-home` 继续保留会话与设置，恢复旧会话时应重新核对当前源码版本。

不要删除保存 Pi 状态或运行数据的卷；停止容器不等于删除这些数据。

## 检查与故障定位

```bash
bash scripts/dev-container.sh status
bash scripts/dev-container.sh check
bash scripts/dev-container.sh exec pi --version
```

`check` 实际验证权限、挂载、路由、代理拒绝行为、Pi SDK 导入及离线文件查找工具，不发起模型请求。该检查不代替协议测试、运行层测试或业务验收。
如果接口请求被拒绝，先核对接口协议、域名白名单和 API 密钥，再检查返回错误；不要把 API 密钥或完整容器环境输出贴到公开记录中。

### `fd` 下载 403，或模型持续 `Connection error`

这两类错误分别检查：

- `fd not found. Downloading...`：旧镜像缺少文件查找工具，Pi 尝试访问 GitHub，被域名白名单拒绝。更新本仓库后执行 `build`、`up`、`check`，使用预装工具；无需放行 GitHub。
- 模型域名在白名单内仍收到代理 403：检查代理的 DNS。若解析为 `198.18.x.x`／`198.19.x.x`，可能是宿主代理软件返回的 Fake-IP，被目标地址规则拒绝。当前 `deploy/squid.conf` 已设置独立 DNS；修改后需重新构建并重建容器。若本地网络仍劫持这些 DNS，可在宿主代理软件中将模型域名加入真实地址解析规则，再验证；不删除内网拒绝规则。

`up` 会中断当前 Pi 终端，先结束会话；完成后重新运行 `bash scripts/dev-container.sh pi`。具体修复和验证记录见 [开发容器验证记录](../reports/dev-container-verification.md)。

## 由 Codex 自动委派开发任务给 Pi

可以直接对 Codex 说：“把这项任务交给容器里的 Pi 实现，你负责验收。”无需手动在两个终端之间复制要求和报告。

- Codex 明确范围、验收条件及停止条件，确认没有其他 Pi 任务正在修改同一工作区，再通过 `scripts/dev-container.sh exec` 启动容器内的 Pi。
- 使用 Pi `--print --mode json` 非交互模式，指定现有 `company-gateway/deepseek-v4.1-flash`；每项任务使用独立会话目录。保留根目录开发约束，关闭此次不需要的扩展、Skills 和模板自动加载，避免继承无关资源。
- Pi 负责阅读相关代码、实现、回归测试和更新文档；Codex 只读取必要差异、测试证据与简短报告，处理环境问题并独立验收。详细事件日志保存在被 Git 忽略的 `.local-data/pi-delegation/`，不提交到仓库。
- 每轮明确超时和停止范围；同一工作区一次只安排一个写代码的 Pi 任务。日志出现错误或任务超时时，需要核对已经发生的改动，不能仅凭进程退出码宣称成功。不要自动跨阶段推进、提交或推送。
- 这会消耗第三方模型 API 用量；费用按平台账单结算。减少传入 Codex 的过程输出有助于节省 Codex 用量，具体节省比例需要对照测量。

2026-10-10 已实测 R11 自动委派：20 分钟超时上限内正常结束，Pi 24 次模型响应、33 次工具调用；修复前新增测试失败，修复后 69/69 测试和协议检查通过，Codex 独立复跑通过。尚未实现定时后台任务；后续任务由当前对话明确发起。

设计依据：[Pi 完整进程隔离](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)、[Docker 内部网络](https://docs.docker.com/compose/how-tos/networking/)、[Squid 独立 DNS 配置](https://www.squid-cache.org/Doc/config/dns_nameservers/)。

## 有预算的单次隔离委派

2026-10-10 新增 `scripts/pi-dev-budget-proxy.mjs`，将已有费用组件接到真实开发 Pi CLI 的 HTTP 请求入口。当前按用户限定，仅供一次 15 分钟／2 元任务使用，保留 0.2 元余量；编码任务不直接持有真实密钥。此项没有改造或重启原交互会话，也不是所有 Pi 会话的自动限额。

采用独立代码白名单副本、只含锁定依赖的编码镜像、内部网络及单独预算代理。任务关闭扩展、自动资源发现、会话恢复、自动重试和压缩；只提供必要源码与合成测试数据。代理先持久化费用再转发，拒绝复用已有台账。受控任务的错误、超时、额度耗尽都必须检查事件和文件差异，不能只看 CLI 退出码。

用户要求业务实现与测试代码由 Pi 编写，Codex 负责范围、必要验证和环境协调；本次 Codex 直接编码的例外仅限预算接线。此次来源包任务耗尽可用预留前被停止，没有生成业务代码。14 项预算检查及隔离环境验证已通过，详见 [任务报告](../reports/pi-budget-delegation-2026-10-10.md)。后续每个付费任务需有明确授权范围，不能自动用新台账续跑。

本日后续 10 元授权轮已加入可信任务参数 `limitMicros`，只接受 2,000,000（默认）或 10,000,000，安全余量为各自 10%；这不是全局账户额度或所有会话的自动授权。15 项预算测试通过。此次 Pi 未产出代码，输出截断及 HTTP 400 保护停止的经过见 [10 元任务报告](../reports/pi-source-bundle-attempt-2026-10-10.md)。
