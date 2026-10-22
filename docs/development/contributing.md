# 协作开发指南

本项目通过任务分支和 Pull Request（PR）协作，由管理员审查并合并到 `main`。Git 负责记录版本，GitHub 用于共享代码和审查修改。

## 第一次加入

先确认已安装 Git，并设置自己的提交身份：

```bash
git --version
git config --global user.name "你的名字"
git config --global user.email "你的GitHub邮箱"
git clone --branch snapshot/2026-10-10-multimodal-reader https://github.com/idvxlab/InfoDesign.git
cd InfoDesign
```

当前公开阶段分支为 `snapshot/2026-10-10-multimodal-reader`，尚未建立 `main`。下文 `main` 是正式协作流程示例；主分支建立前，应从已克隆的阶段分支创建自己的任务分支，不直接执行切换或拉取 `main` 的示例。

已有本地仓库就进入项目目录，无需再次克隆或执行 `git init`。克隆、推送需要仓库访问权限及 GitHub 身份验证。以下 Git 命令都在 Mac 的项目根目录运行。

阅读 [当前状态](../../status.md) 和 [设计概览](../design/overview.md)，再按 [容器开发指南](dev-container.md) 准备环境。负责实现时通读 [项目总方案](../design/project-spec.md)，按 [后端实施指南](backend-plan.md) 选择本轮阶段；编程助手须遵守根目录 [AGENTS.md](../../AGENTS.md)。

## 从任务分支开始

先运行 `git status`。如果有未提交修改，先在当前分支妥善保存，不要带着归属不明的修改切换分支。工作区干净后：

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/任务名
```

把示例分支名换成实际任务名；修复可用 `fix/任务名`，Codex 创建的分支默认用 `codex/任务名`。切回已有分支用 `git switch 分支名`，不再加 `-c`。已在正确任务分支上时无需重复创建。

## 修改、验证与提交

Mac 编辑器和容器中的 Pi 共用一份源码。Pi、SDK、工具及测试在容器内运行；Git 元数据在容器内只读，提交和推送在 Mac 完成。Pi 正在修改文件时不要切换分支。

每次修改围绕一个明确的任务展开，运行相应检查，并在 `status.md` 记录结果及限制。测试命令见 [测试说明](../../tests/README.md)；只修改文档时检查链接和差异即可。不要把占位文件当作功能完成，也不要提交密钥、企业原始资料、模型会话日志或数据库备份。

以下以文档修改为例，文件路径和提交说明应换成本次实际内容：

```bash
git status
git diff
git add docs/development/contributing.md status.md
git diff --cached
git commit -m "docs: 更新协作指南"
git push -u origin feature/任务名
```

只暂存本次需要的文件，提交前检查暂存差异（含新增文件）。提交说明可用 `feat:`、`fix:`、`docs:`；后续在同一分支提交修改后，执行 `git push`。

## 发起 PR 与合并

1. 打开 [项目仓库](https://github.com/idvxlab/InfoDesign)，点击 **Compare & pull request**。
2. 检查方向：base 为 `main`，compare 为自己的任务分支。
3. 写清改动原因、结果、验证方法和限制，检查差异后创建 PR。界面操作见 [GitHub 官方说明](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request)。
4. 等待管理员审查。需要修正时在原分支提交并推送，PR 会自动更新。

不要直接向 `main` 推送或绕过保护规则。推送任务分支后仍需创建 PR，改动才会进入审查流程。

合并后，确认本地修改已保存，再执行 `git switch main` 和 `git pull --ff-only origin main`。下一项任务从更新后的 `main` 新建分支。确认旧分支已合并且不再需要时，可用 `git branch -d 分支名` 删除本地分支；远程分支由团队按需清理。

## 常见问题

**误在 `main` 上修改或提交了怎么办？** 先停止推送，用 `git switch -c feature/任务名` 将当前工作留在新分支，再按 PR 流程处理。不用强制推送绕过主分支保护。

**任务分支落后于 `main` 怎么办？** 先提交自己的修改，再执行：

```bash
git fetch origin
git merge origin/main
```

在任务分支解决冲突，逐项暂存解决后的文件并完成合并提交，重新验证后推送。如果无法判断冲突内容，先与相关文件的维护者核对。
