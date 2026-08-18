import type { Tool, ToolResult } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import type { RunAgent, TeamManager } from "./team.js";

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required };
}

function ok(output: string): ToolResult {
  return { output, isError: false };
}

function fail(output: string): ToolResult {
  return { output, isError: true };
}

export class TeamCreateTool implements Tool {
  readonly name = "TeamCreate";
  readonly description = "Create a team for coordinating multiple agents.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(private readonly manager: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: objectSchema(
        { name: { type: "string", description: "Team name" } },
        ["name"],
      ),
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = strArg(args, "name").trim();
    if (name === "") return fail("Team name is required.");
    if (this.manager.get(name) !== undefined) return fail(`Team '${name}' already exists.`);
    this.manager.create(name);
    return ok(`Team '${name}' created.`);
  }
}

export class SpawnTeammateTool implements Tool {
  readonly name = "SpawnTeammate";
  readonly description = "Start a teammate in a team with a background task.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(
    private readonly manager: TeamManager,
    private readonly runAgent: RunAgent,
  ) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: objectSchema(
        {
          team: { type: "string", description: "Team name" },
          name: { type: "string", description: "Teammate name" },
          task: { type: "string", description: "Initial task" },
        },
        ["team", "name", "task"],
      ),
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const teamName = strArg(args, "team").trim();
    const name = strArg(args, "name").trim();
    const task = strArg(args, "task").trim();
    if (teamName === "" || name === "" || task === "") {
      return fail("team, name, and task are required.");
    }
    const team = this.manager.get(teamName) ?? this.manager.create(teamName);
    team.spawnTeammate(name, task, this.runAgent);
    return ok(`Teammate '${name}' started in team '${teamName}'. Continue working and watch for its updates.`);
  }
}

export class SendMessageTool implements Tool {
  readonly name = "SendMessage";
  readonly description = "Send a message to a teammate or the team lead.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(private readonly manager: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: objectSchema(
        {
          team: { type: "string", description: "Team name" },
          to: { type: "string", description: "Member name or lead" },
          message: { type: "string", description: "Message" },
        },
        ["team", "to", "message"],
      ),
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const teamName = strArg(args, "team").trim();
    const to = strArg(args, "to").trim();
    const message = strArg(args, "message");
    if (teamName === "" || to === "" || message.trim() === "") return fail("team, to, and message are required.");
    const team = this.manager.get(teamName);
    if (team === undefined) return fail(`Team '${teamName}' does not exist.`);
    try {
      await team.sendMessage("lead", to, message);
      return ok(`Message sent to '${to}' in team '${teamName}'.`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ListTeamsTool implements Tool {
  readonly name = "ListTeams";
  readonly description = "List teams and their teammate states.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(private readonly manager: TeamManager) {}

  schema(): Record<string, unknown> {
    return { name: this.name, description: this.description, input_schema: objectSchema({}, []) };
  }

  async execute(): Promise<ToolResult> {
    const teams = this.manager.list();
    if (teams.length === 0) return ok("No teams.");
    return ok(teams.map((team) => {
      const members = team.listMembers().map((member) => `${member.name}:${member.uiState?.status ?? "idle"}`).join(", ");
      return `${team.name} [${team.mode}]: ${members || "no members"}`;
    }).join("\n"));
  }
}

export class TeamDeleteTool implements Tool {
  readonly name = "TeamDelete";
  readonly description = "Stop all teammates and delete a team.";
  readonly category = "read" as const;
  readonly system = true;

  constructor(private readonly manager: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: objectSchema({ name: { type: "string", description: "Team name" } }, ["name"]),
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = strArg(args, "name").trim();
    if (name === "") return fail("Team name is required.");
    if (!(await this.manager.delete(name))) return fail(`Team '${name}' does not exist.`);
    return ok(`Team '${name}' deleted.`);
  }
}
