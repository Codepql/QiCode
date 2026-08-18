import type { CodeReviewManager } from "./manager.js";

export type ReviewStatus = "pending" | "in-review" | "approved" | "rejected" | "changes-requested";
export type CommentResolution = "accepted" | "rejected" | "pending" | "resolved";
export type CriticEvaluation = "reasonable" | "unreasonable" | "partially-reasonable";

export interface CriticAssessment {
  commentId: string;
  critic: string;
  evaluation: CriticEvaluation;
  reasoning: string;
  timestamp: string;
}

export interface ReviewComment {
  id: string;
  reviewer: string;
  file?: string;
  line?: number;
  content: string;
  timestamp: string;
  resolved: boolean;
  resolution?: CommentResolution;
  authorResponse?: string;
  resolutionTimestamp?: string;
  criticAssessments: CriticAssessment[];
}

export interface ReviewRequest {
  id: string;
  title: string;
  description: string;
  author: string;
  branch: string;
  files: string[];
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  reviewers: string[];
  comments: ReviewComment[];
}

export interface FileFeedback {
  file: string;
  comments: ReviewComment[];
}

export interface CommentIssue {
  id: string;
  reviewer: string;
  content: string;
  file?: string;
  line?: number;
  resolution: CommentResolution;
}

export interface ReviewSummary {
  requestId: string;
  title: string;
  status: ReviewStatus;
  reviewers: string[];
  totalComments: number;
  accepted: number;
  rejected: number;
  pending: number;
  files: FileFeedback[];
  issues: CommentIssue[];
}

export class ReviewSession {
  readonly #requests = new Map<string, ReviewRequest>();
  readonly #requestTeams = new Map<string, string>();
  #commentCounter = 0;

  constructor(
    private readonly workDir: string,
    private readonly manager: CodeReviewManager,
  ) {
    void this.workDir;
  }

  createReviewRequest(
    teamName: string,
    title: string,
    description: string,
    author: string,
    branch: string,
    files: readonly string[],
  ): ReviewRequest {
    if (title.trim() === "" || author.trim() === "") throw new Error("title and author are required.");
    const reviewers = this.manager.getActiveReviewers(teamName).map((member) => member.name);
    if (reviewers.length === 0) throw new Error("Review team has no active reviewers.");
    const now = new Date().toISOString();
    const request: ReviewRequest = {
      id: `review-${Date.now().toString(36)}`,
      title,
      description,
      author,
      branch,
      files: [...files],
      status: "pending",
      createdAt: now,
      updatedAt: now,
      reviewers,
      comments: [],
    };
    this.#requests.set(request.id, request);
    this.#requestTeams.set(request.id, teamName);
    return cloneRequest(request);
  }

  getRequest(id: string): ReviewRequest | undefined {
    const request = this.#requests.get(id);
    return request === undefined ? undefined : cloneRequest(request);
  }

  listRequests(): ReviewRequest[] {
    return [...this.#requests.values()].map(cloneRequest);
  }

  updateRequestStatus(id: string, status: ReviewStatus): void {
    const request = this.requireRequest(id);
    request.status = status;
    request.updatedAt = now();
  }

  addComment(requestId: string, reviewer: string, content: string, file?: string, line?: number): ReviewComment {
    const request = this.requireRequest(requestId);
    if (!request.reviewers.includes(reviewer)) throw new Error(`'${reviewer}' is not assigned to this review.`);
    if (content.trim() === "") throw new Error("Comment content is required.");
    const comment: ReviewComment = {
      id: `comment-${Date.now().toString(36)}-${this.#commentCounter++}`,
      reviewer,
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      content,
      timestamp: now(),
      resolved: false,
      resolution: "pending",
      criticAssessments: [],
    };
    request.comments.push(comment);
    request.status = "in-review";
    request.updatedAt = now();
    return cloneComment(comment);
  }

  acceptComment(requestId: string, commentId: string, authorResponse?: string): void {
    this.resolveComment(requestId, commentId, "accepted", authorResponse);
  }

  rejectComment(requestId: string, commentId: string, authorResponse?: string): void {
    this.resolveComment(requestId, commentId, "rejected", authorResponse);
  }

  addCriticAssessment(
    requestId: string,
    commentId: string,
    criticName: string,
    evaluation: CriticEvaluation,
    reasoning: string,
  ): CriticAssessment {
    const request = this.requireRequest(requestId);
    const critic = this.manager.getTeam(this.#requestTeams.get(requestId) ?? "")?.members.find((member) => member.name === criticName);
    if (critic === undefined || critic.role !== "critic") throw new Error(`'${criticName}' is not a critic for this review.`);
    const comment = request.comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) throw new Error(`Comment '${commentId}' does not exist.`);
    const assessment: CriticAssessment = { commentId, critic: criticName, evaluation, reasoning, timestamp: now() };
    comment.criticAssessments.push(assessment);
    request.updatedAt = now();
    return { ...assessment };
  }

  generateFinalReport(requestId: string): ReviewSummary {
    const request = this.requireRequest(requestId);
    const files = new Map<string, ReviewComment[]>();
    for (const comment of request.comments) {
      const file = comment.file ?? "(general)";
      files.set(file, [...(files.get(file) ?? []), cloneComment(comment)]);
    }
    const accepted = request.comments.filter((comment) => comment.resolution === "accepted").length;
    const rejected = request.comments.filter((comment) => comment.resolution === "rejected").length;
    const summary: ReviewSummary = {
      requestId: request.id,
      title: request.title,
      status: request.status,
      reviewers: [...request.reviewers],
      totalComments: request.comments.length,
      accepted,
      rejected,
      pending: request.comments.length - accepted - rejected,
      files: [...files.entries()].map(([file, comments]) => ({ file, comments })),
      issues: request.comments.filter((comment) => !comment.resolved).map((comment) => ({
        id: comment.id,
        reviewer: comment.reviewer,
        content: comment.content,
        ...(comment.file === undefined ? {} : { file: comment.file }),
        ...(comment.line === undefined ? {} : { line: comment.line }),
        resolution: comment.resolution ?? "pending",
      })),
    };
    return summary;
  }

  formatFinalReport(summary: ReviewSummary): string {
    return [
      `Review: ${summary.title} (${summary.status})`,
      `Reviewers: ${summary.reviewers.join(", ")}`,
      `Comments: ${summary.totalComments} total, ${summary.accepted} accepted, ${summary.rejected} rejected, ${summary.pending} pending`,
      ...summary.files.map((file) => `- ${file.file}: ${file.comments.length} comment(s)`),
      ...(summary.issues.length === 0 ? ["No unresolved issues."] : summary.issues.map((issue) => `Open: ${issue.id} ${issue.file ?? ""} ${issue.content}`)),
    ].join("\n");
  }

  getCriticSummary(requestId: string): string {
    const request = this.requireRequest(requestId);
    const assessments = request.comments.flatMap((comment) => comment.criticAssessments);
    if (assessments.length === 0) return "No critic assessments.";
    return assessments.map((assessment) => `${assessment.critic}: ${assessment.evaluation} - ${assessment.reasoning}`).join("\n");
  }

  private resolveComment(requestId: string, commentId: string, resolution: CommentResolution, authorResponse?: string): void {
    const request = this.requireRequest(requestId);
    const comment = request.comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) throw new Error(`Comment '${commentId}' does not exist.`);
    comment.resolved = true;
    comment.resolution = resolution;
    comment.resolutionTimestamp = now();
    if (authorResponse !== undefined) comment.authorResponse = authorResponse;
    request.updatedAt = now();
  }

  private requireRequest(id: string): ReviewRequest {
    const request = this.#requests.get(id);
    if (request === undefined) throw new Error(`Review request '${id}' does not exist.`);
    return request;
  }
}

function now(): string { return new Date().toISOString(); }

function cloneRequest(request: ReviewRequest): ReviewRequest {
  return { ...request, files: [...request.files], reviewers: [...request.reviewers], comments: request.comments.map(cloneComment) };
}

function cloneComment(comment: ReviewComment): ReviewComment {
  return { ...comment, criticAssessments: comment.criticAssessments.map((assessment) => ({ ...assessment })) };
}
