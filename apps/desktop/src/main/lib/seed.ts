import type { BlockData } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { newId } from "@repo/store";
import { GROUP_KIND, TEXT_KIND } from "@repo/core";
import { USER_KIND } from "../../shared/blocks/user.js";
import { METRIC_KIND } from "../../shared/blocks/kinds.js";
import { MEDIA_KIND } from "../../shared/blocks/media.js";

const t0 = Date.parse("2026-08-31T09:00:00.000Z");

/**
 * The seed is authored as the tree it renders as, with order as position in
 * the list and nesting as nesting, then flattened into linked blocks below.
 */
type SeedNode = {
  kind: string;
  label: string;
  data?: BlockData;
  children?: SeedNode[];
};

const tree: SeedNode[] = [
  {
    kind: TEXT_KIND,
    label: "system",
    data: { text: "You are a graphical agent harness." },
  },
  {
    kind: TEXT_KIND,
    label: "env",
    data: { text: "cwd=/home/marcorentap/projects/weaver" },
  },
  {
    kind: METRIC_KIND,
    label: "context",
    data: { value: 4820, limit: 8192, unit: "tok" },
  },

  // Group nesting text blocks.
  {
    kind: GROUP_KIND,
    label: "tools",
    children: [
      {
        kind: TEXT_KIND,
        label: "read",
        data: { text: "read(path) -> string" },
      },
      {
        kind: TEXT_KIND,
        label: "write",
        data: { text: "write(path, content) -> void" },
      },
      {
        kind: TEXT_KIND,
        label: "grep",
        data: { text: "grep(pattern, path) -> match[]" },
      },
    ],
  },

  // Nesting two levels deep with a custom kind at the leaves.
  {
    kind: GROUP_KIND,
    label: "repo",
    children: [
      {
        kind: TEXT_KIND,
        label: "map",
        data: { text: "apps/desktop, packages/core, packages/store" },
      },
      {
        kind: GROUP_KIND,
        label: "files",
        children: [
          {
            kind: MEDIA_KIND,
            label: "fs.js",
            data: {
              uri: "https://raw.githubusercontent.com/nodejs/node/6f41e415639b5ec3dd816e44945cc73b4d7651e3/lib/fs.js",
            },
          },
          {
            kind: MEDIA_KIND,
            label: "path.js",
            data: {
              uri: "https://raw.githubusercontent.com/nodejs/node/6f41e415639b5ec3dd816e44945cc73b4d7651e3/lib/path.js",
            },
          },
        ],
      },
    ],
  },

  // Metric blocks with their own state schema, nested in a group.
  {
    kind: GROUP_KIND,
    label: "usage",
    children: [
      {
        kind: METRIC_KIND,
        label: "prompt",
        data: { value: 3180, limit: 8192, unit: "tok" },
      },
      {
        kind: METRIC_KIND,
        label: "output",
        data: { value: 640, limit: 4096, unit: "tok" },
      },
    ],
  },

  // Media, addressed by URI: one per detected type. Everything is fetched over
  // https, so the repo carries no sample binaries.
  {
    kind: MEDIA_KIND,
    label: "example.svg",
    data: {
      uri: "https://upload.wikimedia.org/wikipedia/commons/8/84/Example.svg",
    },
  },
  {
    kind: MEDIA_KIND,
    label: "flower.jpg",
    data: {
      uri: "https://upload.wikimedia.org/wikipedia/commons/3/3f/JPEG_example_flower.jpg",
    },
  },
  {
    kind: MEDIA_KIND,
    label: "loop.gif",
    data: {
      // Query string on purpose: type detection reads the path, not the URL.
      uri: "https://d2w9rnfcy7mm78.cloudfront.net/33694363/original_c60302cccf34b1629d37c73184dbacb2.gif?1736943050?bc=0",
    },
  },
  {
    kind: MEDIA_KIND,
    label: "lava.webm",
    data: {
      uri: "https://upload.wikimedia.org/wikipedia/commons/transcoded/2/22/Volcano_Lava_Sample.webm/Volcano_Lava_Sample.webm.360p.vp9.webm",
    },
  },
  {
    kind: MEDIA_KIND,
    label: "sample.wav",
    data: { uri: "https://download.samplelib.com/wav/sample-3s.wav" },
  },
  {
    kind: MEDIA_KIND,
    label: "example.pdf",
    data: {
      uri: "https://upload.wikimedia.org/wikipedia/commons/1/13/Example.pdf",
    },
  },
  {
    kind: MEDIA_KIND,
    label: "rfc2119.txt",
    data: { uri: "https://www.rfc-editor.org/rfc/rfc2119.txt" },
  },
  {
    kind: MEDIA_KIND,
    label: "readme.md",
    data: {
      uri: "https://raw.githubusercontent.com/nodejs/node/6f41e415639b5ec3dd816e44945cc73b4d7651e3/README.md",
    },
  },
  {
    kind: MEDIA_KIND,
    label: "bunny.ogv",
    data: {
      // Unlisted extension, so this is the fallback row and preview.
      uri: "https://upload.wikimedia.org/wikipedia/commons/7/79/Big_Buck_Bunny_small.ogv",
    },
  },

  // appended right after it, using everything above as context.
  {
    kind: USER_KIND,
    label: "user",
    data: {
      text: "In one sentence, summarize what this graph of context blocks describes.",
    },
  },
];

/** Blocks for a fresh graph: ids minted, chains linked. */
export function seedBlocks(): BlockInput[] {
  const ids = new Map<SeedNode, string>();

  const mint = (nodes: SeedNode[]) => {
    for (const node of nodes) {
      ids.set(node, newId());
      mint(node.children ?? []);
    }
  };
  mint(tree);

  const idOf = (node: SeedNode | undefined): string | null => {
    if (!node) return null;
    const id = ids.get(node);
    if (!id) throw new Error(`seed node was never minted: ${node.label}`);
    return id;
  };

  const inputs: BlockInput[] = [];
  let createdAt = t0;

  const emit = (nodes: SeedNode[]) => {
    nodes.forEach((node, at) => {
      inputs.push({
        id: idOf(node) as string,
        kind: node.kind,
        label: node.label,
        createdAt: (createdAt += 1000),
        next: idOf(nodes[at + 1]),
        children: idOf(node.children?.[0]),
        data: node.data,
      });
      emit(node.children ?? []);
    });
  };
  emit(tree);

  return inputs;
}
