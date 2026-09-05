import { z } from "zod";
import { defineKind } from "@repo/core";

/** Current ISS position, polled from open-notify's public API. */
export const ISS_LOCATION_KIND = "iss-location";

export const issLocationState = z.object({
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** Epoch ms the position itself is timestamped at, per the API. */
  timestamp: z.number().nullable(),
  /** Epoch ms of the last successful fetch, distinct from `timestamp`. */
  fetchedAt: z.number().nullable(),
  /** Message from the last failed fetch, if any; cleared on success. */
  error: z.string().nullable(),
});
export type IssLocationState = z.infer<typeof issLocationState>;

/** Shape of http://api.open-notify.org/iss-now.json. */
const issResponse = z.object({
  timestamp: z.number(),
  iss_position: z.object({
    latitude: z.coerce.number(),
    longitude: z.coerce.number(),
  }),
});

export const issLocationKind = defineKind({
  kind: ISS_LOCATION_KIND,
  schema: issLocationState,
  snapshot: (state) =>
    state.error !== null
      ? `ISS location: ${state.error}`
      : state.latitude === null || state.longitude === null
        ? "ISS location: not fetched yet"
        : `ISS at ${state.latitude}, ${state.longitude} as of ${new Date(state.timestamp ?? 0).toISOString()}`,
  hooks: {
    /** Fetch the current position. Failure updates `error` and leaves the
     *  last known position in place rather than blanking it out. */
    update: async (state) => {
      try {
        const res = await fetch("http://api.open-notify.org/iss-now.json");
        if (!res.ok) {
          throw new Error(`iss-now.json responded ${res.status}`);
        }
        const body = issResponse.parse(await res.json());
        return {
          latitude: body.iss_position.latitude,
          longitude: body.iss_position.longitude,
          timestamp: body.timestamp * 1000,
          fetchedAt: Date.now(),
          error: null,
        };
      } catch (error) {
        return {
          ...state,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  defaults: {
    latitude: null,
    longitude: null,
    timestamp: null,
    fetchedAt: null,
    error: null,
  },
});
