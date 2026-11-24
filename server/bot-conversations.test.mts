import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { conversationList, createConversationRoutes, type ConversationShell } from "./bot-conversations.mts";
import { createMainBotRegistry } from "./main-bot.mts";

type FakeResponse = { status: number; body: any };
type FakeRequest = { method: string; headers: IncomingHttpHeaders };

const request = (method = "GET", { json = true, origin = "https://bot.example" }: { json?: boolean; origin?: string } = {}): FakeRequest => ({
  method, headers: { host: "bot.example", origin, ...(json ? { "content-type": "application/json" } : {}) },
});

async function setup(t: TestContext, meta: Record<string, unknown> = {}) {
  const botsRoot = await mkdtemp(path.join(tmpdir(), "bot-conversations-"));
  t.after(() => rm(botsRoot, { recursive: true, force: true }));
  await mkdir(path.join(botsRoot, "alpha", ".bot"), { recursive: true });
  await writeFile(path.join(botsRoot, "alpha", ".bot", "bot.json"), JSON.stringify({ name: "Alpha", projectId: "project-alpha", mainThreadId: "thread-1", createdAt: "2026-01-01T00:00:00Z", ...meta }));
  const changed: string[] = [];
  const registry = createMainBotRegistry({ botsRoot, onBotChanged: async (bot) => { changed.push(`${bot.slug}:${bot.mainThreadId}`); } });
  const shells: ConversationShell[] = [
    { id: "thread-1", title: "Alpha", createdAt: "2026-01-01T00:00:00Z", latestVisibleMessage: { text: "Booked  the\nclass", updatedAt: "2026-01-03T00:00:00Z" } },
    { id: "users-own", title: "User work", createdAt: "2026-01-05T00:00:00Z" },
  ];
  const calls: { tag: string; payload: any }[] = [];
  const rpc = {
    async call(tag: string, payload: any): Promise<unknown> {
      calls.push({ tag, payload });
      if (tag === "orchestration.getThreadProjection") return { thread: { runtimeMode: "approval-required", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } } };
      if (tag === "orchestration.launchThread") shells.push({ id: payload.threadId, title: payload.title, createdAt: "2026-01-10T00:00:00Z" });
      return {};
    },
  };
  const routes = createConversationRoutes<FakeRequest, FakeResponse>({
    getBot: (slug) => registry.get(slug),
    update: (slug, change) => registry.update(slug, change),
    rpc,
    threads: async () => shells,
    defaults: async () => ({ runtimeMode: "auto" }),
    send: (res, status, body) => { res.status = status; res.body = body; },
    requireJson: (req) => { if (!/^application\/json/.test(String(req.headers["content-type"] ?? ""))) throw Object.assign(new Error("content-type must be application/json"), { status: 415 }); },
    checkOrigin: (req) => req.headers.origin === "https://bot.example",
  });
  const call = async (method: string, route: string, options?: { json?: boolean; origin?: string }) => {
    const res: FakeResponse = { status: 0, body: null };
    const handled = await routes.handle(request(method, options), res, new URL(route, "https://bot.example"));
    return { handled, ...res };
  };
  return { call, calls, registry, changed, shells };
}

test("a new conversation is launched like the main one, in the Bot's project, and becomes active", async (t) => {
  const { call, calls, registry, changed } = await setup(t);
  const created = await call("POST", "/api/bots/alpha/conversations");
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const launch = calls.find((entry) => entry.tag === "orchestration.launchThread")!.payload;
  assert.equal(launch.projectId, "project-alpha");
  assert.equal(launch.title, "Alpha");
  assert.deepEqual(launch.workspaceStrategy, { type: "root" });
  assert.equal(launch.interactionMode, "default");
  // What the Bot may do and which model answers carry over from the conversation in use.
  assert.equal(launch.runtimeMode, "approval-required");
  assert.deepEqual(launch.modelSelection, { instanceId: "codex", model: "gpt-6.1-sol" });
  assert.equal(created.body.mainThreadId, launch.threadId);
  assert.deepEqual(created.body.conversationThreadIds, ["thread-1", launch.threadId]);
  // Saved through the registry, so the Bot's instructions name the new conversation.
  assert.equal(changed.at(-1), `alpha:${launch.threadId}`);
  assert.equal((await registry.get("alpha"))!.mainThreadId, launch.threadId);
});

test("the list holds only the Bot's own conversations, newest activity first, with the active one marked", async (t) => {
  const { call } = await setup(t, { conversationThreadIds: ["thread-0", "thread-1"] });
  const created = await call("POST", "/api/bots/alpha/conversations");
  const listed = await call("GET", "/api/bots/alpha/conversations");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.conversations.map((item: any) => [item.id, item.active, item.missing]), [
    [created.body.mainThreadId, true, false],
    ["thread-1", false, false],
    ["thread-0", false, true],
  ]);
  const first = listed.body.conversations.find((item: any) => item.id === "thread-1");
  assert.deepEqual([first.title, first.preview, first.lastActivityAt], ["Alpha", "Booked the class", "2026-01-03T00:00:00Z"]);
});

test("switching only accepts the Bot's own conversations that T3 still has", async (t) => {
  const { call } = await setup(t, { conversationThreadIds: ["thread-0", "thread-1"] });
  const created = await call("POST", "/api/bots/alpha/conversations");
  const back = await call("POST", "/api/bots/alpha/conversations/thread-1/activate");
  assert.equal(back.status, 200);
  assert.deepEqual([back.body.mainThreadId, back.body.conversationThreadIds], ["thread-1", ["thread-0", "thread-1", created.body.mainThreadId]]);
  assert.equal((await call("POST", "/api/bots/alpha/conversations/users-own/activate")).status, 404, "a thread the Bot never started");
  assert.equal((await call("POST", "/api/bots/alpha/conversations/thread-0/activate")).status, 409, "gone from T3");
  assert.equal((await call("POST", "/api/bots/nobody/conversations")).status, 404);
});

test("a conversation leaves the list unless it is the active one; the T3 thread is kept", async (t) => {
  const { call, calls } = await setup(t, { conversationThreadIds: ["thread-0", "thread-1"] });
  assert.equal((await call("DELETE", "/api/bots/alpha/conversations/thread-1")).status, 409);
  const removed = await call("DELETE", "/api/bots/alpha/conversations/thread-0");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.conversationThreadIds, ["thread-1"]);
  assert.ok(!calls.some((entry) => entry.tag !== "orchestration.getThreadProjection"), "nothing is deleted in T3");
});

test("writes need JSON from the app's own origin; other paths are not these routes", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("POST", "/api/bots/alpha/conversations", { json: false })).status, 415);
  assert.equal((await call("POST", "/api/bots/alpha/conversations", { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("PUT", "/api/bots/alpha/conversations")).status, 405);
  assert.equal((await call("GET", "/api/bots/alpha")).handled, false);
});

test("a Bot with no project can't start a conversation", async (t) => {
  const { call } = await setup(t, { projectId: null });
  assert.equal((await call("POST", "/api/bots/alpha/conversations")).status, 409);
});

test("conversationList puts never-used conversations last", () => {
  const list = conversationList({ mainThreadId: "b", conversationThreadIds: ["a", "b"] }, [{ id: "b", createdAt: "2026-02-01T00:00:00Z" }]);
  assert.deepEqual(list.map((item) => item.id), ["b", "a"]);
});
