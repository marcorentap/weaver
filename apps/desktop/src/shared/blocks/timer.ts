import { z } from "zod";
import { defineKind } from "@repo/core";

/**
 * Fires a named hook on another block at a fixed interval. `targetId`/`hook`
 * is the "callback" piece, a reference to another block's callable, and
 * `schedule` below is the "timer" piece, a request to have one of your own
 * hooks invoked on an interval. Both are generic. Nothing about the runtime
 * driving either one needs to know this kind exists.
 */
export const TIMER_KIND = "timer";

export const timerState = z.object({
  /** How often to fire, in milliseconds. */
  intervalMs: z.number().int().positive(),
  /** Id of the block whose hook this timer calls on every tick. */
  targetId: z.string(),
  /** Name of the hook to call on the target block. */
  hook: z.string(),
  /** JSON-encoded argument passed to the target hook on every tick, or ""
   *  to call it with no argument. Defaults to "" so timers persisted before
   *  this field existed keep parsing. */
  arg: z.string().default(""),
  /** Fires so far, for visibility in the row. The timer's own heartbeat. */
  ticks: z.number().int().nonnegative(),
  /** Epoch ms of the last fire, or null before the first one. */
  lastTickAt: z.number().nullable(),
});
export type TimerState = z.infer<typeof timerState>;

export const timerKind = defineKind({
  kind: TIMER_KIND,
  schema: timerState,
  snapshot: (state) =>
    `every ${state.intervalMs}ms, calls ${state.hook} on ${state.targetId} (${state.ticks} ticks)`,
  schedule: (state) => ({ intervalMs: state.intervalMs, hook: "tick" }),
  callbacks: [
    { label: "On tick", targetField: "targetId", hookField: "hook", argField: "arg" },
  ],
  hooks: {
    /** The runtime's own tick, per `schedule` above. Nothing stops another
     *  block from calling it directly too. That just calls its target
     *  early. */
    tick: async (state, ctx) => {
      const arg = state.arg.trim() ? JSON.parse(state.arg) : undefined;
      await ctx.call(state.targetId, state.hook, arg);
      return { ...state, ticks: state.ticks + 1, lastTickAt: Date.now() };
    },
  },
  defaults: {
    intervalMs: 1000,
    targetId: "",
    hook: "",
    arg: "",
    ticks: 0,
    lastTickAt: null,
  },
});
