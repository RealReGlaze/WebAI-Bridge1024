# WebAI Bridge

WebAI Bridge 通过独立的 Edge 浏览器连接 DeepSeek 和小米 MiMo 网页版，并在本地工作区内执行文件、命令和 Git 差异检查工具。任务记录保存在 `.runtime/tasks`，支持续跑和切换模型接手。

## 环境

- Windows
- Node.js 20 或更高版本
- Microsoft Edge

## 安装

```powershell
npm.cmd install
```

## 首次使用

从项目目录运行 `bin/webai.cmd`。首次连接时会打开专用 Edge 窗口，在窗口中登录所选网页模型即可。DeepSeek 和 MiMo 使用各自独立的浏览器配置目录。

## 常用命令

```powershell
webai.cmd                         # 在当前目录进入交互模式
webai.cmd -C E:\work\project     # 指定工作区
webai.cmd --backend mimo          # 选择 MiMo
webai.cmd ci "修复测试"           # 执行任务
webai.cmd ci --continue           # 续跑当前工作区最近的未完成任务
webai.cmd ci --resume <任务ID>    # 续跑指定任务
webai.cmd ci --resume <任务ID> --backend mimo  # 切换模型接手
webai.cmd status                  # 查看连接状态
webai.cmd probe                   # 检查网页页面结构
webai.cmd list                    # 列出任务
webai.cmd show <任务ID>           # 查看任务结果
```

交互模式支持 `/model` 切换后端、`/continue` 续跑、`/tasks` 查看任务和 `/exit` 退出。高风险命令会请求确认；使用 `--yes` 时由另一个可用后端审批，审批后端不可用或未配置时会拒绝该操作。

## 工作区与限制

工具只能访问工作区内的文件。命令需符合 `config/.agent-policy.json` 中的白名单；安装依赖、提交代码以及 Node.js、Python 命令需要确认，解释器内联代码会被拒绝。

网页服务需要保持登录状态。网页改版或服务限制可能导致连接与回复检测失效；可用 `probe` 查看页面情况。
