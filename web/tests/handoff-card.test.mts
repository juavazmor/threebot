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
      export { handoffProposalId, handoffRunsAs } from ${JSON.stringify(`${src}lib/handoffs.ts`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:handoff-card-tests", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const testDir = await mkdtemp(join(tmpdir(), "bot-handoff-card-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entry.code);
const { createElement: h, act, createRoot, HandoffCard, buildEntries, handoffProposalId, handoffRunsAs, useApp } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });

const ID = "0f5c2a9e-6f0b-4a53-9a43-1d2b3c4d5e6f";
const OTHER_ID = "1a2b3c4d-0000-4000-8000-aabbccddeeff";
const bot = { slug: "reader", name: "Reader", mainThreadId: "thread-1", shape: "blob", color: "teal", workspaceRoot: "/bots/reader" };
const stored = (extra = {}) => ({
  id: ID, botSlug: "reader", botName: "Reader", threadId: "thread-1", projectId: "project-app", projectTitle: "App", projectPath: "/work/app",
  kind: "evaluate-fit", kindLabel: "Evaluate fit", url: "https://example.com/tool", title: "Evaluate fit: example.com",
  prompt: "Handoff from Reader.\n\nLink: https://example.com/tool\n\nRules:\n- Investigate only.", status: "pending", createdAt: "2026-11-26T10:00:00.000Z",
  launchSettings: { runtimeMode: "approval-required", interactionMode: "plan", workspaceStrategy: { type: "root" } }, ...extra,
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
const render = async (proposalId = ID) => {
  await act(async () => root.render(h(HandoffCard, { entry: { kind: "handoff", id: "tool-1", proposalId }, bot })));
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

test("the same proposal made again moves its card instead of adding one", () => {
  const second = tool(3, { output: { content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: ID, alreadyWaiting: true }) }] } });
  const other = tool(2, { output: { content: [{ type: "text", text: JSON.stringify({ proposed: true, proposalId: OTHER_ID }) }] } });
  assert.deepEqual(handoffs([tool(1), other, second]).map((e: { id: string; proposalId: string }) => [e.id, e.proposalId]), [["tool-2", OTHER_ID], ["tool-3", ID]]);
});

test("a proposal id is read only from a proposal the gateway made", () => {
  assert.equal(handoffProposalId(JSON.stringify({ proposed: true, proposalId: ID })), ID);
  assert.equal(handoffProposalId(JSON.stringify({ proposalId: ID })), null);
  assert.equal(handoffProposalId(JSON.stringify({ proposed: true, proposalId: "../../vault" })), null);
  assert.equal(handoffRunsAs(stored().launchSettings), "Plan mode: it reads and looks things up on its own, and asks before any change, in the project's folder");
});

test("the card shows the stored proposal and the exact message, and Approve launches it", async () => {
  await render();
  assert.deepEqual(requests[0], { path: `/api/bots/reader/handoffs/${ID}`, method: "GET" });
  assert.match(host.textContent, /Waiting for you/);
  assert.match(host.textContent, /Reader proposes a new thread: Evaluate fit/);
  assert.match(host.textContent, /App/);
  assert.match(host.textContent, /\/work\/app/);
  assert.match(host.textContent, /Plan mode: it reads and looks things up on its own, and asks before any change, in the project's folder/);
  assert.equal(host.querySelector("pre").textContent, stored().prompt);
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
  answer = (path, method) => method === "POST" ? { status: 502, body: { error: "T3 did not launch the thread: T3 timed out" } } : { status: 200, body: stored({ lastError: "T3 timed out" }) };
  await click(button("Approve"));
  assert.match(host.querySelector('[role="alert"]').textContent, /T3 did not launch the thread: T3 timed out/);
  assert.ok(button("Approve"));
  assert.equal(button("Approve").disabled, false);
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
