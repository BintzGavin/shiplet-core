type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Orders one-shot temporary-account authority so malformed input cannot burn a
 * grant and an unavailable immutable audit cannot be followed by a provider
 * effect. The callbacks intentionally keep authority material inside the
 * owning support Worker.
 */
export async function executeTemporaryProviderEffect<Result>(input: {
  validate: () => MaybePromise<void>;
  consume: () => MaybePromise<void>;
  audit: () => MaybePromise<void>;
  effect: () => MaybePromise<Result>;
}) {
  await input.validate();
  await input.consume();
  await input.audit();
  return input.effect();
}
