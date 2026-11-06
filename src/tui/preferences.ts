import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { withFileLocksSync } from "../fs/file-access.js";

export const DEFAULT_BINDINGS = { sessions: "alt+s", models: "alt+m", tasks: "alt+t", settings: "alt+b" };
export interface UiPreferences {
  compact: boolean; toolPreview: boolean; highContrast: boolean;
  defaultMode: "default" | "acceptEdits" | "plan";
  preferredProvider?: string;
  bindings: typeof DEFAULT_BINDINGS;
}
export function defaultPreferences(): UiPreferences { return { compact: false, toolPreview: false, highContrast: false, defaultMode: "default", bindings: { ...DEFAULT_BINDINGS } }; }
export function preferencesPath(workDir: string): string { return join(workDir, ".qicode", "ui.json"); }
const ALLOWED_BINDING = /^alt\+[mstbn]$/;
export function validatePreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("偏好配置必须是对象");
  const source = value as Record<string, unknown>; const result = defaultPreferences();
  for (const key of ["compact", "toolPreview", "highContrast"] as const) {
    if (source[key] !== undefined) { if (typeof source[key] !== "boolean") throw new Error(`无效偏好：${key}`); result[key] = source[key]; }
  }
  if (source.defaultMode !== undefined) {
    if (!["default", "acceptEdits", "plan"].includes(String(source.defaultMode))) throw new Error("默认权限只允许 default、acceptEdits、plan");
    result.defaultMode = source.defaultMode as UiPreferences["defaultMode"];
  }
  if (source.preferredProvider !== undefined) {
    if (typeof source.preferredProvider !== "string" || source.preferredProvider.length > 500) throw new Error("无效首选模型");
    result.preferredProvider = source.preferredProvider;
  }
  if (source.bindings !== undefined) {
    if (!source.bindings || typeof source.bindings !== "object" || Array.isArray(source.bindings)) throw new Error("无效按键配置");
    for (const [key, chord] of Object.entries(source.bindings)) {
      if (!Object.hasOwn(DEFAULT_BINDINGS, key) || typeof chord !== "string" || !ALLOWED_BINDING.test(chord)) throw new Error("按键仅支持 Alt+M/S/T/B/N，不可覆盖编辑器保留键");
      result.bindings[key as keyof typeof DEFAULT_BINDINGS] = chord;
    }
  }
  if (new Set(Object.values(result.bindings)).size !== Object.keys(result.bindings).length) throw new Error("按键冲突：同一组合不能绑定多个动作");
  return result;
}
export function loadPreferences(workDir: string): { preferences: UiPreferences; error?: string } {
  try { return { preferences: existsSync(preferencesPath(workDir)) ? validatePreferences(JSON.parse(readFileSync(preferencesPath(workDir), "utf8"))) : defaultPreferences() }; }
  catch (error) { return { preferences: defaultPreferences(), error: error instanceof Error ? error.message : "偏好读取失败" }; }
}
export function savePreferences(workDir: string, preferences: UiPreferences): void {
  const valid = validatePreferences(preferences); const path = preferencesPath(workDir);
  mkdirSync(join(workDir, ".qicode"), { recursive: true });
  withFileLocksSync([path], () => atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n"));
}
export const providerKey = (provider: { name: string; model: string; protocol: string }): string => JSON.stringify([provider.name, provider.protocol, provider.model]);
