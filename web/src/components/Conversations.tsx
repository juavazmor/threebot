import { useEffect, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/projects";
import type { Bot, Conversation } from "../lib/types";
import { openDialog, removeConversation, startConversation, switchConversation, useApp } from "../store";
import { IconButton, Modal, Pill, Spinner } from "./ui";

/** A row's label: T3's title when it says more than the Bot's name, else the latest message. */
export function conversationLabel(conversation: Conversation, bot: Pick<Bot, "name">) {
  const titled = conversation.title && conversation.title !== bot.name && conversation.title !== "Conversation";
  return titled ? conversation.title : conversation.preview || "New conversation";
}

/** The Bot's conversations, newest activity first: tap one to make it the Bot's chat again. */
export function ConversationsDialog({ slug }: { slug: string }) {
  const bot = useApp((s) => s.bots[slug]);
  const [list, setList] = useState<Conversation[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const close = () => { if (!busy) openDialog(null); };
  const load = () => api.conversations(slug).then((items) => { setList(items); setError(""); }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  // The list follows the active conversation, also when another device switches it.
  useEffect(() => { void load(); }, [slug, bot?.mainThreadId, bot?.conversationThreadIds?.length]);
  if (!bot) return null;
  const run = async (key: string, action: () => Promise<unknown>, done = true) => {
    setBusy(key);
    setError("");
    try {
      await action();
      if (done) openDialog(null);
      else await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const fresh = <Pill onClick={() => void run("new", () => startConversation(slug))} disabled={!!busy} aria-label="New conversation">
    {busy === "new" ? <Spinner /> : <MessageSquarePlus size={14} aria-hidden="true" />} New
  </Pill>;
  return (
    <Modal title="Conversations" onClose={close} onBack={close} className="conversations-sheet w-[420px] max-w-full" headerActions={fresh}>
      <div className="dialog-body min-h-0 overflow-y-auto p-2">
        {error && <p role="alert" className="mx-2 my-2 text-[13px] text-danger">{error}</p>}
        {!list && !error && <div className="flex justify-center py-8 text-muted"><Spinner size={18} /></div>}
        {list && <ul aria-label={`${bot.name}'s conversations`} className="space-y-0.5">
          {list.map((conversation) => (
            <li key={conversation.id} className="group flex items-center gap-1">
              <button
                type="button"
                disabled={!!busy || conversation.missing}
                aria-current={conversation.active ? "true" : undefined}
                onClick={() => conversation.active ? close() : void run(conversation.id, () => switchConversation(slug, conversation.id))}
                className={`flex min-h-12 min-w-0 flex-1 flex-col justify-center rounded-xl px-3 py-2 text-left disabled:opacity-60 ${conversation.active ? "bg-active" : "hover:bg-hover"}`}
              >
                <span className="truncate text-[14px]">{conversationLabel(conversation, bot)}</span>
                <span className="truncate text-[12px] text-muted">
                  {conversation.active ? "Active · " : ""}
                  {conversation.missing ? "No longer in T3 Code" : conversation.lastActivityAt ? timeAgo(conversation.lastActivityAt) : "No messages yet"}
                  {conversation.archived ? " · Archived in T3 Code" : ""}
                </span>
              </button>
              {busy === conversation.id ? <span className="grid size-9 place-items-center"><Spinner /></span> : !conversation.active && (
                <IconButton disabled={!!busy} onClick={() => void run(conversation.id, () => removeConversation(slug, conversation.id), false)} aria-label="Remove from this list" title="Remove from this list (the thread stays in T3 Code)">
                  <X size={14} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>}
      </div>
    </Modal>
  );
}
