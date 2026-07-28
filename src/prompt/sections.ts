export function usingToolsSection(): string {
  return [
    "## 工具使用",
    "你可以调用以下工具协助完成任务：ReadFile、WriteFile、EditFile、Bash、Glob、Grep。",
    "- ReadFile：读取已知文件的内容和行号；路径不确定时，先用 Glob。",
    "- Glob：按文件名或路径模式查找文件；Grep：在文件内容中搜索关键词或正则。",
    "- WriteFile：创建或覆盖完整文件；EditFile：精确替换已有文本。修改前优先先读取文件，确认上下文。",
    "- Bash：执行当前工作目录下的命令。不要用它代替 ReadFile、Glob 或 Grep 来完成它们各自擅长的工作。",
    "- 当工具返回错误时，阅读错误内容后调整方案；不要编造工具已经成功执行的结果。",
  ].join("\n");
}

export function executingActionsSection(): string {
  return [
    "## 执行动作约束",
    "- 写文件或执行命令前，先确认目标和参数与用户请求一致。",
    "- 不执行破坏性 Git 操作，例如 git reset --hard、git clean -fd 或强制推送。",
    "- 不使用 --no-verify 绕过提交检查。",
    "- 不输出、记录或回显 API Key、密码、Token 等敏感信息。",
    "- 本阶段每次用户请求最多执行一批工具；工具结果回灌后只生成最终回答，不继续执行新的工具调用。",
  ].join("\n");
}
