import type { BlockGraph, BlockId } from "@repo/core";
import { getBlock, topLevelBlockIds, topoSort } from "@repo/core";
import { getStore } from "@/lib/store";
import type { ChatNode } from "./chat-view";
import { ChatView } from "./chat-view";

// Reads a live database, so it must never be prerendered.
export const dynamic = "force-dynamic";

const EMPTY: BlockGraph = { blocks: {} };

/**
 * Containment tree in render order. Ordering stays on the server, where the
 * whole graph lives, so the client only decides what is currently unfolded.
 */
function chatNodes(graph: BlockGraph, ids: BlockId[]): ChatNode[] {
  return topoSort(graph, ids).map((id) => {
    const block = getBlock(graph, id);
    return { block, children: chatNodes(graph, block.children) };
  });
}

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
    <ChatView
      sessions={sessions}
      session={active ? { id: active.id, name: active.name } : null}
      nodes={chatNodes(graph, topLevelBlockIds(graph))}
      total={Object.keys(graph.blocks).length}
    />
  );
}
