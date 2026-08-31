import Link from "next/link";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default function GraphsPreview() {
  const graphs = getStore().listGraphs();

  return (
    <div className="p-8 space-y-4">
      <h1 className="font-semibold">graphs</h1>
      {graphs.length === 0 ? (
        <p className="text-muted-foreground">
          No graphs yet. Visit{" "}
          <Link className="underline" href="/dev/blocks">
            /dev/blocks
          </Link>{" "}
          to create one.
        </p>
      ) : (
        <ul className="space-y-1">
          {graphs.map((graph) => (
            <li key={graph.id} className="flex gap-3">
              <span className="w-16 shrink-0 font-medium">{graph.name}</span>
              <span className="shrink-0 text-muted-foreground">{graph.id}</span>
              <span className="text-muted-foreground">
                modified {new Date(graph.modifiedAt).toISOString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
