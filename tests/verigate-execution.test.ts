import test from "node:test";
import assert from "node:assert/strict";
import { executeAuthorizedOnce, type PendingVerigateExecution } from "../src/verigate-execution.ts";

type Auth = { id: string };
const pending = (expiresAt = 2_000_000_000): PendingVerigateExecution<Auth> => ({
  expectedCallHex: "0x1234",
  expiresAt,
  executionAuthorization: { id: "auth-1" },
});

function takeOnceStore(initial: PendingVerigateExecution<Auth> | undefined) {
  const plans = new Map<string, PendingVerigateExecution<Auth>>();
  if (initial) plans.set("plan-1", initial);
  return (id: string) => {
    const value = plans.get(id);
    plans.delete(id);
    return value;
  };
}

test("authorization consume failure never invokes the transaction submitter", async () => {
  let sends = 0;
  const take = takeOnceStore(pending());
  await assert.rejects(
    executeAuthorizedOnce(
      "plan-1",
      take,
      async () => { throw new Error("Verigate unavailable"); },
      async () => { sends += 1; return "submitted"; },
      1_900_000_000,
    ),
    /Verigate unavailable/,
  );
  assert.equal(sends, 0);
});

test("expired authorization is consumed locally and never submits", async () => {
  let consumes = 0;
  let sends = 0;
  await assert.rejects(
    executeAuthorizedOnce(
      "plan-1",
      takeOnceStore(pending(100)),
      async () => { consumes += 1; },
      async () => { sends += 1; return "submitted"; },
      100,
    ),
    /expired/,
  );
  assert.equal(consumes, 0);
  assert.equal(sends, 0);
});

test("allowed authorization submits exactly once with the checked call and expiry", async () => {
  let sends = 0;
  const result = await executeAuthorizedOnce(
    "plan-1",
    takeOnceStore(pending()),
    async (auth) => { assert.deepEqual(auth, { id: "auth-1" }); },
    async (id, callHex, expiresAt) => {
      sends += 1;
      assert.equal(id, "plan-1");
      assert.equal(callHex, "0x1234");
      assert.equal(expiresAt, 2_000_000_000);
      return "receipt";
    },
    1_900_000_000,
  );
  assert.equal(result, "receipt");
  assert.equal(sends, 1);
});

test("concurrent attempts cannot take the same one-time plan twice", async () => {
  let sends = 0;
  const take = takeOnceStore(pending());
  const submit = async () => { sends += 1; return "receipt"; };
  const consume = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); };
  const results = await Promise.allSettled([
    executeAuthorizedOnce("plan-1", take, consume, submit, 1_900_000_000),
    executeAuthorizedOnce("plan-1", take, consume, submit, 1_900_000_000),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(sends, 1);
});


test("missing or already-consumed plan never calls consume or submit", async () => {
  let consumes = 0;
  let sends = 0;
  await assert.rejects(
    executeAuthorizedOnce(
      "unknown-plan",
      takeOnceStore(undefined),
      async () => { consumes += 1; },
      async () => { sends += 1; return "submitted"; },
      1_900_000_000,
    ),
    /No unconsumed Verigate authorization/,
  );
  assert.equal(consumes, 0);
  assert.equal(sends, 0);
});

test("failed submission cannot reuse the consumed local plan", async () => {
  let consumes = 0;
  let sends = 0;
  const take = takeOnceStore(pending());
  const consume = async () => { consumes += 1; };
  const submit = async () => {
    sends += 1;
    throw new Error("submit failed");
  };

  await assert.rejects(
    executeAuthorizedOnce("plan-1", take, consume, submit, 1_900_000_000),
    /submit failed/,
  );
  await assert.rejects(
    executeAuthorizedOnce("plan-1", take, consume, submit, 1_900_000_000),
    /No unconsumed Verigate authorization/,
  );
  assert.equal(consumes, 1);
  assert.equal(sends, 1);
});
