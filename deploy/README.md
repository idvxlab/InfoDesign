# 开发容器与业务部署

按用户要求，开发用 Pi CLI、业务 Pi SDK 及其工具和子进程均在容器或虚拟机内运行，不直接在 Mac 宿主机启动。先准备隔离开发环境，业务部署后续按实现进度补齐。
`Dockerfile.dev` 与 `compose.dev.yml` 提供开发容器，`Dockerfile.egress` 与 `squid.conf` 提供域名白名单代理。用法和限制见 [隔离开发指南](../docs/development/dev-container.md)。Mac 项目直接挂载到 `/workspace`，源码修改实时共享；Linux 依赖、运行数据与 Pi 用户目录使用独立命名卷。
`Dockerfile.api`、`Dockerfile.worker`、`Dockerfile.parser` 和 `Dockerfile.preview` 仍是占位，不能启动业务系统。
代码部署与业务页面输出分别管理；正常页面任务不增加强制人工发布审批。
后续按目标平台检查依赖与镜像架构，限制生成代码及浏览器的文件、网络与凭据访问。
