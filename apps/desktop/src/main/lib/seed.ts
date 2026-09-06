import type { BlockData } from "@repo/core";
import type { BlockInput } from "@repo/store";
import { newId } from "@repo/store";
import { GROUP_KIND, TEXT_KIND } from "@repo/core";
import { MEDIA_KIND } from "@plugins/rich-media";

const t0 = Date.parse("2026-09-06T00:00:00.000Z");

/**
 * The seed is authored as the tree it renders as, with order as position in
 * the list and nesting as nesting, then flattened into linked blocks below.
 *
 * It is a user-facing tour of the graph, not context for a model: blocks say
 * what a block is, then show it with concrete examples, from a snippet of
 * markdown to a nested group and inline media of every kind. The rich-media
 * plugin supplies the media and code-file examples below; those kinds are
 * bundled, so a fresh install always has them.
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
    label: "intro",
    data: {
      text: "This is your Weaver graph. The chat is a tree of blocks, and every block is context. The tour that follows shows what a graph can hold, top to bottom, and it ends with a prompt you can run inference on.",
    },
  },

  {
    kind: TEXT_KIND,
    label: "text",
    data: {
      text: "Most blocks are Text, a chunk of markdown rendered in place. The block you're reading is one. A denser block, like this:",
    },
  },

  {
    kind: TEXT_KIND,
    label: "markdown",
    data: {
      text: [
        "# A heading",
        "",
        "A paragraph with **bold**, *emphasis*, and `inline code`.",
        "",
        "> A blockquote.",
        "",
        "- a bullet list",
        "- another item",
      ].join("\n"),
    },
  },

  {
    kind: TEXT_KIND,
    label: "group",
    data: {
      text: "A Group block has no prose of its own; its children are its content. Nesting is how one block holds a whole branch. Like this:",
    },
  },

  {
    kind: GROUP_KIND,
    label: "nesting",
    children: [
      {
        kind: TEXT_KIND,
        label: "one",
        data: { text: "a nested block" },
      },
      {
        kind: TEXT_KIND,
        label: "two",
        data: { text: "another, still a child of the group" },
      },
    ],
  },

  {
    kind: TEXT_KIND,
    label: "code",
    data: {
      text: "A media block pulls a real file in, either its text inline or its media player. Source files land as highlighted code, like this:",
    },
  },

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
  {
    kind: MEDIA_KIND,
    label: "readme.md",
    data: {
      uri: "https://raw.githubusercontent.com/nodejs/node/6f41e415639b5ec3dd816e44945cc73b4d7651e3/README.md",
    },
  },

  {
    kind: TEXT_KIND,
    label: "media",
    data: {
      text: "The same kind plays images, video, audio, and PDFs inline. One per type, like this:",
    },
  },

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
    label: "bunny.ogv",
    data: {
      // Unlisted extension, so this is the fallback row and preview.
      uri: "https://upload.wikimedia.org/wikipedia/commons/7/79/Big_Buck_Bunny_small.ogv",
    },
  },

  {
    kind: TEXT_KIND,
    label: "kinds",
    data: {
      text: "A kind sets how a block looks and what it carries. Text, Group, and these media kinds are shipped with the app. Everything else, and every tool an agent can call, comes from plugins. Plugins live in a directory the app scans at startup; add a directory and its kinds and tools appear, no rebuild.",
    },
  },

  {
    kind: TEXT_KIND,
    label: "infer",
    data: {
      text: "To run inference, move the cursor onto a block and trigger the action. The model reads every block above it as context and appends its reply as new blocks below. The next block is a ready prompt:",
    },
  },

  {
    kind: TEXT_KIND,
    label: "run",
    data: {
      text: "In a few sentences, describe what this graph demonstrates: which kinds it shows and what nesting does.",
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