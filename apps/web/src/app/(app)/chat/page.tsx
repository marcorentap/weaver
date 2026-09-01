import type { BlockGraph } from "@repo/core";
import { getStore } from "@/lib/store";
import { chatNodes } from "@/lib/graph-view";
import { ChatView } from "./chat-view";

// Reads a live database, so it must never be prerendered.
export const dynamic = "force-dynamic";

const EMPTY: BlockGraph = { blocks: {} };

export default async function ChatPage({ searchParams }: PageProps<"/chat">) {
  const { session } = await searchParams;
  const store = getStore();

  // A session is a graph; "recent" is its last write.
  const sessions = store
    .listGraphs()
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .map(({ id, name, modifiedAt }) => ({ id, name, modifiedAt }));

  const wanted = typeof session === "string" ? session : sessions[0]?.name;
  const active = wanted ? store.findGraph(wanted) : undefined;
  const graph = active ? store.loadGraph(active.id) : EMPTY;

  return (
    // Keyed by session id: switching sessions is a different graph entirely,
    // so the client's own live state (blocks, cursor, expanded rows) should
    // reset rather than carry over — remounting is the simplest way to do
    // that reliably.
    <ChatView
      key={active?.id ?? "none"}
      sessions={sessions}
      session={active ? { id: active.id, name: active.name } : null}
      nodes={chatNodes(graph)}
    />
  );
}
