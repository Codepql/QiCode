/** Small allowlist, not a shell parser. Compound commands always use normal approval. */
export function readOnlyGitCommand(command: string): string | undefined {
  const text = command.trim();
  // PowerShell smart quotes and POSIX escapes can turn a positional token into an option.
  if (/[\x00-\x1f\x7f><|;&$`%!^()\\\u2018-\u201f]/.test(text)) return;
  const match = /^git\s+(diff|log|show)(?:\s+(.*))?$/.exec(text); if (!match) return;
  const verb = match[1]!; const rest = match[2] ?? "";
  const tokens = rest.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) ?? [];
  if (tokens.join(" ") !== rest.replace(/\s+/g, " ").trim()) return;
  let paths = false;
  for (const token of tokens) {
    if (token === "--") { paths = true; continue; }
    if (paths) continue;
    // Quoted options are deliberately left for ordinary approval.
    if (/^["']-/.test(token)) return;
    if (!token.startsWith("-")) continue;
    const shared = /^(?:--(?:stat|numstat|shortstat|name-only|name-status|summary|no-color|color=never|no-ext-diff|no-textconv|patch|raw)|-[pu]|-U\d+)$/;
    const diff = /^(?:--(?:cached|staged|exit-code|quiet|check|no-renames))$/;
    const history = /^(?:--(?:oneline|no-show-signature|no-notes|decorate(?:=(?:short|full|no))?|max-count=\d+)|-\d+)$/;
    if (!shared.test(token) && !(verb === "diff" ? diff : history).test(token)) return;
  }
  // Disable external diff/textconv helpers, notes and signature subprocesses.
  return `git --no-pager ${verb} --no-ext-diff --no-textconv${verb === "diff" ? "" : " --no-show-signature --no-notes"}${rest ? ` ${rest}` : ""}`;
}
