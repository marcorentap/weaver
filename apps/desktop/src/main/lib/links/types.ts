import type {
  LinkOption,
  LinkTypeDescriptor,
} from "../../../shared/ipc-contract.js";

/**
 * Where a link provider searches and how much it should return. Passed in
 * rather than read from process state so a provider is a pure function of
 * its arguments and can be tested (or later fed a remote root) without
 * touching Electron.
 */
export type LinkSearchContext = {
  /** Project root a `@file:` value is resolved against. */
  root: string;
  /** Upper bound on returned candidates. */
  limit: number;
};

/**
 * One `@`-link type: the descriptor the renderer completes the type half
 * with, plus the `search` that completes the value half. A provider owns
 * both halves of one type, so "what can a `@file:` point at" lives in a
 * single place rather than split across the two processes.
 *
 * `search` receives the raw text typed after the `:` (empty when the user
 * has just chosen a type) and returns candidates already ranked, so the
 * renderer never has to know how a particular type's candidates are
 * produced.
 */
export type LinkProvider = LinkTypeDescriptor & {
  search(query: string, ctx: LinkSearchContext): Promise<LinkOption[]>;
};
