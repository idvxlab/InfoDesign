# Pi SDK 初次安装记录（2026-10-01）

本页保留早期安装和导入检查，不是当前操作指南。现行步骤见 [容器开发](../development/dev-container.md)，最新完成情况见 [status.md](../../status.md)。

开发在用户自己的 Mac 项目目录中进行；本骨架不在该机器上创建系统服务。
用户已要求 Pi 整体在容器或虚拟机内执行：包括开发用 CLI、业务 SDK、工具和子进程，不直接在 Mac 宿主机启动。
现已提供 Docker Desktop 开发容器，直接挂载 Mac 项目源码；Linux 依赖与宿主分开存放。使用步骤见 [隔离开发指南](../development/dev-container.md)。模型凭据由用户本地填写，业务服务仍未接通。
后端在本地运行时，推理数据仍可能发送到外部模型，需明确数据使用范围。

## 已安装：Pi SDK（2026-10-01）

以下记录此前在 Mac 项目目录执行的安装与导入验证；当时没有创建 Agent 会话或运行 CLI。后续 Pi 执行及验证移入隔离环境，不能复用这些记录声称容器已验证。

- 后端运行依赖：`@earendil-works/pi-coding-agent@0.99.1`，精确版本保存在 `apps/server/package.json`，间接依赖由根目录 `pnpm-lock.yaml` 锁定。
- 环境要求：Node.js `>=22.19.0`、pnpm `11.3.0`；本机实际验证 Node.js `24.11.1`、pnpm `11.3.0`。
- 已核对发布包的类型声明与 [该版本官方 SDK 文档](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/coding-agent/docs/sdk.md)：入口为 `createAgentSession`，支持显式指定模型运行层、工具、资源加载器和会话／设置管理器。
- 此次安装只检查了依赖和接口导出；业务适配层、协议校验与真实模型任务尚未实现，未检查模型凭据。

### 安装与复现

后续运行以下命令时，应在隔离环境的项目根目录执行。首次添加依赖时使用：

```bash
pnpm --filter @tju-mas/server add --save-exact @earendil-works/pi-coding-agent@0.99.1
```

已有锁文件的协作者只需安装锁定的依赖：

```bash
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml` 明确允许三个已核对的间接依赖安装脚本：
`@google/genai@2.21.0` 输出空操作提示，`esbuild@0.28.2` 准备并校验平台二进制，
`protobufjs@7.6.6` 检查版本约定。升级这些依赖时重新检查脚本。

### 本轮实际验证

- `pnpm install --frozen-lockfile --offline`：通过，使用已下载缓存完成安装脚本。
- `pnpm --filter @tju-mas/server list --depth 0`：通过，确认后端运行依赖为 `0.99.1`；需在可访问 pnpm 缓存数据库的环境执行。
- 下列命令：通过，确认版本及主要接口可导入；不创建会话、不请求模型。

```bash
pnpm --filter @tju-mas/server exec node --input-type=module -e '
import assert from "node:assert/strict";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
assert.equal(VERSION, "0.99.1");
for (const value of [createAgentSession, SessionManager.inMemory, SettingsManager.inMemory, DefaultResourceLoader, ModelRuntime]) assert.equal(typeof value, "function");
console.log("Pi SDK " + VERSION + " import and API export checks passed; no model call.");
'
```

首次安装因 pnpm 要求确认依赖脚本而中断，核对并登记上述脚本后重试成功。
沙箱内也曾因缓存目录不同而中断；最终安装在获准访问原缓存的环境中完成。
业务测试、会话隔离、工具调用与真实模型验证均未执行，SDK 可导入不代表这些能力完成。

## 当时记录的后续工作

1. 检查 Mac 的容器环境，以及容器内的 Node.js/Bun、Python 和包管理器。
2. Pi SDK 已锁定并安装；继续核对解析、前端和测试框架的真实接口与兼容版本，再添加所需依赖。
3. 实现启动入口和健康检查，再在 package.json 中增加真正可用的脚本。
4. 完成环境变量读取与校验，填入实际配置；密钥不得进入前端或版本库。
5. 实现最小模型调用和工具任务；明确模拟模式与真实模式。

当前不能使用 `npm run dev` 或业务 Dockerfile 启动业务。`compose.dev.yml` 只启动开发容器与联网代理。
不要把资料、日志、凭据或依赖放入源码路径；本地运行数据预留在 .local-data/（已忽略）。
