export interface PendingVerigateExecution<TAuthorization> {
  expectedCallHex: string;
  expiresAt: number;
  executionAuthorization: TAuthorization;
}

/**
 * Consume a one-time plan binding synchronously, then consume its authorization
 * with Verigate before invoking the transaction submitter.
 *
 * The take callback must atomically remove the plan from its local/shared store
 * before returning it. A failed consume intentionally burns the local binding.
 */
export async function executeAuthorizedOnce<TAuthorization, TResult>(
  planId: string,
  take: (id: string) => PendingVerigateExecution<TAuthorization> | undefined,
  consume: (authorization: TAuthorization) => Promise<unknown>,
  submit: (id: string, expectedCallHex: string, expiresAt: number) => Promise<TResult>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<TResult> {
  const authorization = take(planId);
  if (!authorization) {
    throw new Error("No unconsumed Verigate authorization exists for this plan.");
  }
  if (!Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= nowSeconds) {
    throw new Error("Verigate authorization expired; the one-time approval has been consumed.");
  }

  await consume(authorization.executionAuthorization);
  return submit(planId, authorization.expectedCallHex, authorization.expiresAt);
}
