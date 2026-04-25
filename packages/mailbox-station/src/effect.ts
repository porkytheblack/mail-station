// Effect-typed skin over the Promise/Result kernel. Same kernel, layer-based skin.
//
// Users with an Effect codebase can compose station lifecycle effects with
// their own without paying a Promise/Effect translation tax at every boundary.

import { Context, Effect, Layer } from "effect"
import { createStation } from "./internal/station.js"
import type {
  StationInput,
  Station,
} from "./internal/station.js"
import type {
  MailboxEvent,
  MailboxPipeline,
  ProviderFactory,
} from "./internal/types.js"

export class StationService extends Context.Tag("@mail-station/StationService")<
  StationService,
  {
    readonly start: Effect.Effect<void>
    readonly stop: Effect.Effect<void>
    readonly wait: Effect.Effect<void>
    readonly processEvent: (event: MailboxEvent) => Effect.Effect<"ack" | "nack">
    readonly providers: Record<string, unknown>
  }
>() {}

export const stationLayer = <P extends Record<string, ProviderFactory>>(
  input: StationInput<P>,
): Layer.Layer<StationService> =>
  Layer.scoped(
    StationService,
    Effect.gen(function* () {
      const station = createStation(input)
      yield* Effect.addFinalizer(() => Effect.promise(() => station.stop()))
      return makeService(station)
    }),
  )

const makeService = <P extends Record<string, ProviderFactory>>(
  station: Station<P>,
): Context.Tag.Service<StationService> => ({
  start: Effect.promise(() => station.start()),
  stop: Effect.promise(() => station.stop()),
  wait: Effect.promise(() => station.wait()),
  processEvent: (event) => Effect.promise(() => station.pipeline.processEvent(event)),
  providers: station.providers as Record<string, unknown>,
})

/**
 * Convenience: build an Effect-typed station handle directly (not as a Layer).
 * Returns the same surface as createStation but lifted into Effect.
 */
export type StationEffect<P extends Record<string, ProviderFactory>> = {
  readonly start: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
  readonly wait: Effect.Effect<void>
  readonly processEvent: (event: MailboxEvent) => Effect.Effect<"ack" | "nack">
  readonly providers: Station<P>["providers"]
  readonly pipeline: MailboxPipeline
}

export const createStationEffect = <P extends Record<string, ProviderFactory>>(
  input: StationInput<P>,
): Effect.Effect<StationEffect<P>> =>
  Effect.sync(() => {
    const station = createStation(input)
    return {
      start: Effect.promise(() => station.start()),
      stop: Effect.promise(() => station.stop()),
      wait: Effect.promise(() => station.wait()),
      processEvent: (event: MailboxEvent) =>
        Effect.promise(() => station.pipeline.processEvent(event)),
      providers: station.providers,
      pipeline: station.pipeline,
    }
  })

// Re-export public types so users importing from `/effect` only have a single
// entry point.
export * from "./index.js"
