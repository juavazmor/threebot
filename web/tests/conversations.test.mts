import assert from 'node:assert/strict';
import { buildOnce, entryChunk } from './support.mts';
import { beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from "node:url";

const source = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: 'silent',
  plugins: [{
    name: 'conversations-test-entry',
    resolveId: (id) => id.endsWith('virtual:conversations-test') ? '\0conversations-test' : undefined,
    load: (id) => id === '\0conversations-test'
      ? `export { startConversation, switchConversation, removeConversation, useApp } from ${JSON.stringify(source('store.ts'))}; export { api } from ${JSON.stringify(source('lib/api.ts'))}; export { t3 } from ${JSON.stringify(source('lib/t3.ts'))}; export { conversationIdsOf, isConversationOf, isEarlierConversation } from ${JSON.stringify(source('lib/conversations.ts'))}; export { conversationLabel } from ${JSON.stringify(source('components/Conversations.tsx'))};`
      : undefined,
  }],
  ssr: { noExternal: true }, build: { ssr: 'virtual:conversations-test', write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
const { startConversation, switchConversation, removeConversation, useApp, api, t3, conversationIdsOf, isConversationOf, isEarlierConversation, conversationLabel } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);

const alpha = (mainThreadId: string, conversationThreadIds: string[]) => ({ slug: 'alpha', name: 'Alpha', primary: true, hidden: false, pinned: false, projectId: 'project-alpha', mainThreadId, conversationThreadIds });

beforeEach(() => {
  mock.restoreAll();
  mock.method(t3, 'dispatch', async () => ({}));
  mock.method(t3, 'call', async () => ({ threads: [] }));
  mock.method(api, 'threadPreviews', async () => ({}));
  useApp.setState({ bots: { alpha: alpha('thread-1', ['thread-1']) }, historicalBots: {}, selected: 'alpha', selectedThreadId: null, threads: {}, previews: {} });
});

test('a new conversation becomes the Bot\'s chat: the main view, not a child one', async () => {
  mock.method(api, 'newConversation', async () => alpha('thread-2', ['thread-1', 'thread-2']));
  await startConversation('alpha');
  const state = useApp.getState();
  assert.equal(state.bots.alpha.mainThreadId, 'thread-2');
  assert.equal(state.selected, 'alpha');
  assert.equal(state.selectedThreadId, null, 'the active conversation is shown as the Bot itself');
});

test('switching to an earlier conversation opened from a link makes it the main view', async () => {
  useApp.setState({ bots: { alpha: alpha('thread-2', ['thread-1', 'thread-2']) }, selectedThreadId: 'thread-1' });
  const request = mock.method(api, 'activateConversation', async () => alpha('thread-1', ['thread-1', 'thread-2']));
  await switchConversation('alpha', 'thread-1');
  assert.deepEqual(request.mock.calls[0].arguments, ['alpha', 'thread-1']);
  assert.equal(useApp.getState().bots.alpha.mainThreadId, 'thread-1');
  assert.equal(useApp.getState().selectedThreadId, null);
});

test('a refused switch leaves the Bot as it was', async () => {
  mock.method(api, 'activateConversation', async () => { throw new Error('T3 no longer has that conversation.'); });
  await assert.rejects(switchConversation('alpha', 'thread-0'), /no longer/);
  assert.equal(useApp.getState().bots.alpha.mainThreadId, 'thread-1');
});

test('removing the conversation on screen goes back to the active one', async () => {
  useApp.setState({ bots: { alpha: alpha('thread-2', ['thread-1', 'thread-2']) }, selectedThreadId: 'thread-1' });
  mock.method(api, 'removeConversation', async () => alpha('thread-2', ['thread-2']));
  await removeConversation('alpha', 'thread-1');
  assert.deepEqual(useApp.getState().bots.alpha.conversationThreadIds, ['thread-2']);
  assert.equal(useApp.getState().selectedThreadId, null);
});

test('conversation helpers: an older gateway\'s Bot has its main thread as its one conversation', () => {
  assert.deepEqual(conversationIdsOf({ mainThreadId: 'thread-1' }), ['thread-1']);
  assert.deepEqual(conversationIdsOf({ mainThreadId: 'thread-2', conversationThreadIds: ['thread-1'] }), ['thread-1', 'thread-2']);
  const bot = alpha('thread-2', ['thread-1', 'thread-2']);
  assert.equal(isConversationOf(bot, 'thread-1'), true);
  assert.equal(isConversationOf(bot, 'child'), false);
  assert.equal(isEarlierConversation(bot, 'thread-1'), true);
  assert.equal(isEarlierConversation(bot, 'thread-2'), false);
});

test('a row says what the conversation is about when T3 only titled it with the Bot\'s name', () => {
  const row = { id: 'x', title: 'Alpha', preview: 'Booked Thursday 7pm', createdAt: null, lastActivityAt: null, active: false, archived: false, missing: false };
  assert.equal(conversationLabel(row, { name: 'Alpha' }), 'Booked Thursday 7pm');
  assert.equal(conversationLabel({ ...row, title: 'Weekly booking' }, { name: 'Alpha' }), 'Weekly booking');
  assert.equal(conversationLabel({ ...row, preview: '' }, { name: 'Alpha' }), 'New conversation');
});
