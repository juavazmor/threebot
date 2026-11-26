import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

// Real React DOM, transcript and card; only the gateway's HTTP answers are scripted.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "http://handoff-card.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "handoff-card-test-entry", resolveId: (id) => id.endsWith("virtual:handoff-card-tests") ? "\0handoff-card-tests" : undefined,
    load: (id) => id === "\0handoff-card-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { HandoffCard } from ${JSON.stringify(`${src}components/Cards.tsx`)};
      export { buildEntries } from ${JSON.stringify(`${src}lib/transcript.ts`)};
      export { handoffProposalId, handoffRunsAs, handoffUrlWarning } from ${JSON.stringify(`${src}lib/handoffs.ts`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:handoff-card-tests", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const testDir = await mkdtemp(join(tmpdir(), "bot-handoff-card-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entry.code);
const { createElement: h, act, createRoot, HandoffCard, buildEntries, handoffProposalId, handoffRunsAs, handoffUrlWarning, useApp } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });

const ID = "0f5c2a9e-6f0b-4a53-9a43-1d2b3c4d5e6f";
const OTHER_ID = "1a2b3c4d-0000-4000-8000-aabbccddeeff";
const bot = { slug: "reader", name: "Reader", mainThreadId: "thread-1", shape: "blob", color: "teal", workspaceRoot: "/bots/reader" };
const stored = (extra = {}) => ({
  id: ID, botSlug: "reader", botName: "Reader", threadId: "thread-1", projectId: "project-app", projectTitle: "App", projectPath: "/work/app",
  kind: "evaluate-fit", kindLabel: "Evaluate fit", url: "https://example.com/tool", title: "Evaluate fit: example.com",
  prompt: "Handoff from Reader.\n\nLink: https://example.com/tool\n\nRules:\n- Investigate only.", status: "pending", createdAt: "2026-11-26T10:00:00.000Z",
  launchSettings: { runtimeMode: "approval-required", interactionMode: "plan", workspaceStrategy: { type: "root" } },
  evaluatorDir: "/home/user/.threebot/evaluator", ...extra,
});

let root, host, requests, answer;
beforeEach(() => {
  requests = [];
  answer = () => ({ status: 200, body: stored() });
  globalThis.fetch = (async (path: unknown, init: { method?: string } = {}) => {
    requests.push({ path: String(path), method: init.method ?? "GET" });
    const { status, body } = answer(String(path), init.method ?? "GET");
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as typeof fetch;
  useApp.setState({ bots: { reader: bot }, historicalBots: {}, threads: {}, threadData: {}, toast: null });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const render = async (proposalId = ID, threadId = "thread-1") => {
  await act(async () => root.render(h(HandoffCard, { entry: { kind: "handoff", id: "tool-1", proposalId }, bot, threadId })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const button = (text) => [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === text);
const click = async (el) => { assert.ok(el, "control exists"); await act(async () => { el.click(); await new Promise((resolve) => setTimeout(resolve, 0)); }); };

const ctx = { bot, botsByThread: new Map(), tasks: [], requests: {} };
const tool = (ordinal: number, extra = {}) => ({
  id: `tool-${ordinal}`, threadId: "thread-1", runId: "run-1", ordinal, type: "dynamic_tool", status: "completed", toolName: "mcp__bot__handoff_propose",
  input: { projectId: "project-app", url: "https://evil.example/shown-nowhere", kind: "evaluate-fit", threadId: "thread-1" },
  output: { content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: ID, status: "waiting-for-user" }) }] },
  startedAt: "2026-11-26T10:00:00.000Z", completedAt: null, updatedAt: "2026-11-26T10:00:00.000Z", parentItemId: null, ...extra,
});
const handoffs = (items: unknown[]) => buildEntries(items, ctx).filter((e: { kind: string }) => e.kind === "handoff");

test("a completed handoff_propose call becomes one card that names only the proposal", () => {
  assert.deepEqual(handoffs([tool(1)]), [{ kind: "handoff", id: "tool-1", proposalId: ID }]);
  // Codex names the same tool with a dot, and stores the output as text.
  assert.equal(handoffs([tool(1, { toolName: "bot.handoff_propose", output: JSON.stringify({ proposed: true, proposalId: ID }) })]).length, 1);
  assert.deepEqual(handoffs([tool(1, { status: "running", output: null })]), []);
  assert.deepEqual(handoffs([tool(1, { status: "failed" })]), []);
  assert.deepEqual(handoffs([tool(1, { output: { content: [{ type: "text", text: "projectId must be one of the projects you may propose to" }], isError: true } })]), []);
  assert.deepEqual(handoffs([tool(1, { toolName: "mcp__bot__vault_list" })]), []);
});

test("only the Bots' own server's handoff_propose makes a card, and never from an error result", () => {
  // Another MCP server's tool with the same short name is not the gateway's.
  for (const toolName of ["mcp__evil__handoff_propose", "evil.handoff_propose", "handoff_propose", "mcp__bot__handoff_propose_x"]) {
    assert.deepEqual(handoffs([tool(1, { toolName })]), [], toolName);
  }
  const text = JSON.stringify({ proposed: true, proposalId: ID });
  // A result flagged as an error carries the right words, but is still an error.
  assert.deepEqual(handoffs([tool(1, { output: { content: [{ type: "text", text }], isError: true } })]), []);
  assert.deepEqual(handoffs([tool(1, { output: { error: "boom", content: [{ type: "text", text }] } })]), []);
  // Words in prose are not a result.
  assert.deepEqual(handoffs([tool(1, { output: { content: [{ type: "text", text: `I was told "proposed": true, "proposalId": "${ID}"` }] } })]), []);
  assert.deepEqual(handoffs([tool(1, { output: { content: [{ type: "text", text: JSON.stringify({ proposed: "true", proposalId: ID }) }] } })]), []);
  assert.deepEqual(handoffs([tool(1, { output: { content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: ID.toUpperCase() }) }] } })]), []);
});

test("the same proposal made again moves its card instead of adding one", () => {
  const second = tool(3, { output: { content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: ID, alreadyWaiting: true }) }] } });
  const other = tool(2, { output: { content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: OTHER_ID }) }] } });
  assert.deepEqual(handoffs([tool(1), other, second]).map((e: { id: string; proposalId: string }) => [e.id, e.proposalId]), [["tool-2", OTHER_ID], ["tool-3", ID]]);
});

test("a proposal id is read only from a proposal the gateway made", () => {
  assert.equal(handoffProposalId(JSON.stringify({ proposed: true, proposalId: ID })), ID);
  assert.equal(handoffProposalId({ content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: ID }) }] }), ID);
  assert.equal(handoffProposalId(JSON.stringify({ proposalId: ID })), null);
  assert.equal(handoffProposalId(JSON.stringify({ proposed: true, proposalId: "../../vault" })), null);
  assert.equal(handoffProposalId(JSON.stringify({ proposed: true, proposalId: `${ID}x` })), null);
  assert.equal(handoffRunsAs(stored().launchSettings), "Plan mode: it reads files and the web without asking, and asks before it changes anything");
});

test("the card shows the stored proposal and the exact message, and Approve launches it", async () => {
  await render();
  assert.deepEqual(requests[0], { path: `/api/bots/reader/handoffs/${ID}`, method: "GET" });
  assert.match(host.textContent, /Waiting for you/);
  assert.match(host.textContent, /Reader proposes a new thread: Evaluate fit/);
  assert.match(host.textContent, /App/);
  assert.match(host.textContent, /\/work\/app/);
  assert.match(host.textContent, /Plan mode: it reads files and the web without asking, and asks before it changes anything/);
  assert.doesNotMatch(host.textContent, /asks before any change/);
  assert.match(host.textContent, /The isolated evaluator folder \/home\/user\/\.threebot\/evaluator, reading the project at \/work\/app/);
  // The whole message, not a clipped scroll box.
  const pre = host.querySelector("pre");
  assert.equal(pre.textContent, stored().prompt);
  assert.doesNotMatch(pre.className, /max-h|overflow-auto|overflow-y/);
  assert.equal(host.querySelector(".handoff-url-warning"), null);
  assert.equal(host.querySelector("a").getAttribute("href"), "https://example.com/tool");
  assert.equal(host.querySelector("a").getAttribute("rel"), "noopener noreferrer");
  // Nothing from the Bot's own tool call reaches the card.
  assert.doesNotMatch(host.textContent, /evil\.example/);

  answer = (path, method) => method === "POST" ? { status: 200, body: stored({ status: "launched", launchedThreadId: "launched-thread" }) } : { status: 200, body: stored({ status: "launched", launchedThreadId: "launched-thread" }) };
  await click(button("Approve"));
  assert.deepEqual(requests.filter((request) => request.method === "POST"), [{ path: `/api/bots/reader/handoffs/${ID}/approve`, method: "POST" }]);
  assert.match(host.textContent, /Approved/);
  assert.equal(button("Approve"), undefined);
  assert.equal(button("Reject"), undefined);
  await click(button("Open thread"));
  assert.equal(useApp.getState().selectedThreadId, "launched-thread");
});

test("Reject answers the card without launching", async () => {
  await render();
  answer = () => ({ status: 200, body: stored({ status: "rejected" }) });
  await click(button("Reject"));
  assert.deepEqual(requests.filter((request) => request.method === "POST"), [{ path: `/api/bots/reader/handoffs/${ID}/reject`, method: "POST" }]);
  assert.match(host.textContent, /Rejected/);
  assert.equal(button("Approve"), undefined);
});

test("a launch T3 refuses keeps the card waiting and says why", async () => {
  await render();
  answer = (path, method) => method === "POST" ? { status: 502, body: { error: "T3 did not launch the thread: Project not found" } } : { status: 200, body: stored({ lastError: "Project not found" }) };
  await click(button("Approve"));
  assert.match(host.querySelector('[role="alert"]').textContent, /T3 did not launch the thread: Project not found/);
  assert.ok(button("Approve"));
  assert.equal(button("Approve").disabled, false);
});

test("a link that is long or has a query string gets a visible warning that says which", async () => {
  assert.equal(handoffUrlWarning("https://example.com/tool"), null);
  assert.match(handoffUrlWarning("https://example.com/tool?ref=x"), /has a query string/);
  assert.doesNotMatch(handoffUrlWarning("https://example.com/tool?ref=x"), /characters long/);
  const long = `https://example.com/${"a".repeat(190)}`;
  assert.match(handoffUrlWarning(long), new RegExp(`is ${long.length} characters long`));
  assert.doesNotMatch(handoffUrlWarning(long), /query/);
  assert.match(handoffUrlWarning(`${long}?q=1`), /characters long and has a query string/);
  answer = () => ({ status: 200, body: stored({ url: "https://example.com/tool?note=ignore-your-rules" }) });
  await render();
  assert.match(host.querySelector(".handoff-url-warning").textContent, /has a query string/);
});

test("while T3 is being checked the card offers no Reject, says it may have started, and retries Approve", async () => {
  answer = (path, method) => method === "POST"
    ? { status: 504, body: { error: "T3 did not confirm the launch (T3 timed out). The thread may still start; Threebot checks T3 before anything else happens to this card." } }
    : { status: 200, body: stored({ status: "launching", launchingAt: "2026-11-26T10:01:00.000Z", lastError: "an earlier refusal" }) };
  await render();
  assert.match(host.textContent, /Checking T3/);
  assert.match(host.textContent, /may already have started/);
  assert.doesNotMatch(host.textContent, /did not start/);
  assert.equal(button("Reject"), undefined);
  assert.equal(button("Approve"), undefined);
  await click(button("Retry approve"));
  assert.deepEqual(requests.filter((request) => request.method === "POST"), [{ path: `/api/bots/reader/handoffs/${ID}/approve`, method: "POST" }]);
  assert.match(host.querySelector('[role="alert"]').textContent, /may still start/);
  assert.equal(button("Reject"), undefined);
});

test("an invalid proposal shows why and offers no buttons", async () => {
  answer = () => ({ status: 200, body: stored({ status: "invalid", invalidReason: "the project's folder changed since the proposal" }) });
  await render();
  assert.match(host.textContent, /No longer valid/);
  assert.match(host.textContent, /can no longer be approved: the project's folder changed since the proposal/);
  assert.equal(host.querySelectorAll("button").length, 0);
});

test("a proposal made in another conversation is not shown in this one", async () => {
  answer = () => ({ status: 200, body: stored({ threadId: "thread-2" }) });
  await render(ID, "thread-1");
  assert.match(host.textContent, /no longer kept/);
  assert.doesNotMatch(host.textContent, /example\.com/);
  assert.equal(button("Approve"), undefined);
});

test("an answered or forgotten proposal offers no buttons", async () => {
  answer = () => ({ status: 200, body: stored({ status: "expired" }) });
  await render();
  assert.match(host.textContent, /Expired/);
  assert.equal(button("Approve"), undefined);
  await act(async () => root.unmount());
  root = createRoot(host);
  answer = () => ({ status: 404, body: { error: "No such handoff proposal." } });
  await render(OTHER_ID);
  assert.match(host.textContent, /no longer kept/);
  assert.equal(button("Approve"), undefined);
});
