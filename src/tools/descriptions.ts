export const BashDescription =
  "在工作目录中执行 Shell 命令。重要：有专用工具时绝不要使用 Bash；不要用它运行 cat、head、tail、sed、awk 或 echo 来代替 ReadFile、EditFile、WriteFile、Glob 或 Grep。不要执行破坏性的 Git 命令，也不要隐藏错误信息。";

export const ReadFileDescription =
  "读取带行号的文本文件。使用 offset 和 limit 只查看相关片段；路径不确定时，先使用 Glob 查找文件。";

export const WriteFileDescription =
  "创建或覆盖文本文件。父目录不存在时会自动创建。只有在目标文件内容明确时才使用。";

export const EditFileDescription =
  "替换文件中的精确文本片段。编辑前必须先用 ReadFile 读取该文件，否则工具会拒绝执行。除非明确设置 replace_all，否则目标片段必须只出现一次。";

export const GlobDescription =
  "按照 Glob 模式查找文件。用于查找文件名和路径，不用于搜索文件内部文本。结果会排除常见的依赖和构建目录。";

export const GrepDescription =
  "使用正则表达式搜索文件内容。使用 path 和 include 缩小搜索范围；结果包含文件名、行号和匹配行。";
