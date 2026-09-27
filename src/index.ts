import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Judge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cfgExtensionHandlersToolCallTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";

export interface Config {
  debug: boolean;
  autoSuggest: boolean;
  checkCalls: boolean;
  threshold: number;
  timeoutMs: number;
}

const defaults: Config = { debug: true, autoSuggest: false, checkCalls: false, threshold: 0.65, timeoutMs: 10000 };
const batchSize = 16;

export interface ToolCandidate {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ScoredTool {
  name: string;
  description: string;
  schema?: string;
  active: boolean;
  status: "accepted" | "rejected" | "unjudged";
  score?: number;
}

export interface ToolReport {
  results: ScoredTool[];
  models: string[];
  usage?: { input: number; output: number; cost: number };
  elapsedMs: number;
  error?: string;
}


function schemaText(parameters: unknown): string | undefined {
  try {
    const schema = parameters && (typeof parameters === "object" || typeof parameters === "function")
      && "toJsonSchema" in parameters && typeof parameters.toJsonSchema === "function"
      ? parameters.toJsonSchema() : parameters;
    return JSON.stringify(schema);
  } catch {
    return undefined;
  }
}

function settleOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(signal.reason ?? new Error("Judge aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  work.then(
    value => { signal.removeEventListener("abort", onAbort); resolve(value); },
    cause => { signal.removeEventListener("abort", onAbort); reject(cause); },
  );
  return promise;
}

export async function findTools(
  task: string, tools: readonly ToolCandidate[], active: ReadonlySet<string>,
  judge: Judge, threshold: number, timeoutMs: number, externalSignal?: AbortSignal,
): Promise<ToolReport> {
  const started = Date.now();
  const results: ScoredTool[] = tools.map(tool => ({
    name: tool.name, description: tool.description,
    active: active.has(tool.name), status: "unjudged",
  }));
  const models: string[] = [];
  let usage: ToolReport["usage"];
  let error: string | undefined;
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  for (let offset = 0; offset < results.length; offset += batchSize) {
    const batch = results.slice(offset, offset + batchSize);
    const questions = Object.fromEntries(batch.map((_, index) => [
      `tool_${index}`, { type: "noul" as const, instructions: `Is tool_${index} relevant to completing the user's task? Answer yes only if its described capability is useful; do not execute it.` },
    ]));
    try {
      if (signal.aborted) throw signal.reason;
      const response = await settleOnAbort(judge.judge({
        state: JSON.stringify({ task, tools: batch.map((candidate, index) => ({
          id: `tool_${index}`, name: candidate.name, description: candidate.description, active: candidate.active,
        })) }),
        questions,
      }, { signal }), signal);
      const answers: unknown = response.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)
        || Object.keys(answers).length !== batch.length
        || typeof response.provider !== "string" || !response.provider
        || typeof response.model !== "string" || !response.model) {
        throw new Error("Judge returned malformed answer IDs or model");
      }
      // Validate entire batch before applying any score; missing/extra IDs never become zero.
      const indexed = answers as Record<string, unknown>;
      const scores = batch.map((_, index) => {
        const answer = indexed[`tool_${index}`];
        if (!answer || typeof answer !== "object" || Array.isArray(answer)
          || !("type" in answer) || answer.type !== "noul"
          || !("noul" in answer) || typeof answer.noul !== "number"
          || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          throw new Error(`Judge returned invalid score for tool_${index}`);
        }
        return answer.noul;
      });
      scores.forEach((score, index) => {
        batch[index].score = score;
        batch[index].status = score >= threshold ? "accepted" : "rejected";
        if (score >= threshold) batch[index].schema = schemaText(tools[offset + index].parameters);
      });
      const model = `${response.provider}/${response.model}`;
      if (!models.includes(model)) models.push(model);
      const reported = response.usage;
      if (reported && Number.isFinite(reported.input) && Number.isFinite(reported.output)
        && Number.isFinite(reported.cost?.total)) {
        usage = {
          input: (usage?.input ?? 0) + reported.input,
          output: (usage?.output ?? 0) + reported.output,
          cost: (usage?.cost ?? 0) + reported.cost.total,
        };
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    }
  }
  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { results, models, usage, elapsedMs: Date.now() - started, error };
}

export function recommendTool(chosen: string, report: ToolReport): string | undefined {
  if (report.error) return undefined;
  const current = report.results.find(result => result.name === chosen);
  const best = report.results.find(result => result.status === "accepted" && result.active);
  return current?.status === "rejected" && best && best.name !== chosen ? best.name : undefined;
}

export function toolSuggestion(report: ToolReport): string | undefined {
  if (report.error) return undefined;
  // ponytail: Show top three only after judging whole inventory; expand display if needed.
  const picks = report.results.filter(result => result.status === "accepted").slice(0, 3);
  if (!picks.length) return undefined;
  return `Optional tool suggestions (Judge ${report.models.join(", ")}, advisory only): ${picks.map(pick => `${pick.name} ${pick.active ? "[active]" : "[inactive; activate before use]"} ${(pick.score! * 100).toFixed(1)}%`).join(", ")}. Confirm parameters and normal approvals before use.`;
}

export async function assessToolCall(
  task: string | undefined, chosen: string, tools: readonly ToolCandidate[], active: ReadonlySet<string>,
  judge: Judge, threshold: number, timeoutMs: number,
): Promise<string | undefined> {
  if (!task?.trim() || !tools.some(tool => tool.name === chosen)) return undefined;
  return recommendTool(chosen, await findTools(task, tools, active, judge, threshold, timeoutMs));
}

function parseValue(key: string, value: string): boolean | number {
  if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${key}`);
  if (key === "debug" || key === "autoSuggest" || key === "checkCalls") {
    if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
    return value === "true";
  }
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number)) throw new Error(`${key} must be a finite number`);
  if (key === "threshold" && (number < 0 || number > 1)) throw new Error("threshold must be between 0 and 1");
  if (key === "timeoutMs" && (!Number.isInteger(number) || number < 100 || number > 20000)) {
    throw new Error("timeoutMs must be an integer between 100 and 20000");
  }
  return number;
}

export async function readConfig(file: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return { ...defaults };
    throw cause;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Jev tool config: expected object");
  const config = { ...defaults };
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "boolean" && typeof entry !== "number") throw new Error(`Invalid Jev tool config: ${key}`);
    const parsed = parseValue(key, String(entry));
    if (parsed !== entry) throw new Error(`Invalid Jev tool config: ${key}`);
    Object.assign(config, { [key]: parsed });
  }
  return config;
}

export async function setConfig(file: string, key: string, value: string): Promise<Config> {
  const parsed = parseValue(key, value);
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      handle = await open(lock, "wx", 0o600);
      break;
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      await pause(25);
    }
  }
  // ponytail: A crashed writer leaves a lock; fail closed after 2s. Clear stale lock manually;
  // upgrade to OS advisory locking if recovery must be automatic.
  if (!handle) throw new Error(`Jev tool config busy: ${lock}`);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const config = { ...await readConfig(file), [key]: parsed };
    await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
    return config;
  } finally {
    await unlink(temp).catch(cause => {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    });
    await handle.close();
    await unlink(lock);
  }
}

export function formatReport(report: ToolReport, config: Config): string {
  const lines = [`Tools · threshold ${config.threshold} · ${report.elapsedMs}ms`];
  if (report.error) lines.push(`Judge unavailable: ${report.error}`);
  lines.push(`Model: ${report.models.join(", ") || "unavailable"}`);
  lines.push(report.usage
    ? `Tokens: ${report.usage.input} in / ${report.usage.output} out · Cost: $${report.usage.cost.toFixed(6)}`
    : "Tokens/cost: unavailable");
  // ponytail: Five per group fits TUI; use an expandable renderer if deeper inspection is needed.
  const limit = 5;
  const accepted = report.results.filter(result => result.status === "accepted");
  if (!accepted.length) lines.push("No confident tool match.");
  for (const result of accepted.slice(0, limit)) {
    lines.push(`- ${result.name} ${result.active ? "[active]" : "[inactive]"} ${(result.score! * 100).toFixed(1)}% [${"#".repeat(Math.round(result.score! * 10)).padEnd(10, "-")}] ${result.description}`);
    if (result.schema) lines.push(`  parameters: ${result.schema}`);
  }
  if (accepted.length > limit) lines.push(`${accepted.length - limit} more accepted (omitted from display)`);
  if (config.debug) {
    const rejected = report.results.filter(result => result.status === "rejected");
    for (const result of rejected.slice(0, limit)) lines.push(`rejected: ${result.name} ${(result.score! * 100).toFixed(1)}%`);
    if (rejected.length > limit) lines.push(`${rejected.length - limit} more rejected (omitted from display)`);
    const unjudged = report.results.filter(result => result.status === "unjudged");
    for (const result of unjudged.slice(0, limit)) lines.push(`unjudged: ${result.name}`);
    if (unjudged.length > limit) lines.push(`${unjudged.length - limit} more unjudged (omitted from display)`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
  const configFile = join(pi.pi.Settings.instance.getAgentDir(), "jev-tool.json");
  let lastTask: { sessionId: string; prompt: string } | undefined;
  const judgeFor = (ctx: ExtensionContext) =>
    resolveJudge({
      settings: pi.pi.Settings.instance, registry: ctx.modelRegistry,
      sessionId: ctx.sessionManager.getSessionId(),
      onUsage: journalJudgmentUsage(ctx.sessionManager, "jev-tool"),
    });
  const run = async (task: string, config: Config, ctx: ExtensionContext, signal?: AbortSignal) =>
    findTools(task, pi.getAllTools(), new Set(pi.getActiveTools()), judgeFor(ctx), config.threshold, config.timeoutMs, signal);

  pi.registerTool({
    name: "jev_tool", label: "Jev Tool Finder",
    description: "Rank currently registered OMP tools for a task with native Judge relevance scores; never executes suggested tools.",
    approval: "read",
    loadMode: "essential",
    parameters: pi.zod.object({ task: pi.zod.string().describe("Task needing a tool") }),
    async execute(_id, { task }, signal, _update, ctx) {
      if (!task.trim()) return { content: [{ type: "text", text: "Task required." }] };
      try {
        const config = await readConfig(configFile);
        const report = await run(task, config, ctx, signal);
        return { content: [{ type: "text", text: formatReport(report, config) }] };
      } catch (cause) {
        return { content: [{ type: "text", text: `Jev tool finder unavailable: ${cause instanceof Error ? cause.message : String(cause)}` }] };
      }
    },
  });

  pi.registerCommand("jev-tool", {
    description: "Find relevant registered tools: /jev-tool <task>",
    async handler(args, ctx) {
      if (!args.trim()) return ctx.ui.notify("Usage: /jev-tool <task>", "warning");
      try {
        const config = await readConfig(configFile);
        ctx.ui.notify(formatReport(await run(args, config, ctx), config), "info");
      } catch (cause) {
        ctx.ui.notify(`Jev tool finder unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
      }
    },
  });

  pi.registerCommand("jev-tool-config", {
    description: "Show or set Jev tool finder config: /jev-tool-config [status|set <key> <value>]",
    async handler(args, ctx) {
      try {
        const parts = args.trim().split(/\s+/);
        if (!args.trim() || parts[0] === "show" || parts[0] === "status") {
          ctx.ui.notify(`${configFile}\n${JSON.stringify(await readConfig(configFile), null, 2)}`, "info");
        } else if (parts[0] === "set" && parts.length === 3) {
          ctx.ui.notify(JSON.stringify(await setConfig(configFile, parts[1], parts[2]), null, 2), "info");
        } else {
          ctx.ui.notify("Usage: /jev-tool-config [status|set <debug|autoSuggest|checkCalls|threshold|timeoutMs> <value>]", "warning");
        }
      } catch (cause) {
        ctx.ui.notify(`Jev tool config: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    lastTask = { sessionId: ctx.sessionManager.getSessionId(), prompt: event.prompt };
    try {
      const config = await readConfig(configFile);
      if (!config.autoSuggest || !event.prompt.trim()) return;
      const suggestion = toolSuggestion(await run(event.prompt, config, ctx));
      if (!suggestion) return;
      return { message: { customType: "jev-tool-suggestion", display: true, content: suggestion } };
    } catch (cause) {
      pi.logger.warn("Jev tool suggestion unavailable", { error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      const config = await readConfig(configFile);
      if (!config.checkCalls || event.toolName === "jev_tool") return;
      const task = lastTask?.sessionId === ctx.sessionManager.getSessionId() ? lastTask.prompt : undefined;
      if (!task) return;
      const hostCap = cfgExtensionHandlersToolCallTimeoutMs.get(pi.pi.Settings.instance);
      // ponytail: Skip advisory if host gives under 500ms; keep a 500ms margin for hook cleanup.
      if (hostCap <= 500) return;
      const better = await assessToolCall(task, event.toolName, pi.getAllTools(), new Set(pi.getActiveTools()),
        judgeFor(ctx), config.threshold, Math.min(config.timeoutMs, hostCap - 500));
      if (better && ctx.hasUI) {
        ctx.ui.notify(`Jev tool advisory: ${event.toolName} scored below ${config.threshold}; ${better} scored higher. Original call proceeds unchanged.`, "warning");
      }
    } catch (cause) {
      pi.logger.warn("Jev tool check unavailable", { error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
}
