// @ts-nocheck
import * as Effect from "effect/Effect"
import * as Data from "effect/Data"
import * as Context from "effect/Context"

const retrieveWebsite = Effect.fn(function* ({ url }: { url: string }) {
    // whatever
    return {
        content: `This is a mock answer from the website (${url}) for the question: ${prompt}`
    }
});

const retrieveWebsiteCached = FuzzyCache.cached(
    askWebsite,
    {
        params: {
            url: {
                _tag: "ExactStringMatch"
            }
        },
        ttlMs: 1000 * 60 * 60, // 1 hour
    }
)

const askWebsite = Effect.fn(function* ({ url, prompt }: { url: string, prompt?: string }) {
    const { content } = yield* retrieveWebsiteCached({ url })
    // whatever
    return {
        answer: `This is a mock answer from the website (${url}) for the question: ${prompt}`
    }
});

const askWebsiteCached = FuzzyCache.cached(
    askWebsite,
    {
        params: {
            url: {
                _tag: "ExactStringMatch"
            },
            prompt: {
                _tag: "CosineSimilarity",
                model: "semantic",
                tolerance: 0.1,
            }
        }
    })


// Goal composable cache
// askWebsite("What is the capital of France?" (https://wikipedia.org/wiki/France)) -> Cache miss
// askWebsite("What is the capital?" (https://wikipedia.org/wiki/France)) -> Cache hit - similar prompt

class FuzzyCacheInternalError extends Data.TaggedError("@FuzzyCacheInternalError")<{}> { }

const ParamCachingConfig = <T>() => Context.GenericTag<ParamCachingConfig<T>>("@Cing")
interface ParamCachingConfig<T> { }

class FuzzyCache extends Effect.Service<FuzzyCache>({
    effect: Effect.gen(function* () {
        const config = yield* ParamCachingConfig()
        // ?
    }),
}) {
    static cached = <Params extends Record<string, unknown>, A, E, R>(
        fn: (params: Params) => Effect.Effect<A, E, R>,
        config: {
            params: {
                [P in keyof Params]: ParamCachingConfig<Params[P]>;
            },
            ttlMs: number,
        }
    ): (params: Params) => Effect.Effect<A, E | FuzzyCacheInternalError, R | FuzzyCache> => {
        throw new Error("Not implemented")
    }
}
