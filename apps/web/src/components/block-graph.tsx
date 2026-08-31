import type { BlockGraph as BlockGraphModel, GraphRow } from "@repo/core";
import { layoutGraph } from "@repo/core";
import { viewFor } from "@/blocks/views";

const LANE_WIDTH = 18;
const ROW_HEIGHT = 34;
const NODE_RADIUS = 3.5;

/** Lanes cycle through these so branches stay distinguishable. */
const LANE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] as string;
}

/** Rail geometry for one line: verticals, merge/branch curves, and the node. */
function Rail({ row, width }: { row: GraphRow; width: number }) {
  const mid = ROW_HEIGHT / 2;
  const x = laneX(row.lane);
  const paths: { d: string; lane: number }[] = [];

  for (const lane of row.spines) {
    const sx = laneX(lane);
    const endsHere = row.spineEnds.includes(lane);
    paths.push({ d: `M ${sx} 0 L ${sx} ${endsHere ? mid : ROW_HEIGHT}`, lane });
  }

  for (const lane of row.verticals) {
    const vx = laneX(lane);
    paths.push({ d: `M ${vx} 0 L ${vx} ${ROW_HEIGHT}`, lane });
  }

  if (row.continuesUp) {
    paths.push({ d: `M ${x} 0 L ${x} ${mid}`, lane: row.lane });
  }
  if (row.continuesDown) {
    paths.push({ d: `M ${x} ${mid} L ${x} ${ROW_HEIGHT}`, lane: row.lane });
  }

  // Extra parents curve in from their lane above.
  for (const lane of row.merges) {
    const mx = laneX(lane);
    paths.push({
      d: `M ${mx} 0 L ${mx} ${mid * 0.5} Q ${mx} ${mid} ${x} ${mid}`,
      lane,
    });
  }

  // Extra children and nested groups curve out toward their lane below.
  for (const lane of row.branches) {
    const bx = laneX(lane);
    paths.push({
      d: `M ${x} ${mid} Q ${bx} ${mid} ${bx} ${mid * 1.5} L ${bx} ${ROW_HEIGHT}`,
      lane,
    });
  }

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      className="shrink-0 overflow-visible"
      aria-hidden
    >
      {paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill="none"
          stroke={laneColor(path.lane)}
          strokeWidth={1.5}
          strokeOpacity={0.55}
        />
      ))}
      <circle
        cx={x}
        cy={mid}
        r={NODE_RADIUS}
        fill={laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={1.5}
      />
    </svg>
  );
}

export function BlockGraph({
  graph,
  className,
}: {
  graph: BlockGraphModel;
  className?: string;
}) {
  const { rows, laneCount } = layoutGraph(graph);
  const railWidth = laneCount * LANE_WIDTH + LANE_WIDTH;

  return (
    <div className={className}>
      {rows.map((row) => {
        const view = viewFor(row.block);
        return (
          <div
            key={row.block.id}
            // Rail geometry is fixed per line, so inline content taller than a
            // row (media previews) is clipped here rather than pushing the
            // rails out of alignment. Chat is where media is meant to be read.
            className="flex items-center gap-3 overflow-hidden"
            style={{ height: ROW_HEIGHT }}
          >
            <Rail row={row} width={railWidth} />
            <span className="w-[5.5rem] shrink-0 tabular-nums text-muted-foreground">
              {new Date(row.block.createdAt).toISOString().slice(11, 23)}
            </span>
            <span className="w-32 shrink-0 truncate font-medium">
              {row.block.label}
            </span>
            <view.Row block={row.block} />
          </div>
        );
      })}
    </div>
  );
}
