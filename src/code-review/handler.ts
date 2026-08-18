import type { CommandContext } from "../commands/commands.js";
import { createDefaultCodeReviewTeam, CodeReviewManager } from "./manager.js";
import { ReviewSession, type CriticEvaluation, type ReviewStatus } from "./session.js";

export function handleCodeReviewCommand(
  ctx: CommandContext,
  manager: CodeReviewManager,
  session: ReviewSession,
): string {
  const args = tokenize(ctx.args.trim());
  const command = args.shift()?.toLowerCase() ?? "help";
  try {
    switch (command) {
      case "create": return handleCreate(args, manager);
      case "add": return handleAddMember(args, manager);
      case "critic": return handleAddCritic(args, manager);
      case "remove": return handleRemoveMember(args, manager);
      case "list": return manager.listTeams().map((team) => manager.getTeamSummary(team.name)).join("\n") || "No review teams.";
      case "status": return manager.getTeamSummary(requireArg(args, 0, "team"));
      case "activate": manager.activateMember(requireArg(args, 0, "team"), requireArg(args, 1, "member")); return "Member activated.";
      case "deactivate": manager.deactivateMember(requireArg(args, 0, "team"), requireArg(args, 1, "member")); return "Member deactivated.";
      case "delete": void manager.deleteTeam(requireArg(args, 0, "team")); return "Review team deleted.";
      case "request": return handleCreateRequest(args, ctx, manager, session);
      case "requests": return session.listRequests().map((request) => `${request.id}: ${request.title} [${request.status}]`).join("\n") || "No review requests.";
      case "comment": return handleComment(args, session);
      case "accept": session.acceptComment(requireArg(args, 0, "request"), requireArg(args, 1, "comment"), args.slice(2).join(" ") || undefined); return "Comment accepted.";
      case "reject": session.rejectComment(requireArg(args, 0, "request"), requireArg(args, 1, "comment"), args.slice(2).join(" ") || undefined); return "Comment rejected.";
      case "approve": return updateRequest(session, args, "approved");
      case "reject-request": return updateRequest(session, args, "rejected");
      case "critic-evaluate": return handleCriticEvaluate(args, session);
      case "critic-summary": return session.getCriticSummary(requireArg(args, 0, "request"));
      case "report": {
        const summary = session.generateFinalReport(requireArg(args, 0, "request"));
        return session.formatFinalReport(summary);
      }
      case "help": return showCodeReviewHelp();
      default: return `Unknown code-review command '${command}'.\n${showCodeReviewHelp()}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function showCodeReviewHelp(): string {
  return [
    "/code-review create <team>",
    "/code-review add <team> <name> <email> <role> [expertise...]",
    "/code-review request <team> \"title\" \"description\" <author> <branch> [files...]",
    "/code-review comment <request> <reviewer> \"content\" [file] [line]",
    "/code-review accept|reject <request> <comment> [response]",
    "/code-review critic-evaluate <request> <comment> <critic> <evaluation> \"reasoning\"",
    "/code-review report <request>",
  ].join("\n");
}

function handleCreate(args: string[], manager: CodeReviewManager): string {
  const team = requireArg(args, 0, "team");
  manager.createTeam(team, createDefaultCodeReviewTeam());
  return `Review team '${team}' created.`;
}

function handleAddMember(args: string[], manager: CodeReviewManager): string {
  const team = requireArg(args, 0, "team");
  manager.addMember(team, {
    name: requireArg(args, 1, "name"),
    email: requireArg(args, 2, "email"),
    role: parseRole(requireArg(args, 3, "role")),
    expertise: args.slice(4),
  });
  return "Review member added.";
}

function handleAddCritic(args: string[], manager: CodeReviewManager): string {
  const team = requireArg(args, 0, "team");
  manager.addMember(team, {
    name: requireArg(args, 1, "name"),
    email: requireArg(args, 2, "email"),
    role: "critic",
    expertise: args.slice(3),
  });
  return "Critic added.";
}

function handleRemoveMember(args: string[], manager: CodeReviewManager): string {
  manager.removeMember(requireArg(args, 0, "team"), requireArg(args, 1, "member"));
  return "Review member removed.";
}

function handleCreateRequest(args: string[], ctx: CommandContext, manager: CodeReviewManager, session: ReviewSession): string {
  const request = session.createReviewRequest(
    requireArg(args, 0, "team"),
    requireArg(args, 1, "title"),
    requireArg(args, 2, "description"),
    args[3] ?? "current-user",
    args[4] ?? "main",
    args.slice(5),
  );
  void manager;
  void ctx;
  return `Review request '${request.id}' created.`;
}

function handleComment(args: string[], session: ReviewSession): string {
  const comment = session.addComment(requireArg(args, 0, "request"), requireArg(args, 1, "reviewer"), requireArg(args, 2, "content"), args[3], args[4] === undefined ? undefined : Number(args[4]));
  return `Comment '${comment.id}' added.`;
}

function handleCriticEvaluate(args: string[], session: ReviewSession): string {
  session.addCriticAssessment(requireArg(args, 0, "request"), requireArg(args, 1, "comment"), requireArg(args, 2, "critic"), parseEvaluation(requireArg(args, 3, "evaluation")), requireArg(args, 4, "reasoning"));
  return "Critic assessment added.";
}

function updateRequest(session: ReviewSession, args: string[], status: ReviewStatus): string {
  session.updateRequestStatus(requireArg(args, 0, "request"), status);
  return `Review request ${status}.`;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)/g;
  for (const match of input.matchAll(re)) tokens.push(match[1] ?? match[2]!);
  return tokens;
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required.`);
  return value;
}

function parseRole(value: string): "reviewer" | "lead" | "junior" | "critic" {
  if (value === "reviewer" || value === "lead" || value === "junior" || value === "critic") return value;
  throw new Error(`Invalid review role '${value}'.`);
}

function parseEvaluation(value: string): CriticEvaluation {
  if (value === "reasonable" || value === "unreasonable" || value === "partially-reasonable") return value;
  throw new Error(`Invalid critic evaluation '${value}'.`);
}
