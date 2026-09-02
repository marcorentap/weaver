import { z } from "zod";
import { coreKinds, defineKind, kindRegistry } from "@repo/core";
import { agentKind } from "./agent";
import { issLocationKind } from "./iss";
import { mediaKind } from "./media";
import { timerKind } from "./timer";
import { toolKind } from "./tool";

/**
 * Custom block kinds. A kind is defined by the schema of its state: the unique
 * set of data needed to reconstruct that block. The schema is exported so the
 * renderer parses through the same definition instead of re-declaring fields.
 */
export const METRIC_KIND = "metric";
export const FILE_KIND = "file";

export const metricState = z.object({
  value: z.number(),
  limit: z.number().positive(),
  unit: z.string(),
});
export type MetricState = z.infer<typeof metricState>;

export const metricKind = defineKind({
  kind: METRIC_KIND,
  schema: metricState,
  snapshot: (state, ctx) =>
    `${ctx.block.label}: ${state.value}/${state.limit} ${state.unit}`,
  defaults: { value: 0, limit: 100, unit: "" },
});

export const fileState = z.object({
  path: z.string(),
  language: z.string(),
  summary: z.string(),
});
export type FileState = z.infer<typeof fileState>;

export const fileKind = defineKind({
  kind: FILE_KIND,
  schema: fileState,
  snapshot: (state) => `${state.path} — ${state.summary}`,
  defaults: { path: "", language: "", summary: "" },
});

export const kinds = kindRegistry([
  ...coreKinds,
  metricKind,
  fileKind,
  mediaKind,
  timerKind,
  issLocationKind,
  agentKind,
  toolKind,
]);
