import { AsyncLocalStorage } from "node:async_hooks";

const tails = new Map<string, Promise<void>>();
const activeMutations = new AsyncLocalStorage<ReadonlySet<string>>();

export class RepositoryMutationReentrancyError extends Error {
  public readonly code = "repository-mutation-reentrancy";

  public constructor(public readonly repositoryFingerprint: string) {
    super(
      `A repository mutation for ${repositoryFingerprint} cannot start another mutation for the same repository.`,
    );
    this.name = "RepositoryMutationReentrancyError";
  }
}

export async function runRepositoryMutation<T>(
  repositoryFingerprint: string,
  operation: () => Promise<T>,
): Promise<T> {
  const active = activeMutations.getStore();
  if (active?.has(repositoryFingerprint) === true) {
    throw new RepositoryMutationReentrancyError(repositoryFingerprint);
  }
  const previous = tails.get(repositoryFingerprint) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(repositoryFingerprint, current);
  await previous;
  try {
    return await activeMutations.run(
      new Set([...(active ?? []), repositoryFingerprint]),
      operation,
    );
  } finally {
    release();
    if (tails.get(repositoryFingerprint) === current) {
      tails.delete(repositoryFingerprint);
    }
  }
}
