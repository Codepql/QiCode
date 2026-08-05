import { existsSync } from "node:fs";
import { join } from "node:path";

export const reminderInterval = 5;

const planModeFullReminder = `计划模式已激活。禁止修改文件，也禁止运行任何非只读工具。

%PLAN_FILE_INFO%

请按以下流程工作：
1. 第一阶段：初步理解——检查相关代码并明确目标。
2. 第二阶段：方案设计——识别受影响的调用链、接口和设计取舍。
3. 第三阶段：方案审查——对照现有代码模式检查计划和风险。
4. 第四阶段：最终计划——给出可以直接执行的实施计划。
5. 第五阶段：退出规划——存在未决问题时询问用户；开始实施前必须退出计划模式。`;

const planModeSparseReminder = `计划模式仍处于激活状态。继续进行只读调研和规划，不要编辑文件，也不要运行写入类或命令类工具。计划文件：%PLAN_PATH%`;

const planModeExitTemplate = `你已退出计划模式，普通工具权限已经恢复。%EXTRA%`;

const planModeReentryTemplate = `你已重新进入计划模式。请从现有计划 %PLAN_PATH% 继续；提出调整前，先读取并审查该计划。`;

export function getPlanPath(workDir: string): string {
  return join(workDir, ".QiCode", "plan.md");
}

export function planFileExists(planPath: string): boolean {
  return existsSync(planPath);
}

export function buildPlanModeReminder(
  planPath: string,
  planExists: boolean,
  iteration: number,
): string {
  if (iteration === 1 || (iteration - 1) % reminderInterval === 0) {
    const state = planExists
      ? "计划文件已经存在，修改计划前必须先读取它。"
      : "计划文件尚不存在。计划完成并退出计划模式后再创建它。";
    return planModeFullReminder.replace(
      "%PLAN_FILE_INFO%",
      `计划文件：${planPath}\n${state}`,
    );
  }

  return planModeSparseReminder.replace("%PLAN_PATH%", planPath);
}

export function buildPlanModeExitReminder(
  planPath: string,
  planExists: boolean,
): string {
  const extra = planExists
    ? ` 计划文件位于 ${planPath}，实施时请以它为准。`
    : "";
  return planModeExitTemplate.replace("%EXTRA%", extra);
}

export function buildPlanModeReentryReminder(
  planPath: string,
  planExists: boolean,
): string {
  return planExists
    ? planModeReentryTemplate.replace("%PLAN_PATH%", planPath)
    : "";
}
