export function preciseReplace(content: string, oldText: string, newText: string, all: boolean): { content: string; count: number } {
  const normalized: string[] = [];
  const offsets: number[] = [];
  for (let i = content.startsWith("\ufeff") ? 1 : 0; i < content.length; i++) {
    offsets.push(i);
    if (content[i] === "\r") { normalized.push("\n"); if (content[i + 1] === "\n") i++; }
    else normalized.push(content[i]!);
  }
  offsets.push(content.length);
  const text = normalized.join("");
  const needle = oldText.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  if (!needle) throw new Error("old_string 必须包含可匹配的正文");
  const matches: number[] = [];
  for (let start = 0; start <= text.length;) {
    const index = text.indexOf(needle, start);
    if (index < 0) break;
    matches.push(index); start = index + needle.length;
  }
  if (!matches.length) throw new Error("文件中未找到 old_string；请重新读取最新内容后精确编辑");
  if (!all && matches.length > 1) throw new Error(`old_string 在文件中找到 ${matches.length} 处。请提供更多上下文使其唯一，或将 replace_all 设为 true。`);
  let updated = content;
  for (const index of [...matches].reverse()) {
    const begin = offsets[index]!;
    const end = offsets[index + needle.length]!;
    const ending = content.slice(begin, end).match(/\r\n|\n|\r/)?.[0] ?? content.match(/\r\n|\n|\r/)?.[0] ?? "\n";
    const replacement = newText.replace(/^\ufeff/, "").replace(/\r\n?|\n/g, ending);
    updated = updated.slice(0, begin) + replacement + updated.slice(end);
  }
  return { content: updated, count: matches.length };
}

export function changeSummary(before: string, after: string): { firstChangedLine: number; diff: string } {
  const left = before.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split("\n");
  const right = after.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  if (start === left.length && start === right.length) return { firstChangedLine: 1, diff: "" };
  let oldEnd = left.length, newEnd = right.length;
  while (oldEnd > start && newEnd > start && left[oldEnd - 1] === right[newEnd - 1]) { oldEnd--; newEnd--; }
  const body = [...left.slice(start, Math.min(oldEnd, start + 40)).map((line) => `-${line}`), ...right.slice(start, Math.min(newEnd, start + 40)).map((line) => `+${line}`)].join("\n");
  return { firstChangedLine: start + 1, diff: `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@\n${body}`.slice(0, 8000) + (oldEnd - start > 40 || newEnd - start > 40 || body.length > 7950 ? "\n[变更预览已截断]" : "") };
}
