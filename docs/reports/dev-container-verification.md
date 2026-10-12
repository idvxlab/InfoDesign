# 开发容器验证记录

## 启动下载与模型连接修复（2026-10-09）

用户遇到 `fd not found`、下载代理 403，以及连续 `Connection error`。本轮定位到两个独立原因：

1. 开发镜像缺少 `fd`。已核对安装的 Pi 0.99.1 `dist/utils/tools-manager.js`：支持系统命令 `fd`／`fdfind`，缺少时会从 GitHub 下载。原白名单不允许该下载。
2. 原代理继承宿主 DNS，将模型域名解析为 `198.18.0.187`，落入 `private_dst` 拒绝范围。同一接口的模型列表请求也返回代理 CONNECT 403。该现象符合 Fake-IP 解析，但未读取或修改宿主代理软件配置。

修复：`deploy/Dockerfile.dev` 预装 `fd-find`；`deploy/squid.conf` 使用独立 DNS `223.5.5.5`、`1.1.1.1`。key、模型和白名单均未更换，也未放开内网网段。`scripts/check-dev-container.mjs` 增加实际调用 Pi `find` 查找 README 的离线断言。

| 检查 | 实际命令或方法 | 结果 |
| --- | --- | --- |
| 原故障复现 | 原开发容器检查 `fd`／`fdfind`，代理容器 `getent ahostsv4`；通过原代理请求配置中的 `/models` | 两个命令均不存在；DNS 返回上述地址；模型列表请求被代理 403 拒绝 |
| 独立 DNS | 临时 Squid 沿用原白名单与所有地址拒绝规则，只增加独立 DNS；使用容器已有凭据查询模型列表 | HTTP 200，包含配置的 `deepseek-v4.1-flash` |
| 镜像构建 | `bash scripts/dev-container.sh build`；更新 DNS 后单独执行 Compose `build egress` | 通过；本地日志 `.local-data/dev-container/build-fd-fix.log`、`build-egress-dns-fix.log` |
| 应用到正式环境 | `bash scripts/dev-container.sh up` | 两个正式容器重建成功，未删除数据卷 |
| 文件工具和隔离 | `bash scripts/dev-container.sh check` | 通过：Pi `find` 在禁止下载时找到根目录 README；挂载、权限、无默认路由，以及回环／内网／未授权公共域名的代理拒绝检查通过 |
| 真实 Pi 回复 | 临时代理、正式代理各执行一次下方命令；临时测试仅额外覆盖代理环境变量 | 两次均退出 0，返回 `PI_CONNECTION_OK`；共两次短模型生成，不读取或修改项目 |
| 收尾检查 | `git diff --check`、`bash -n scripts/dev-container.sh`、`sh -n deploy/dev-entrypoint.sh`、文档本地链接／代码块检查；停止临时代理后运行 `bash scripts/dev-container.sh status` | 通过；临时代理已停止并自动移除，两个正式容器正常运行 |

正式环境实际使用的验证命令（在 Mac 项目根目录执行）：

```bash
bash scripts/dev-container.sh exec env PI_OFFLINE=1 sh -c 'cd /tmp && timeout 60 pi --print --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --provider company-gateway --model deepseek-v4.1-flash --thinking off --system-prompt "This is a connection test. Reply with exactly PI_CONNECTION_OK." "Reply with exactly PI_CONNECTION_OK."'
```

此处 `PI_OFFLINE=1` 关闭 Pi 的自动下载／目录刷新，不阻止明确发起的模型请求。凭据仅从现有环境读取，没有输出 key 或完整环境，也没有保存模型会话。普通系统 `getent` 仍使用 Docker DNS；它不能代表 Squid 设置独立 DNS 后的实际解析路径。

本轮只修复开发环境。真实文本回复已验证；模型驱动的业务工具调用、编程质量、图片输入及业务系统仍未验证或实现。下方是此前各轮的历史结果，其中“未调用模型”仅描述对应轮次。

## 当前方式：项目直接挂载（2026-10-08）

已切换正式开发容器：Mac 项目直接挂载到 `/workspace`，源码实时共享；Git 元数据只读，Linux 依赖、运行数据和 Pi 用户目录使用命名卷。旧源码卷保留，未合并或覆盖用户源码，未调用模型。

| 检查 | 实际命令或方法 | 结果 |
| --- | --- | --- |
| 脚本和文档差异 | `bash -n scripts/dev-container.sh`、`sh -n deploy/dev-entrypoint.sh`、`git diff --check` | 通过 |
| 镜像与启动依赖 | `bash scripts/dev-container.sh build`；临时容器及正式容器执行入口脚本 | 构建通过；冻结锁文件的离线依赖安装通过，未使用 Mac 依赖；构建日志在 `.local-data/dev-container/build-direct-mount.log` |
| 双向文件可见 | 在 Mac 项目新建临时标记；临时容器读取、改写；Mac 核对内容；清理该标记 | 通过：两端即时可见，无导出步骤 |
| Linux 依赖隔离 | 在宿主 `node_modules` 写入唯一临时标记，断言容器同路径不可见；清理该标记 | 通过；根目录和全部五个工作区包的依赖路径均为 Docker 卷 |
| 实际挂载与权限 | 在临时容器运行检查脚本；切换后执行 `bash scripts/dev-container.sh check` | 通过：项目唯一读写绑定、Git 和模型配置只读、宿主 `.local-data` 被运行数据卷遮蔽；普通用户、只读系统、禁止提权，无个人主目录或 Docker 控制接口挂载 |
| 网络拒绝与 SDK | 同上 | 无默认外联路由；回环、内网和未允许域名被拒绝；Pi SDK 0.99.1 可导入 |
| 分支与 CLI | 临时容器运行 `git branch --show-current`、`pi --version` | 分别返回 `develop_zjt`、`0.99.1` |
| 实际切换 | 停止临时检查容器，执行 `bash scripts/dev-container.sh up` | 正式容器重新创建成功；旧 Pi 终端断开，原 `agent-home` 和旧源码卷保留 |
| 模型配置 | 正式容器内执行 Pi `ModelConfig.load`，断言网关、唯一 DeepSeek ID、密钥引用和非空凭据注入 | 通过；未输出密钥、未发起生成请求 |

切换前的源码备份为 `.local-data/dev-container/exports/export.es8gTd/source.tar.gz`。核对归档中的普通源码文件（排除 macOS 元数据）后，没有发现容器独有源码；与 Mac 的差异只有后来在 Mac 更新的 `docs/development/dev-container.md`、`docs/design/project-spec.md`、`status.md`。原 `tju-mas-dev_workspace` 卷继续保留。

源码共享允许 Pi 直接修改和删除项目中的文件。Git 元数据只读不保护未提交源码，检查脚本也不是对所有容器漏洞或 DNS 外传的完整审计。API key 仍可由容器进程读取；真实模型生成、工具调用及业务功能尚未验证。本轮未执行业务测试。

## 历史记录：独立代码副本（2026-10-07）

以下结果记录切换前的环境；其中独立源码卷与导出同步方式已由上面的直接挂载取代。

日期：2026-10-07。宿主为 M4 MacBook Air（24 GB）；Docker Desktop 4.94.0，Engine 29.8.2，Compose 5.5.1，容器为 Linux ARM64。

## 已执行

| 检查 | 命令或方法 | 结果 |
| --- | --- | --- |
| 配置语法 | `bash -n scripts/dev-container.sh`、`sh -n deploy/dev-entrypoint.sh`、`docker compose --env-file /dev/null -p tju-mas-dev -f deploy/compose.dev.yml config --quiet` | 通过 |
| 镜像构建 | `bash scripts/dev-container.sh build` | 通过；Linux 内按锁文件安装依赖；日志 `.local-data/dev-container/build.log` |
| 实际隔离 | `bash scripts/dev-container.sh check` | 通过：UID 1000、只读根文件系统、禁止提权、capabilities 清空；仅独立工作卷、用户卷和只读模型配置，无宿主主目录或 Docker 控制接口挂载 |
| 拒绝网络请求 | 同上 | 通过：无默认路由，直接连接测试网段返回不可达；代理拒绝回环、内网和未允许的公共域名 |
| 放行指定域名 | `bash scripts/dev-container.sh check-network` | 通过：独立临时代理仅放行 `registry.npmjs.org`，容器内请求公开 `/-/ping` 返回 HTTP 200；测试代理已停止并自动移除，用户白名单未修改 |
| SDK／CLI | `bash scripts/dev-container.sh check`、`bash scripts/dev-container.sh exec pi --version`、`bash scripts/dev-container.sh exec pnpm --version` | 通过：SDK 导入及 `createAgentSession` 导出，Pi 0.99.1，pnpm 11.3.0 |
| 持久化 | 在工作卷和用户卷写入标记，执行 `bash scripts/dev-container.sh up` 重新创建容器，再读取并断言原值 | 通过；没有删除数据卷 |
| 源码导出 | `bash scripts/dev-container.sh export`，随后用 Python `tarfile` 检查归档成员 | 通过；当次归档有 222 个普通源码文件，包含指南、锁文件和 `.env.example`，没有 Git 数据、依赖、运行数据或 `.env`；未覆盖 Mac 原仓库 |

导出样本位于 `.local-data/dev-container/exports/export.6Y34zW/source.tar.gz`，它是验证当时的源码快照；后续文档更新需重新导出。

调试检查脚本时，曾将命名卷误当成宿主绑定挂载、尝试通过 Docker copy 写入只读容器，并用 CommonJS 解析只有 ESM 入口的 SDK；这些检查方法已修正，保留容器原有权限限制后最终检查通过。

## 未验证与限制

- 未接收、查看或填写用户 API key；未创建 Pi 模型会话，未验证第三方接口协议、工具调用、模型质量或 token 消耗。
- 业务 API、解析、渲染、多智能体流程及其业务测试仍未实现；开发环境通过不代表业务完成。
- 拒绝检查与 Docker 路由／挂载检查不是对容器逃逸的完整安全审计；允许域名可接收数据，容器内进程可读取注入凭据，DNS 外传未专门限制。
- 没有连接 Jetson 或 PocketBase；代理拒绝内网地址的验证使用通用测试地址。
- 默认没有网页预览端口。后续增加服务或权限时，需重新验证受影响边界。
