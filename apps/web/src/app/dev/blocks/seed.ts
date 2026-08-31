import type { BlockInput } from "@repo/store";
import { newId } from "@repo/store";
import { COMPOSITE_KIND, TEXT_KIND } from "@repo/core";
import { FILE_KIND, METRIC_KIND } from "@/blocks/kinds";
import { MEDIA_KIND } from "@/blocks/media";

const t0 = Date.parse("2026-08-31T09:00:00.000Z");
const at = (seconds: number) => t0 + seconds * 1000;

/**
 * Seed entries reference each other by readable key. Real ids are minted at
 * insert time, since block ids are UUIDs rather than hand-written strings.
 */
type SeedEntry = Omit<BlockInput, "id"> & {
  key: string;
  parents?: string[];
  children?: string[];
};

const entries: SeedEntry[] = [
  {
    key: "system",
    kind: TEXT_KIND,
    label: "system",
    createdAt: at(0),
    data: { text: "You are a graphical agent harness." },
  },
  {
    key: "env",
    kind: TEXT_KIND,
    label: "env",
    createdAt: at(1),
    parents: ["system"],
    data: { text: "cwd=/home/marcorentap/projects/weaver" },
  },
  {
    key: "budget",
    kind: METRIC_KIND,
    label: "context",
    createdAt: at(2),
    parents: ["env"],
    data: { value: 4820, limit: 8192, unit: "tok" },
  },

  // Composite nesting text blocks.
  {
    key: "tools",
    kind: COMPOSITE_KIND,
    label: "tools",
    createdAt: at(3),
    parents: ["budget"],
    children: ["tool-read", "tool-write", "tool-grep"],
  },
  {
    key: "tool-read",
    kind: TEXT_KIND,
    label: "read",
    createdAt: at(4),
    data: { text: "read(path) -> string" },
  },
  {
    key: "tool-write",
    kind: TEXT_KIND,
    label: "write",
    createdAt: at(5),
    parents: ["tool-read"],
    data: { text: "write(path, content) -> void" },
  },
  {
    key: "tool-grep",
    kind: TEXT_KIND,
    label: "grep",
    createdAt: at(6),
    parents: ["tool-read"],
    data: { text: "grep(pattern, path) -> match[]" },
  },

  // Nesting two levels deep, with a custom kind at the leaves.
  {
    key: "repo",
    kind: COMPOSITE_KIND,
    label: "repo",
    createdAt: at(7),
    parents: ["env"],
    children: ["repo-map", "repo-files"],
  },
  {
    key: "repo-map",
    kind: TEXT_KIND,
    label: "map",
    createdAt: at(8),
    data: { text: "apps/web, packages/core, packages/store" },
  },
  {
    key: "repo-files",
    kind: COMPOSITE_KIND,
    label: "files",
    createdAt: at(9),
    parents: ["repo-map"],
    children: ["file-block", "file-store"],
  },
  {
    key: "file-block",
    kind: FILE_KIND,
    label: "block.ts",
    createdAt: at(10),
    data: {
      path: "packages/core/src/block.ts",
      language: "ts",
      summary: "open kinds, snapshot registry",
    },
  },
  {
    key: "file-store",
    kind: FILE_KIND,
    label: "store/index.ts",
    createdAt: at(11),
    parents: ["file-block"],
    data: {
      path: "packages/store/src/index.ts",
      language: "ts",
      summary: "sqlite persistence",
    },
  },

  // A merge of two parents, nesting metric blocks with their own state schema.
  {
    key: "usage",
    kind: COMPOSITE_KIND,
    label: "usage",
    createdAt: at(12),
    parents: ["tools", "repo"],
    children: ["usage-prompt", "usage-output"],
  },
  {
    key: "usage-prompt",
    kind: METRIC_KIND,
    label: "prompt",
    createdAt: at(13),
    data: { value: 3180, limit: 8192, unit: "tok" },
  },
  {
    key: "usage-output",
    kind: METRIC_KIND,
    label: "output",
    createdAt: at(14),
    parents: ["usage-prompt"],
    data: { value: 640, limit: 4096, unit: "tok" },
  },

  // Media, addressed by URI: one per detected type, plus one over https.
  // Local examples live in public/media and are resolved against the app's
  // cwd, so no absolute path is hard-coded into the repo.
  {
    key: "media-local",
    kind: MEDIA_KIND,
    label: "globe.svg",
    createdAt: at(15),
    parents: ["budget"],
    data: { uri: `file://${process.cwd()}/public/globe.svg` },
  },
  {
    key: "media-remote",
    kind: MEDIA_KIND,
    label: "flower.jpg",
    createdAt: at(16),
    parents: ["media-local"],
    data: {
      uri: "https://upload.wikimedia.org/wikipedia/commons/3/3f/JPEG_example_flower.jpg",
    },
  },
  {
    key: "media-gif",
    kind: MEDIA_KIND,
    label: "loop.gif",
    createdAt: at(17),
    parents: ["media-remote"],
    data: {
      // Query string on purpose: type detection reads the path, not the URL.
      uri: "https://d2w9rnfcy7mm78.cloudfront.net/33694363/original_c60302cccf34b1629d37c73184dbacb2.gif?1736943050?bc=0",
    },
  },
  {
    key: "media-video",
    kind: MEDIA_KIND,
    label: "clip.mp4",
    createdAt: at(18),
    parents: ["media-gif"],
    data: { uri: `file://${process.cwd()}/public/media/clip.mp4` },
  },
  {
    key: "media-audio",
    kind: MEDIA_KIND,
    label: "tone.wav",
    createdAt: at(19),
    parents: ["media-video"],
    data: { uri: `file://${process.cwd()}/public/media/tone.wav` },
  },
  {
    key: "media-pdf",
    kind: MEDIA_KIND,
    label: "note.pdf",
    createdAt: at(20),
    parents: ["media-audio"],
    data: { uri: `file://${process.cwd()}/public/media/note.pdf` },
  },
  {
    key: "media-unknown",
    kind: MEDIA_KIND,
    label: "notes.log",
    createdAt: at(21),
    parents: ["media-pdf"],
    data: { uri: `file://${process.cwd()}/public/media/notes.log` },
  },
];

/** Blocks for a fresh graph, with keys resolved to freshly minted ids. */
export function devSeedBlocks(): BlockInput[] {
  const ids = new Map<string, string>();
  for (const entry of entries) ids.set(entry.key, newId());

  const resolve = (key: string) => {
    const id = ids.get(key);
    if (!id) throw new Error(`seed references unknown key: ${key}`);
    return id;
  };

  return entries.map((entry) => ({
    id: resolve(entry.key),
    kind: entry.kind,
    label: entry.label,
    createdAt: entry.createdAt,
    parents: entry.parents?.map(resolve),
    children: entry.children?.map(resolve),
    data: entry.data,
  }));
}
