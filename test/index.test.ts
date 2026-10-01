import { afterEach, expect, mock, test } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let extensionJudge: Judge = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
mock.module("@oh-my-pi/pi-coding-agent/judgment", () => ({
  journalJudgmentUsage: () => () => { },
  resolveJudge: () => extensionJudge,
}));
// Load after the module mock so extension hooks use a deterministic Judge.
const { default: extension, assessToolCall, findTools, formatReport, readConfig, recommendTool, setConfig, toolSuggestion } =
  await import("../src/index");

const dirs: string[] = [];
afterEach(async () => {
  extensionJudge = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
type TestTool = {
  name: string;
  description: string;
  parameters: { toJsonSchema: () => { type: "object"; properties: { path: { type: "string" } } } };
  sourceInfo: { source: string; path: string; scope: string; origin: string };
};
const tool = (name: string): TestTool => ({
  name, description: `${name} files`,
  parameters: { toJsonSchema: () => ({ type: "object", properties: { path: { type: "string" } } }) },
  sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
});
const usage = { input: 10, output: 2, totalTokens: 12, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const judge = (scores: number[]): Judge => ({
  label: "test judge",
  async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
    // Test transport constructs question IDs dynamically, matching native Judge's wire shape.
    return {
      api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
      answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [id, { type: "noul", noul: scores[index] }])),
    } as unknown as JudgmentResult<Q>;
  },
});
type BeforeStartHandler = (event: { prompt: string }, ctx: unknown) => Promise<unknown> | unknown;
type LifecycleHandler = (event: unknown, ctx: unknown) => void;
type AsideMessage = {
  payload: { customType?: string; display?: boolean; content?: string };
  options?: { deliverAs?: string };
  afterAgentStart: boolean;
};

function controlledJudge(model: string) {
  const started = Promise.withResolvers<void>();
  const scoresReady = Promise.withResolvers<number[]>();
  let wasStarted = false;
  const controlled: Judge = {
    label: model,
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      wasStarted = true;
      started.resolve();
      const scores = await scoresReady.promise;
      return {
        api: "typesafe", provider: "typesafe", model, usage,
        answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [
          id, { type: "noul", noul: scores[index] },
        ])),
      } as unknown as JudgmentResult<Q>;
    },
  };
  return {
    judge: controlled,
    started: started.promise,
    wasStarted: () => wasStarted,
    resolve: (scores: number[]) => scoresReady.resolve(scores),
  };
}

async function extensionHarness(tools: TestTool[], roster: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "jev-tool-extension-"));
  dirs.push(dir);
  const configFile = join(dir, "jev-tool.json");
  let active = [...roster];
  let turnRunning = false;
  let beforeStart: BeforeStartHandler | undefined;
  let agentStart: LifecycleHandler | undefined;
  let agentEnd: LifecycleHandler | undefined;
  const selections: string[][] = [];
  const messages: AsideMessage[] = [];
  const messageSent = Promise.withResolvers<AsideMessage>();
  const secondMessageSent = Promise.withResolvers<AsideMessage>();
  const context = {
    modelRegistry: {},
    sessionManager: { getSessionId: () => "session-1" },
    isIdle: () => !turnRunning,
    hasUI: true,
    ui: { notify: () => { } },
  };
  extension({
    registerTool: () => { },
    registerCommand: () => { },
    on: (name: string, handler: unknown) => {
      if (name === "before_agent_start") beforeStart = handler as BeforeStartHandler;
      if (name === "agent_start") agentStart = handler as LifecycleHandler;
      if (name === "agent_end") agentEnd = handler as LifecycleHandler;
    },
    sendMessage: (payload: AsideMessage["payload"], options?: AsideMessage["options"]) => {
      const entry = { payload, options, afterAgentStart: turnRunning };
      messages.push(entry);
      messageSent.resolve(entry);
      if (messages.length === 2) secondMessageSent.resolve(entry);
    },
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: async (names: string[]) => {
      active = [...names];
      selections.push([...names]);
    },
    zod: { object: () => ({}), string: () => ({ describe: () => ({}) }) },
    logger: { warn: () => { } },
    pi: { Settings: { instance: { getAgentDir: () => dir } } },
  } as never);
  const prepare = async (prompt: string) => {
    if (!beforeStart) throw new Error("before_agent_start handler missing");
    return beforeStart({ prompt }, context);
  };
  const launch = () => {
    turnRunning = true;
    agentStart?.({}, context);
  };
  return {
    configFile,
    selections,
    messages,
    messageSent: messageSent.promise,
    secondMessageSent: secondMessageSent.promise,
    active: () => active,
    prepare,
    launch,
    async start(prompt: string) {
      const result = await prepare(prompt);
      launch();
      return result;
    },
    end() {
      turnRunning = false;
      agentEnd?.({ willContinue: false }, context);
    },
  };
}

test("ranks active and inactive registered tools by validated per-candidate scores", async () => {
  const report = await findTools("read a file", [tool("delete"), tool("read")], new Set(["read"]), judge([0.1, 0.9]), 0.65, 2000);
  expect(report.results.map(({ name, score, status, active }) => ({ name, score, status, active }))).toEqual([
    { name: "read", score: 0.9, status: "accepted", active: true },
    { name: "delete", score: 0.1, status: "rejected", active: false },
  ]);
  expect(report.models).toEqual(["typesafe/jev-latest"]);
  expect(report.usage).toEqual({ input: 10, output: 2, cost: 0.01 });
  expect(recommendTool("delete", report)).toBe("read");
  expect(recommendTool("read", report)).toBeUndefined();
  expect(toolSuggestion(report)).toContain("read");
});

test("diagnostics show top five hits with explicit omitted counts, without dropping judged inventory", async () => {
  const tools = Array.from({ length: 12 }, (_, index) => tool(`t${index}`));
  const config = { debug: true, autoSuggest: false, checkCalls: false, threshold: 0.65, timeoutMs: 2000 };
  const mostlyRejected = await findTools("read", tools, new Set(["t0"]), judge([0.9, ...Array(11).fill(0.1)]), 0.65, 2000);
  const text = formatReport(mostlyRejected, config);
  expect(text).toContain("- t0 [active] 90.0% [#########-]");
  expect(text.match(/^rejected:/gm)).toHaveLength(5);
  expect(text).toContain("6 more rejected");
  expect(mostlyRejected.results).toHaveLength(12);
  const allAccepted = await findTools("read", tools, new Set(["t0"]), judge(Array(12).fill(0.9)), 0.65, 2000);
  const acceptedText = formatReport(allAccepted, config);
  expect(acceptedText.match(/^- t\d/gm)).toHaveLength(5);
  expect(acceptedText).toContain("7 more accepted");
});

test("automatic advice never offers an inactive replacement as immediately callable", async () => {
  const report = await findTools("inspect source", [tool("read"), tool("write")],
    new Set(["read"]), judge([0.1, 0.95]), 0.65, 2000);
  expect(report.results.find(result => result.name === "write")?.status).toBe("accepted");
  expect(recommendTool("read", report)).toBeUndefined();
  expect(toolSuggestion(report)).toContain("write [inactive; activate before use]");
});

test("malformed answer IDs and scores never masquerade as a zero or a suggestion", async () => {
  const invalid: Judge = {
    label: "bad judge",
    async judge<Q extends Questions>(): Promise<JudgmentResult<Q>> {
      // Deliberately malformed network response, exercised by production validation.
      return { api: "typesafe", provider: "typesafe", model: "jev", usage, answers: { unexpected: { type: "noul", noul: 1.5 } } } as unknown as JudgmentResult<Q>;
    },
  };
  const report = await findTools("read", [tool("read")], new Set(["read"]), invalid, 0.65, 2000);
  expect(report.results[0].status).toBe("unjudged");
  expect(report.results[0].score).toBeUndefined();
  expect(recommendTool("delete", report)).toBeUndefined();
});

test("failed Judge leaves every candidate unjudged, without a blocking recommendation", async () => {
  const unavailable = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
  const report = await findTools("read", [tool("read")], new Set(["read"]), unavailable, 0.65, 2000);
  expect(report.results[0].status).toBe("unjudged");
  expect(report.error).toContain("no judge model available");
  expect(recommendTool("delete", report)).toBeUndefined();
});

test("unabortable Judge settles before advisory deadline without blocking tool choice", async () => {
  const hung: Judge = {
    label: "hung", judge<Q extends Questions>() {
      return Promise.withResolvers<JudgmentResult<Q>>().promise;
    }
  };
  // Real AbortSignal.timeout plus a permanently pending transport exercises OMP's wall-clock boundary.
  const { promise: safety, reject } = Promise.withResolvers<never>();
  const guard = setTimeout(() => reject(new Error("Judge stayed pending past host budget")), 300);
  try {
    const report = await Promise.race([
      findTools("read", [tool("read")], new Set(["read"]), hung, 0.65, 20), safety,
    ]);
    expect(report.error).toMatch(/timed out|timeout/i);
    expect(report.results[0].status).toBe("unjudged");
    expect(recommendTool("read", report)).toBeUndefined();
    expect(await assessToolCall("read", "read", [tool("read")], new Set(["read"]), hung, 0.65, 20)).toBeUndefined();
  } finally {
    clearTimeout(guard);
  }
});

test("inventory larger than one batch is fully judged", async () => {
  const tools = Array.from({ length: 21 }, (_, index) => tool(`t${index}`));
  const report = await findTools("files", tools, new Set(), judge(Array(21).fill(0.8)), 0.65, 2000);
  expect(report.results).toHaveLength(21);
  expect(report.results.every(result => result.status === "accepted")).toBe(true);
});

test("later Judge batch failure keeps explicit scores but suppresses automatic advice", async () => {
  let calls = 0;
  const partial: Judge = {
    label: "partial",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      if (++calls === 2) throw new Error("provider unavailable");
      return {
        api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [
          id, { type: "noul", noul: index === 1 ? 0.1 : 0.9 },
        ])),
      } as unknown as JudgmentResult<Q>;
    },
  };
  const tools = Array.from({ length: 17 }, (_, index) => tool(`t${index}`));
  const report = await findTools("read", tools, new Set(), partial, 0.65, 2000);
  expect(report.error).toContain("provider unavailable");
  expect(report.results.filter(result => result.status === "accepted")).toHaveLength(15);
  expect(report.results.find(result => result.name === "t16")?.status).toBe("unjudged");
  expect(recommendTool("t1", report)).toBeUndefined();
  expect(toolSuggestion(report)).toBeUndefined();
});

test("only accepted parameter schemas are converted and never sent to Judge", async () => {
  const largeSchema = { description: "x".repeat(30_000) };
  let conversions = 0;
  const candidate = {
    ...tool("read"), parameters: {
      toJsonSchema: () => {
        conversions++;
        return largeSchema;
      }
    }
  };
  const bounded: Judge = {
    label: "bounded judge",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      if (JSON.stringify(request.state).length > 2000) throw new Error("request too large");
      return {
        api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: { tool_0: { type: "noul", noul: 0.9 } }
      } as unknown as JudgmentResult<Q>;
    },
  };
  const report = await findTools("read file", [candidate], new Set(["read"]), bounded, 0.65, 2000);
  expect(report.results[0].status).toBe("accepted");
  expect(report.results[0].schema).toContain("x".repeat(30_000));
  expect(conversions).toBe(1);
  const rejected = await findTools("read file", [candidate], new Set(["read"]), judge([0.1]), 0.65, 2000);
  expect(rejected.results[0].status).toBe("rejected");
  expect(rejected.results[0].schema).toBeUndefined();
  expect(conversions).toBe(1);
  const offline = { label: "offline", async judge() { throw new Error("judge unavailable"); } };
  const unjudged = await findTools("read file", [candidate], new Set(["read"]), offline, 0.65, 2000);
  expect(unjudged.results[0].status).toBe("unjudged");
  expect(unjudged.results[0].schema).toBeUndefined();
  expect(conversions).toBe(1);
});

test("advisory skips calls without a prompt and uses task context when present", async () => {
  let judged = 0;
  const relevance: Judge = {
    label: "selection judge",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      judged++;
      expect(request.state).toContain("Read a Markdown file");
      return {
        api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: { tool_0: { type: "noul", noul: 0.1 }, tool_1: { type: "noul", noul: 0.9 } }
      } as unknown as JudgmentResult<Q>;
    },
  };
  const tools = [tool("delete"), tool("read")];
  expect(await assessToolCall(undefined, "delete", tools, new Set(["read"]), relevance, 0.65, 2000)).toBeUndefined();
  expect(judged).toBe(0);
  expect(await assessToolCall("Read a Markdown file", "delete", tools, new Set(["read"]), relevance, 0.65, 2000)).toBe("read");
});

test("concurrent settings writes preserve both updates and reject invalid values without clobbering file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-tool-test-")); dirs.push(dir);
  const file = join(dir, "config.json");
  await Promise.all([setConfig(file, "debug", "false"), setConfig(file, "threshold", "0.8")]);
  expect(await readConfig(file)).toMatchObject({ debug: false, threshold: 0.8, autoSuggest: false, checkCalls: false });
  const before = await readFile(file, "utf8");
  await expect(setConfig(file, "threshold", "nan")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
});

test("extension factory does not access Settings before initialization", () => {
  const pi = {
    registerTool: () => { },
    registerCommand: () => { },
    on: () => { },
    getAllTools: () => [],
    getActiveTools: () => [],
    zod: { object: () => ({}), string: () => ({ describe: () => ({}) }) },
    logger: { warn: () => { } },
    pi: { Settings: {} as Record<string, unknown> },
  };
  Object.defineProperty(pi.pi.Settings, "instance", {
    get() { throw new Error("Settings not initialized. Call Settings.init() first."); },
  });
  expect(() => extension(pi as never)).not.toThrow();
});
test("before_agent_start settles under 100ms with a never-resolving Judge", async () => {
  const harness = await extensionHarness([tool("read"), tool("new")], ["read"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true, timeoutMs: 1000 }));
  const judgeStarted = Promise.withResolvers<void>();
  extensionJudge = {
    label: "pending",
    judge<Q extends Questions>() {
      judgeStarted.resolve();
      return Promise.withResolvers<JudgmentResult<Q>>().promise;
    },
  };

  const startedAt = performance.now();
  const start = harness.start("write a file");
  await judgeStarted.promise;
  const hookResult = await start;
  const elapsedMs = performance.now() - startedAt;
  harness.end();

  expect(hookResult).toBeUndefined();
  expect(elapsedMs).toBeLessThan(100);
});

test("autoSuggest activates accepted tools additively without removing current tools", async () => {
  const harness = await extensionHarness([tool("read"), tool("stale"), tool("new")], ["read", "stale"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  extensionJudge = judge([0.1, 0.1, 0.95]);

  const hookResult = await harness.start("use the new tool");
  expect(hookResult).toBeUndefined();
  const delivered = await harness.messageSent;

  expect(delivered.payload.content).toContain("new");
  expect(harness.selections).toEqual([["read", "stale", "new"]]);
  expect(harness.active()).toEqual(["read", "stale", "new"]);
});

test("tool suggestions use aside delivery only after agent_start", async () => {
  const harness = await extensionHarness([tool("read")], ["read"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  extensionJudge = judge([0.95]);

  const hookResult = await harness.start("read a file");
  expect(hookResult).toBeUndefined();
  await harness.messageSent;

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0].payload).toMatchObject({ customType: "jev-tool-suggestion", display: true });
  expect(harness.messages[0].options).toEqual({ deliverAs: "aside" });
  expect(harness.messages[0].afterAgentStart).toBe(true);
});

test("autoSelect is rejected as an unknown setting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-tool-config-test-")); dirs.push(dir);
  const file = join(dir, "config.json");

  await expect(setConfig(file, "autoSelect", "true")).rejects.toThrow("Unknown setting: autoSelect");
  await writeFile(file, JSON.stringify({ autoSelect: true }));
  await expect(readConfig(file)).rejects.toThrow("Unknown setting: autoSelect");
});

test("late Judge result after agent_end sends nothing and never changes active tools", async () => {
  const harness = await extensionHarness([tool("read"), tool("new")], ["read"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const pending = controlledJudge("late");
  extensionJudge = pending.judge;

  const start = harness.start("use new tool");
  await pending.started;
  harness.end();
  pending.resolve([0.1, 0.95]);
  const hookResult = await start;
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(hookResult).toBeUndefined();
  expect(harness.messages).toEqual([]);
  expect(harness.selections).toEqual([]);
  expect(harness.active()).toEqual(["read"]);
});

test("overlapping prompts cancel old Judge work and only current generation activates and delivers", async () => {
  const harness = await extensionHarness(
    [tool("read"), tool("stale"), tool("first"), tool("second")], ["read", "stale"],
  );
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const first = controlledJudge("first");
  const second = controlledJudge("second");
  extensionJudge = first.judge;

  const firstStart = harness.start("use first tool");
  await first.started;
  extensionJudge = second.judge;
  const secondStart = harness.start("use second tool");
  await second.started;
  first.resolve([0.1, 0.1, 0.95, 0.1]);
  second.resolve([0.1, 0.1, 0.1, 0.95]);
  const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);
  expect(firstResult).toBeUndefined();
  expect(secondResult).toBeUndefined();
  await harness.messageSent;
  harness.end();

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0].payload.content).toContain("second");
  expect(harness.messages[0].payload.content).not.toContain("first");
  expect(harness.selections).toEqual([["read", "stale", "second"]]);
});
test("before A then B binds agent_start to latest generation", async () => {
  const harness = await extensionHarness(
    [tool("read"), tool("first"), tool("second")], ["read", "stale"],
  );
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const first = controlledJudge("first");
  const second = controlledJudge("second");
  extensionJudge = {
    label: "prompt dispatcher",
    judge<Q extends Questions>(request: JudgmentRequest<Q>) {
      const selected = JSON.stringify(request.state).includes("second prompt") ? second.judge : first.judge;
      return selected.judge(request);
    },
  };

  await harness.prepare("use first prompt");
  await harness.prepare("use second prompt");
  harness.launch();

  expect(first.wasStarted()).toBe(false);
  expect(second.wasStarted()).toBe(true);
  second.resolve([0.1, 0.1, 0.95]);
  await harness.messageSent;
  harness.end();

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0].payload.content).toContain("second");
  expect(harness.messages[0].payload.content).not.toContain("first");
  expect(harness.selections).toEqual([["read", "stale", "second"]]);
});
test("completed prompt additions remain active across the next prompt", async () => {
  const harness = await extensionHarness(
    [tool("read"), tool("first"), tool("second")], ["read"],
  );
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const first = controlledJudge("first");
  const second = controlledJudge("second");
  extensionJudge = first.judge;

  const firstStart = harness.start("use first tool");
  await first.started;
  first.resolve([0.1, 0.95, 0.1]);
  await firstStart;
  await harness.messageSent;
  expect(harness.active()).toEqual(["read", "first"]);
  harness.end();
  expect(harness.active()).toEqual(["read", "first"]);

  extensionJudge = second.judge;
  const secondStart = harness.start("use second tool");
  await second.started;
  second.resolve([0.1, 0.1, 0.95]);
  await secondStart;
  await harness.secondMessageSent;
  harness.end();

  expect(harness.messages).toHaveLength(2);
  expect(harness.messages[0].payload.content).toContain("first");
  expect(harness.messages[1].payload.content).toContain("second");
  expect(harness.selections).toEqual([
    ["read", "first"],
    ["read", "first", "second"],
  ]);
  expect(harness.active()).toEqual(["read", "first", "second"]);
});
