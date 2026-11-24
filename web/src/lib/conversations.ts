import type { Bot } from "./types";

/** A Bot's conversations, the active one included; an older gateway only knows the active one. */
export function conversationIdsOf(bot: Pick<Bot, "mainThreadId" | "conversationThreadIds">): string[] {
  const ids = [...(bot.conversationThreadIds ?? [])];
  if (bot.mainThreadId && !ids.includes(bot.mainThreadId)) ids.push(bot.mainThreadId);
  return ids;
}

/** Whether a thread is one of the Bot's conversations (active or earlier), not a child or a routine's own. */
export function isConversationOf(bot: Pick<Bot, "mainThreadId" | "conversationThreadIds">, threadId: string | null | undefined): boolean {
  return !!threadId && conversationIdsOf(bot).includes(threadId);
}

/** An earlier conversation: the Bot's, but not the one in use. */
export function isEarlierConversation(bot: Pick<Bot, "mainThreadId" | "conversationThreadIds">, threadId: string | null | undefined): boolean {
  return isConversationOf(bot, threadId) && threadId !== bot.mainThreadId;
}
