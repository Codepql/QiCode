import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectBackend } from "../teams/backend.js";
import { TeamManager } from "../teams/team.js";

export type ReviewRole = "reviewer" | "lead" | "junior" | "critic";

export interface CodeReviewMember {
  name: string;
  email: string;
  role: ReviewRole;
  expertise: string[];
  active: boolean;
}

export interface CodeReviewTeam {
  name: string;
  members: CodeReviewMember[];
  createdAt: string;
  lastActive: string;
}

export class CodeReviewManager {
  readonly #teams = new Map<string, CodeReviewTeam>();
  readonly #configPath: string;

  constructor(
    private readonly workDir: string,
    private readonly teamManager: TeamManager,
  ) {
    this.#configPath = join(workDir, ".QiCode", "code-review-teams.json");
    this.loadTeams();
  }

  createTeam(name: string, members: readonly Omit<CodeReviewMember, "active">[]): CodeReviewTeam {
    assertName(name);
    if (this.#teams.has(name)) throw new Error(`Review team '${name}' already exists.`);
    const now = new Date().toISOString();
    const team: CodeReviewTeam = {
      name,
      members: members.map((member) => ({ ...member, expertise: [...member.expertise], active: true })),
      createdAt: now,
      lastActive: now,
    };
    this.#teams.set(name, team);
    const runtimeTeam = this.teamManager.create(name, detectBackend());
    for (const member of team.members) runtimeTeam.addMember(member.name);
    this.saveTeams();
    return cloneTeam(team);
  }

  getTeam(name: string): CodeReviewTeam | undefined {
    const team = this.#teams.get(name);
    return team === undefined ? undefined : cloneTeam(team);
  }

  listTeams(): CodeReviewTeam[] {
    return [...this.#teams.values()].map(cloneTeam);
  }

  addMember(teamName: string, member: Omit<CodeReviewMember, "active">): void {
    const team = this.requireTeam(teamName);
    if (team.members.some((candidate) => candidate.name === member.name)) throw new Error(`Member '${member.name}' already exists.`);
    team.members.push({ ...member, expertise: [...member.expertise], active: true });
    this.teamManager.get(teamName)?.addMember(member.name);
    this.touch(team);
  }

  removeMember(teamName: string, memberName: string): void {
    const team = this.requireTeam(teamName);
    const before = team.members.length;
    team.members = team.members.filter((member) => member.name !== memberName);
    if (team.members.length === before) throw new Error(`Member '${memberName}' does not exist.`);
    this.touch(team);
  }

  activateMember(teamName: string, memberName: string): void {
    this.setMemberActive(teamName, memberName, true);
  }

  deactivateMember(teamName: string, memberName: string): void {
    this.setMemberActive(teamName, memberName, false);
  }

  async deleteTeam(name: string): Promise<void> {
    this.requireTeam(name);
    this.#teams.delete(name);
    await this.teamManager.delete(name);
    this.saveTeams();
  }

  getActiveReviewers(teamName: string): CodeReviewMember[] {
    return this.requireTeam(teamName).members
      .filter((member) => member.active && (member.role === "reviewer" || member.role === "lead"))
      .map((member) => ({ ...member, expertise: [...member.expertise] }));
  }

  getTeamSummary(teamName: string): string {
    const team = this.requireTeam(teamName);
    const active = team.members.filter((member) => member.active).length;
    return `${team.name}: ${active}/${team.members.length} active members (${team.members.map((member) => `${member.name}:${member.role}`).join(", ")})`;
  }

  private loadTeams(): void {
    if (!existsSync(this.#configPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#configPath, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (!isTeam(value)) continue;
        this.#teams.set(value.name, cloneTeam(value));
        const runtimeTeam = this.teamManager.create(value.name, detectBackend());
        for (const member of value.members) runtimeTeam.addMember(member.name);
      }
    } catch {
      // Corrupt review configuration should not prevent the application from starting.
    }
  }

  private saveTeams(): void {
    mkdirSync(join(this.workDir, ".QiCode"), { recursive: true });
    writeFileSync(this.#configPath, JSON.stringify([...this.#teams.values()], null, 2), "utf8");
  }

  private requireTeam(name: string): CodeReviewTeam {
    const team = this.#teams.get(name);
    if (team === undefined) throw new Error(`Review team '${name}' does not exist.`);
    return team;
  }

  private setMemberActive(teamName: string, memberName: string, active: boolean): void {
    const team = this.requireTeam(teamName);
    const member = team.members.find((candidate) => candidate.name === memberName);
    if (member === undefined) throw new Error(`Member '${memberName}' does not exist.`);
    member.active = active;
    this.touch(team);
  }

  private touch(team: CodeReviewTeam): void {
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }
}

export function createDefaultCodeReviewTeam(): Omit<CodeReviewMember, "active">[] {
  return [
    { name: "alice", email: "alice@example.com", role: "reviewer", expertise: ["architecture", "typescript"] },
    { name: "bob", email: "bob@example.com", role: "reviewer", expertise: ["testing", "reliability"] },
    { name: "charlie", email: "charlie@example.com", role: "critic", expertise: ["security", "edge cases"] },
  ];
}

function assertName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Review team name contains invalid characters.");
}

function cloneTeam(team: CodeReviewTeam): CodeReviewTeam {
  return { ...team, members: team.members.map((member) => ({ ...member, expertise: [...member.expertise] })) };
}

function isTeam(value: unknown): value is CodeReviewTeam {
  if (typeof value !== "object" || value === null) return false;
  const team = value as Partial<CodeReviewTeam>;
  return typeof team.name === "string"
    && Array.isArray(team.members)
    && typeof team.createdAt === "string"
    && typeof team.lastActive === "string"
    && team.members.every(isMember);
}

function isMember(value: unknown): value is CodeReviewMember {
  if (typeof value !== "object" || value === null) return false;
  const member = value as Partial<CodeReviewMember>;
  return typeof member.name === "string"
    && /^[A-Za-z0-9_-]+$/.test(member.name)
    && typeof member.email === "string"
    && (member.role === "reviewer" || member.role === "lead" || member.role === "junior" || member.role === "critic")
    && Array.isArray(member.expertise)
    && member.expertise.every((item) => typeof item === "string")
    && typeof member.active === "boolean";
}
