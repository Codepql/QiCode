# 第 13 章 Debug：Worktree 隔离

## 先判断问题在哪一层

本章不是一个“大 Git 命令”，而是一条分层链路：

```text
ToolSearch
  -> EnterWorktreeTool.execute()
     -> createAgentWorktree()
        -> resolveGitRoot()
        -> runGit(["worktree", "add", ...])
        -> performPostCreationSetup()
           -> copySharedQicodeDefinitions()
           -> configureHooksPath()
           -> linkNodeModules()
           -> copyWorktreeIncludeFiles()
        -> readGitState()

ExitWorktreeTool.execute()
  -> hasWorktreeChanges()
  -> removeAgentWorktree()
```

看到错误时，先确定是“工具没有发现”“参数被拒绝”“Git 创建失败”“初始化 warning”，还是“退出时保留/清理判断错误”。不要一上来修改 Git 命令。

## 推荐断点与观察变量

### 1. Git 状态解析

文件：[git-state.ts](/E:/agent-code/QiCode/src/worktree/git-state.ts)

重点函数：

- `resolveGitDir(repositoryPath)`：观察 `.git` 是目录还是 `gitdir:` 指针文件。
- `readGitState(repositoryPath)`：观察 `head`、`commonGitDir`、`headSha`、`branch`。
- `isSafeGitRef(ref)`：观察危险 ref 是否在进入路径拼接前被拒绝。

正常值：

```text
gitDir       = <repo>/.git 或 worktree 的 gitdir
commonGitDir = 共享 Git 目录
branch       = main 或 worktree-demo
headSha      = 40 或 64 位十六进制字符串
```

### 2. Worktree 创建

文件：[worktree.ts](/E:/agent-code/QiCode/src/worktree/worktree.ts)

重点函数：

- `createAgentWorktree(slug, gitRoot)`：观察 `root`、`path`、`branch`。
- `resolveGitRoot(gitRoot)`：确认传入的仓库根目录真实存在。
- `runGit(cwd, args)`：确认 `args` 是数组，不能出现 shell 拼接字符串。
- `performPostCreationSetup(gitRoot, worktreePath)`：观察 warning 是否只影响对应子步骤。

正常创建应满足：

```text
path   = <repo>/.QiCode/worktrees/<slug>
branch = worktree-<slug>
```

### 3. 改动检测与退出

重点函数：

- `hasWorktreeChanges(worktreePath, baseCommit)`：先看 `git status --porcelain`，再看 HEAD 是否变化。
- `removeAgentWorktree(worktreePath, branch, gitRoot)`：观察路径边界、分支匹配和两个删除结果。
- `ExitWorktreeTool.execute()`：观察 `head_commit` 是否传入。

规则：

```text
status 非空       -> true
HEAD != baseline  -> true
任何检查异常      -> true
true              -> 保留，不删除
```

## 常见故障定位

### 工具搜索不到 Worktree

检查顺序：

1. `createToolRegistry()` 是否注册了 `EnterWorktreeTool` 和 `ExitWorktreeTool`。
2. 两个工具是否仍是 `deferred = true`。
3. `ToolSearch` 的关键词是否包含 `worktree`。
4. 是否执行了 `select:EnterWorktree,ExitWorktree`。
5. 是否在下一轮请求中观察解锁后的 schema。

注意：搜索结果不等于激活结果。只执行关键词搜索，`listToolsForModel()` 仍然不会包含这两个工具。

### 报 `slug must contain...`

这是预期的边界保护。允许：

```text
demo
fix-login
agent_1
```

拒绝：

```text
../etc
team/alice
demo.tmp
-rf
```

调用链中 `EnterWorktreeTool.execute()` 和 `createAgentWorktree()` 都会校验，前者负责用户可读错误，后者负责底层兜底。

### Worktree 创建成功，但出现 warning

这不代表 Git 创建失败。分别检查：

- `copySharedQicodeDefinitions()`：只复制 `agents`、`skills`，其他 `.QiCode` 内容不会复制。
- `configureHooksPath()`：项目没有 `.husky` 时会回退到 `.git/hooks`。
- `linkNodeModules()`：Windows 权限或目标已存在时可能 warning。
- `copyWorktreeIncludeFiles()`：危险路径、缺失文件、软链接会被跳过。

预期行为是 Worktree 仍然可用，warning 只说明某个便利初始化没有完成。

### ExitWorktree 没有清理

先看输出是“has changes”还是“cleanup warning”。如果是保留：

1. 查看 Worktree 是否有未提交文件。
2. 比较 `head_commit` 与当前 HEAD。
3. 如果读取 Git 状态失败，保留是正确结果，不要改成默认删除。

如果是 cleanup warning：

1. 检查 path 是否是 `.QiCode/worktrees/<slug>` 的一层子目录。
2. 检查 branch 是否严格是 `worktree-<slug>`。
3. 分别查看 `worktreeRemoved` 与 `branchRemoved`。

## 三个可重复实验

### 实验 A：证明搜索不会自动激活

1. 启动 QiCode。
2. 让模型调用 `ToolSearch("worktree")`。
3. 检查当前轮工具结果中有两个名字。
4. 不执行 `select`，让模型尝试调用 `EnterWorktree`。

预期：当前 Registry 仍不会把 deferred 工具放进模型 schema；模型应先选择工具。

### 实验 B：证明隔离目录不会影响主目录

1. 通过 `EnterWorktree(slug="probe")` 创建目录。
2. 在返回的绝对路径中写入 `probe.txt`。
3. 在主目录查找 `probe.txt`。
4. 调用 `ExitWorktree`，传入刚才的 `head_commit`。

预期：主目录没有 `probe.txt`；Exit 因为有改动而保留 Worktree。

### 实验 C：证明安全失败是保守的

1. 传入 `ExitWorktree` 的 path 为 `../outside`。
2. 传入一个指向外部目录的软链接路径。
3. 删除或破坏 Worktree 的 `.git` 元数据后再执行退出。

预期：三种情况都不会删除外部目录；状态异常时返回 error 或保留结果。

## 调试时不要做的事

- 不要把 `runGit()` 改成 `exec("git ${input}")`。
- 不要为了让退出成功，把 `hasWorktreeChanges()` 的异常改成 `false`。
- 不要把整个 `.QiCode` 目录复制到 Worktree。
- 不要看到 warning 就回滚整个 Worktree 创建。
- 不要用当前真实仓库反复创建测试目录；使用临时 Git fixture。
