import { afterEach, expect, test } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessToolCall, findTools, formatReport, readConfig, recommendTool, setConfig, toolSuggestion } from "../src/index";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const tool = (name: string) => ({
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
  const hung: Judge = { label: "hung", judge<Q extends Questions>() {
    return Promise.withResolvers<JudgmentResult<Q>>().promise;
  } };
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

test("large parameter schema stays in returned hit without exhausting Judge input", async () => {
  const largeSchema = { description: "x".repeat(30_000) };
  const candidate = { ...tool("read"), parameters: { toJsonSchema: () => largeSchema } };
  const bounded: Judge = {
    label: "bounded judge",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      if (JSON.stringify(request.state).length > 2000) throw new Error("request too large");
      return { api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: { tool_0: { type: "noul", noul: 0.9 } } } as unknown as JudgmentResult<Q>;
    },
  };
  const report = await findTools("read file", [candidate], new Set(["read"]), bounded, 0.65, 2000);
  expect(report.results[0].status).toBe("accepted");
  expect(report.results[0].schema).toContain("x".repeat(30_000));
});

test("advisory skips calls without a prompt and uses task context when present", async () => {
  let judged = 0;
  const relevance: Judge = {
    label: "selection judge",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      judged++;
      expect(request.state).toContain("Read a Markdown file");
      return { api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: { tool_0: { type: "noul", noul: 0.1 }, tool_1: { type: "noul", noul: 0.9 } } } as unknown as JudgmentResult<Q>;
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
