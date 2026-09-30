import { z } from "zod";

export const routeSchema = z.enum(["independent", "collaborative"]);
export type ModelRoute = z.infer<typeof routeSchema>;
export const routeLabel = (route: ModelRoute) => route === "independent" ? "AI独立建模" : "协同AI建模";
export const workflowActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("check"), key: z.string().min(1).max(2000), checked: z.boolean() }),
  z.object({ action: z.literal("dependency"), from: z.string().uuid(), to: z.string().uuid(), decision: z.enum(["pending", "inherit", "modify", "none"]), evidence: z.string().trim().min(1).max(4000) }),
  z.object({ action: z.literal("start"), questionId: z.string().uuid(), route: routeSchema, task: z.enum(["analysis", "model", "validation", "revision"]), text: z.string().max(12000).default("") }),
  z.object({ action: z.literal("feedback"), questionId: z.string().uuid(), route: routeSchema, text: z.string().trim().min(1).max(12000) }),
  z.object({ action: z.literal("confirm"), questionId: z.string().uuid(), route: routeSchema }),
  z.object({ action: z.literal("research"), category: z.enum(["术语口径", "题目背景", "方法与概念", "背景插图"]), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(24000), source: z.string().max(500).default("") }),
]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export interface ModelJob { runId: string; threadId: string; task: "analysis" | "model" | "validation" | "revision"; status: string; folder: string; result?: string; completedAt?: string; artifactReady?: boolean; solutionDigest?: string; reviewedDigest?: string }
export interface ModelBranch { jobs: ModelJob[]; feedback: { id: string; text: string; createdAt: string; path: string }[] }
export interface WorkflowQuestion { id: string; name: string; source: string; independent: ModelBranch; collaborative: ModelBranch; selected?: { route: ModelRoute; runId: string; confirmedAt: string; digest?: string } }
export interface WorkflowState {
  retiredQuestions?: WorkflowQuestion[];
  readingDigest?: string;
  visualJobs?: { library: "modeling" | "paper"; runId: string; threadId: string; sourcePaths: string[]; createdAt: string }[];
  version: 1; revision: number; archived: boolean;
  questions: WorkflowQuestion[];
  checks: Record<string, boolean>;
  dependencies: { from: string; to: string; decision: "pending" | "inherit" | "modify" | "none"; evidence: string; updatedAt: string }[];
  research: { id: string; category: string; title: string; body: string; source: string; createdAt: string }[];
}
const jobSchema = z.object({ runId: z.string(), threadId: z.string(), task: z.enum(["analysis", "model", "validation", "revision"]), status: z.string(), folder: z.string(), result: z.string().optional(), completedAt: z.string().optional(), artifactReady: z.boolean().optional(), solutionDigest: z.string().optional(), reviewedDigest: z.string().optional() });
const branchSchema = z.object({ jobs: z.array(jobSchema), feedback: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string(), path: z.string() })) });
const questionSchema = z.object({ id: z.string(), name: z.string().regex(/^问题\d+$/), source: z.string(), independent: branchSchema, collaborative: branchSchema, selected: z.object({ route: routeSchema, runId: z.string(), confirmedAt: z.string(), digest: z.string().optional() }).optional() });
export const workflowStateSchema: z.ZodType<WorkflowState> = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), archived: z.boolean(), questions: z.array(questionSchema), retiredQuestions: z.array(questionSchema).optional(), readingDigest: z.string().optional(),
  checks: z.record(z.boolean()),
  dependencies: z.array(z.object({ from: z.string(), to: z.string(), decision: z.enum(["pending", "inherit", "modify", "none"]), evidence: z.string(), updatedAt: z.string() })),
  research: z.array(z.object({ id: z.string(), category: z.string(), title: z.string(), body: z.string(), source: z.string(), createdAt: z.string() })),
  visualJobs: z.array(z.object({ library: z.enum(["modeling", "paper"]), runId: z.string(), threadId: z.string(), sourcePaths: z.array(z.string()), createdAt: z.string() })).optional(),
});
export const newWorkflow = (): WorkflowState => ({ version: 1, revision: 0, archived: false, questions: [], checks: {}, dependencies: [], research: [] });

// Only question headings in the published report establish question identity.
// Numbers appearing in discussions, examples, equations and tables do not.
export function reportQuestions(report: string): { name: string; source: string }[] {
  const headings = [...report.replace(/\r/g, "").matchAll(/^##\s+(.+)$/gm)];
  const seen = new Set<string>();
  return headings.flatMap((heading, index) => {
    const match = heading[1].replace(/^\d+[.、]\s*/, "").match(/^问题\s*([一二三四五六七八九十百\d]+)(?:\s|[：:、.（(]|$)/);
    if (!match) return [];
    const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const raw = match[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : chinese[raw] ?? (raw.includes("十") ? (chinese[raw.split("十")[0]] || 1) * 10 + (chinese[raw.split("十")[1]] || 0) : 0);
    if (!n || n > 99 || seen.has(String(n))) return [];
    seen.add(String(n));
    return [{ name: `问题${n}`, source: report.replace(/\r/g, "").slice(heading.index! + heading[0].length, headings[index + 1]?.index).trim() }];
  });
}
