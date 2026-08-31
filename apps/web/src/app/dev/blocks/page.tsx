import { snapshotGraph } from "@repo/core";
import { defaultStorePath } from "@repo/store";
import { BlockGraph } from "@/components/block-graph";
import { kinds } from "@/blocks/kinds";
import { getStore } from "@/lib/store";
import { devSeedBlocks } from "./seed";

// Reads a live database, so it must never be prerendered.
export const dynamic = "force-dynamic";

/** The store holds many graphs; this page owns the one named "dev". */
const DEV_GRAPH = "dev";

export default function BlocksPreview() {
  const store = getStore();
  const record = store.findGraph(DEV_GRAPH) ?? store.createGraph(DEV_GRAPH);
  if (store.countBlocks(record.id) === 0) {
    store.putBlocks(record.id, devSeedBlocks());
  }
  const graph = store.loadGraph(record.id);

  return (
    <div className="p-8 space-y-8">
      <header className="space-y-1">
        <h1 className="font-semibold">Blocks</h1>
        <p className="text-muted-foreground">
          Context block DAG in topological order, created time as tiebreaker.
          One block per line; nesting branches to the right.
        </p>
        <p className="text-muted-foreground">
          graph {record.name} · {record.id} ·{" "}
          {Object.keys(graph.blocks).length} blocks · {defaultStorePath()}
        </p>
      </header>

      <BlockGraph graph={graph} />

      <section className="space-y-2">
        <h2 className="font-semibold">Snapshot</h2>
        <p className="text-muted-foreground">
          What the graph flattens to when the LLM is called.
        </p>
        <pre className="whitespace-pre-wrap rounded-md border p-4">
          {snapshotGraph(graph, kinds)}
        </pre>
      </section>
    </div>
  );
}
