import { z } from "zod";
import { defineKind } from "@repo/core";

/**
 * A block a person writes by hand, as opposed to one an inference run
 * appended. Its state is plain text today, same as `text`. But it is its
 * own kind, not an alias, so features particular to authoring (`@` file
 * autocomplete, say) can land on it later without `text` blocks picking
 * them up too.
 */
export const USER_KIND = "user";

export const userState = z.object({ text: z.string() });
export type UserState = z.infer<typeof userState>;

export const userKind = defineKind({
  kind: USER_KIND,
  schema: userState,
  snapshot: (state) => state.text,
  defaults: { text: "" },
});