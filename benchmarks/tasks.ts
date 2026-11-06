export interface Step { name: string; args: Record<string, unknown> }
export interface TaskFixture { id: string; prompt: string; files: Record<string, string>; steps: Step[]; verify: string; conflict?: boolean; resume?: boolean; accelerated?: boolean }
const read = (file_path: string, extra = {}): Step => ({ name: "ReadFile", args: { file_path, ...extra } });
const edit = (file_path: string, old_string: string, new_string: string): Step => ({ name: "EditFile", args: { file_path, old_string, new_string } });
const check: Step = { name: "Bash", args: { command: "$VERIFY", purpose: "verification" } };

/** Verifiers live outside the agent workspace and are never exposed as editable tools. */
export const fixtures: TaskFixture[] = [
  { id: "B01", prompt: "修复 value.cjs 的空值回退逻辑：仅 null/undefined 使用 9，保留 0、false 和空字符串。", files: { "value.cjs": "module.exports = value => value || 9;\n" },
    steps: [read("value.cjs"), edit("value.cjs", "value || 9", "value ?? 9")], verify: "const value=load('value.cjs'); for(const x of [0,false,'']) assert.equal(value(x),x); assert.equal(value(null),9); assert.equal(value(undefined),9);" },
  { id: "B02", prompt: "为 cli.cjs 实现 --name 参数，传 QiCode 时输出 Hello QiCode；不传则仍输出 Hello。", files: { "cli.cjs": "console.log('Hello');\n" },
    steps: [read("cli.cjs"), edit("cli.cjs", "console.log('Hello');", "const i=process.argv.indexOf('--name'); console.log(i<0?'Hello':'Hello '+process.argv[i+1]);")],
    verify: "const child=require('node:child_process'); assert.equal(child.execFileSync(process.execPath,['cli.cjs','--name','QiCode'],{encoding:'utf8'}).trim(),'Hello QiCode'); assert.equal(child.execFileSync(process.execPath,['cli.cjs'],{encoding:'utf8'}).trim(),'Hello');" },
  { id: "B03", prompt: "给 config.cjs 增加可配置 suffix 默认 ?，让 render.cjs 使用配置，不再硬编码感叹号。", files: { "config.cjs": "module.exports = {};\n", "render.cjs": "module.exports = name => name + '!';\n" },
    steps: [read("config.cjs"), read("render.cjs"), edit("config.cjs", "{}", "{ suffix: '?' }"), edit("render.cjs", "name + '!'", "name + require('./config.cjs').suffix")], verify: "assert.equal(load('config.cjs').suffix,'?'); assert.equal(load('render.cjs')('x'),'x?');" },
  { id: "B04", prompt: "将 calculate.cjs 修复为输入的两倍，运行验证并继续修复失败。", files: { "calculate.cjs": "module.exports = x => x + 1;\n" },
    steps: [read("calculate.cjs"), edit("calculate.cjs", "x + 1", "x * 3"), check, read("calculate.cjs"), edit("calculate.cjs", "x * 3", "x * 2")], verify: "assert.equal(load('calculate.cjs')(4),8); assert.equal(load('calculate.cjs')(0),0);" },
  { id: "B05", prompt: "定位 src 中 targetValue 的实现并修复为返回 7，忽略依赖和生成目录。", files: { "src/deep/target.cjs": "module.exports = function targetValue(){ return 100; };\n", "node_modules/noise.cjs": "targetValue dependency noise", "generated/noise.cjs": "targetValue generated noise", ".gitignore": "generated/\n" },
    steps: [{ name: "Grep", args: { pattern: "targetValue", path: "src", include: "*.cjs", context: 1 } }, read("src/deep/target.cjs"), edit("src/deep/target.cjs", "return 100", "return 7")], verify: "assert.equal(load('src/deep/target.cjs')(),7);" },
  { id: "B06", prompt: "修复 long.cjs 末尾的导出值，应返回 42；文件超过默认读取页长。", files: { "long.cjs": "// context\n".repeat(2500) + "module.exports = 41;\n" },
    steps: [read("long.cjs"), read("long.cjs", { offset: 2000 }), edit("long.cjs", "module.exports = 41", "module.exports = 42")], verify: "assert.equal(load('long.cjs'),42);" },
  { id: "B07", prompt: "修改中文.cjs 的旧值为新值，保留 UTF-8 BOM 和 CRLF。", files: { "中文.cjs": "\ufeff// 中文文件\r\nmodule.exports = '旧值';\r\n" },
    steps: [read("中文.cjs"), edit("中文.cjs", "module.exports = '旧值';\n", "module.exports = '新值';\n")], verify: "const bytes=fs.readFileSync('中文.cjs'); assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf'); const s=bytes.toString('utf8'); assert.ok(s.includes('\\r\\n')); assert.ok(!s.replaceAll('\\r\\n','').includes('\\n')); assert.equal(load('中文.cjs'),'新值');" },
  { id: "B08", prompt: "修复 slow.cjs 返回 true，并执行有输出延迟的检查。", files: { "slow.cjs": "module.exports = false;\n" }, accelerated: true,
    steps: [read("slow.cjs"), edit("slow.cjs", "false", "true")], verify: "process.stdout.write('verification started\\n'); setTimeout(()=>{assert.equal(load('slow.cjs'),true); console.log('delayed verification passed')},150);" },
  { id: "B09", prompt: "把 conflict.cjs 返回值修复为 2；如果有外部修改，重新读取并保留外部追加内容。", files: { "conflict.cjs": "module.exports = 1;\n" }, conflict: true,
    steps: [read("conflict.cjs"), edit("conflict.cjs", "module.exports = 1", "module.exports = 2"), read("conflict.cjs"), edit("conflict.cjs", "module.exports = 1", "module.exports = 2")], verify: "assert.equal(load('conflict.cjs'),2); assert.ok(fs.readFileSync('conflict.cjs','utf8').includes('external-change'));" },
  { id: "B10", prompt: "修复 resume.cjs 的返回值为 2，保存工作现场，恢复后继续验证，不重复写入。", files: { "resume.cjs": "module.exports = 1;\n" }, resume: true,
    steps: [read("resume.cjs"), edit("resume.cjs", "module.exports = 1", "module.exports = 2")], verify: "assert.equal(load('resume.cjs'),2); assert.equal(fs.readFileSync('resume.cjs','utf8').split('module.exports').length,2);" },
];
