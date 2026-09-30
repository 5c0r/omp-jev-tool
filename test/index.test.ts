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
type BeforeStartHandler = (event: { prompt: string }, ctx: unknown) => Promise<unknown>;
type ConfigCommandHandler = (args: string, ctx: unknown) => Promise<void>;

async function extensionHarness(tools: TestTool[], roster: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "jev-tool-extension-"));
  dirs.push(dir);
  const configFile = join(dir, "jev-tool.json");
  let active = [...roster];
  let beforeStart: BeforeStartHandler | undefined;
  let configHandler: ConfigCommandHandler | undefined;
  const selections: string[][] = [];
  let sessionId = "session-1";
  const context = {
    modelRegistry: {},
    sessionManager: { getSessionId: () => sessionId },
    hasUI: true,
    ui: { notify: () => { } },
  };
  extension({
    registerTool: () => { },
    registerCommand: (name: string, options: { handler: ConfigCommandHandler }) => {
      if (name === "jev-tool-config") configHandler = options.handler;
    },
    on: (name: string, handler: BeforeStartHandler) => {
      if (name === "before_agent_start") beforeStart = handler;
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
  return {
    configFile,
    selections,
    active: () => active,
    async start(prompt: string) {
      if (!beforeStart) throw new Error("before_agent_start handler missing");
      return beforeStart({ prompt }, context);
    },
    async configure(args: string) {
      if (!configHandler) throw new Error("jev-tool-config handler missing");
      return configHandler(args, context);
    },
    switchSession(id: string, names: string[]) {
      sessionId = id;
      active = [...names];
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
  const config = { debug: true, autoSuggest: false, autoSelect: false, checkCalls: false, threshold: 0.65, timeoutMs: 2000 };
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
  expect(await readConfig(file)).toMatchObject({ debug: false, threshold: 0.8, autoSuggest: false, autoSelect: false, checkCalls: false });
  const before = await readFile(file, "utf8");
  await expect(setConfig(file, "threshold", "nan")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
});

test("extension factory registers without initialized Settings", () => {
  // Git-install validation runs the factory before Settings.init(); agent-dir access must be deferred.
  const registered: string[] = [];
  const pi = {
    registerTool: () => registered.push("tool"),
    registerCommand: () => registered.push("command"),
    on: () => registered.push("hook"),
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
  expect(registered).toEqual(["tool", "command", "command", "hook", "hook"]);
});
test("autoSelect defaults off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-tool-config-test-")); dirs.push(dir);
  expect((await readConfig(join(dir, "missing.json"))).autoSelect).toBe(false);
});

test("autoSelect preserves active core tools, prunes low scores, and activates relevant inactive tools", async () => {
  const harness = await extensionHarness([tool("read"), tool("stale"), tool("new")], ["read", "stale"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true }));
  extensionJudge = judge([0.1, 0.2, 0.95]);

  await harness.start("inspect files");

  expect(new Set(harness.selections[0])).toEqual(new Set(["read", "new"]));
  expect(harness.active()).toEqual(["read", "new"]);
});

test("autoSelect does not reactivate a user-disabled core tool, even when Judge accepts it", async () => {
  const harness = await extensionHarness([tool("read"), tool("write"), tool("other")], ["read"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true }));
  extensionJudge = judge([0.1, 0.99, 0.9]);

  await harness.start("edit files");

  expect(new Set(harness.active())).toEqual(new Set(["read", "other"]));
});

test("autoSelect recomputes selection for every prompt", async () => {
  const harness = await extensionHarness(
    [tool("read"), tool("stale"), tool("first"), tool("second")], ["read", "stale"],
  );
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true }));
  extensionJudge = judge([0.1, 0.2, 0.95, 0.1]);
  await harness.start("first task");
  extensionJudge = judge([0.1, 0.95, 0.1, 0.9]);

  await harness.start("second task");

  expect(harness.selections).toHaveLength(2);
  expect(new Set(harness.selections[1])).toEqual(new Set(["read", "stale", "second"]));
});

test("autoSelect restores original roster after Judge failure or empty selection", async () => {
  const tools = [tool("read"), tool("stale"), tool("new")];
  const harness = await extensionHarness(tools, ["read", "stale"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true }));
  extensionJudge = judge([0.1, 0.2, 0.95]);
  await harness.start("first task");
  extensionJudge = { label: "offline", async judge() { throw new Error("offline"); } };
  await harness.start("second task");
  expect(harness.active()).toEqual(["read", "stale"]);

  extensionJudge = judge([0.1, 0.2, 0.1]);
  await harness.start("third task");

  expect(harness.selections.slice(-1)[0]).toEqual(["read", "stale"]);
  expect(harness.active()).toEqual(["read", "stale"]);
});

test("disabling autoSelect restores original roster", async () => {
  const harness = await extensionHarness([tool("read"), tool("stale"), tool("new")], ["read", "stale"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true }));
  extensionJudge = judge([0.1, 0.2, 0.95]);
  await harness.start("select tools");

  await harness.configure("set autoSelect false");

  expect(harness.active()).toEqual(["read", "stale"]);
  expect((await readConfig(harness.configFile)).autoSelect).toBe(false);
});

test("autoSuggest remains independent when autoSelect is off", async () => {
  const harness = await extensionHarness([tool("read"), tool("write")], ["read"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  extensionJudge = judge([0.1, 0.95]);

  const result = await harness.start("write a file") as { message?: { customType?: string; content?: string } };

  expect(result.message?.customType).toBe("jev-tool-suggestion");
  expect(result.message?.content).toContain("write");
  expect(harness.selections).toEqual([]);
  expect(harness.active()).toEqual(["read"]);
});
test("autoSelect validates boolean values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-tool-config-test-")); dirs.push(dir);
  const file = join(dir, "config.json");

  await expect(setConfig(file, "autoSelect", "invalid")).rejects.toThrow("autoSelect must be true or false");
  expect((await setConfig(file, "autoSelect", "true")).autoSelect).toBe(true);
});

test("autoSelect restores roster when Judge times out", async () => {
  const harness = await extensionHarness([tool("read"), tool("stale")], ["read", "stale"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true, timeoutMs: 100 }));
  extensionJudge = {
    label: "hung",
    async judge<Q extends Questions>() {
      return Promise.withResolvers<JudgmentResult<Q>>().promise;
    },
  };

  await harness.start("wait for judge");

  expect(harness.selections).toEqual([["read", "stale"]]);
  expect(harness.active()).toEqual(["read", "stale"]);
});
test("autoSelect captures a fresh roster for each session", async () => {
  const tools = [tool("read"), tool("write"), tool("stale"), tool("new")];
  const harness = await extensionHarness(tools, ["read", "stale"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true }));
  extensionJudge = judge([0.1, 0.1, 0.2, 0.95]);
  await harness.start("first session");
  harness.switchSession("session-2", ["write", "stale"]);
  extensionJudge = judge([0.1, 0.9, 0.2, 0.1]);

  await harness.start("second session");

  expect(new Set(harness.selections[0])).toEqual(new Set(["read", "new"]));
  expect(harness.selections[1]).toEqual(["write"]);
});
test("autoSuggest reports newly auto-selected tools as active", async () => {
  const harness = await extensionHarness([tool("read"), tool("new")], ["read"]);
  await writeFile(harness.configFile, JSON.stringify({ autoSelect: true, autoSuggest: true }));
  extensionJudge = judge([0.1, 0.95]);

  const result = await harness.start("use new tool") as { message?: { content?: string } };

  expect(harness.active()).toEqual(["read", "new"]);
  expect(result.message?.content).toContain("new [active]");
});
