# WebAI Bridge

WebAI Bridge 通过独立的 Edge 浏览器连接 DeepSeek 和小米 MiMo 网页版，并在本地工作区执行文件、命令和 Git 差异检查工具。任务记录保存在 `.runtime/tasks`，支持续跑和切换模型接手。

## 环境

- Windows、macOS 或 Linux
- Node.js 20 或更高版本
- Microsoft Edge（也可在配置中指定 Chrome 或 Chromium）

## 安装

macOS/Linux：

```sh
bash setup.sh
```

脚本会安装项目依赖，并将 `webai` 命令加入 shell 的 PATH。也可以手动执行 `npm install`，再运行 `bin/webai`。

Windows：运行 `setup.bat`，或在项目目录执行 `npm.cmd install`，然后使用 `bin/webai.cmd`。

## 使用

```sh
webai                         # 在当前目录进入交互模式
webai -C /work/project        # 指定工作区
webai --backend mimo          # 选择 MiMo
webai ci "修复测试"           # 执行任务
webai ci --continue           # 续跑当前工作区最近的未完成任务
webai ci --resume <任务ID>    # 续跑指定任务
webai ci --resume <任务ID> --backend mimo  # 切换模型接手
webai status                  # 查看连接状态
webai probe                   # 检查网页页面结构
webai list                    # 列出任务
webai show <任务ID>           # 查看任务结果
```

Windows 下将 `webai` 替换为 `webai.cmd`。交互模式支持 `/model` 切换后端、`/continue` 续跑、`/tasks` 查看任务和 `/exit` 退出。高风险命令会请求确认；使用 `--yes` 时由另一个可用后端审批，审批后端不可用或未配置时会拒绝操作。

## 工作区与限制

文件工具只能访问工作区内的路径。命令需符合 `config/.agent-policy.json` 中的白名单；安装依赖、提交代码以及 Node.js、Python 命令需要确认，解释器内联代码会被拒绝。

首次连接时会打开专用浏览器窗口，需要在其中登录所选网页模型。网页改版或服务限制可能导致连接与回复检测失效，可用 `probe` 查看页面情况。
