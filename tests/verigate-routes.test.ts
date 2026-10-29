import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { executePlan } from "../src/sdk/tx.ts";

// Import without starting PortalPilot's normal listener; this test owns an ephemeral server.
process.env.VERCEL = "1";
process.env.VERIGATE_SINGLE_PROCESS_MODE = "true";
const { app } = await import("../src/server.ts");

async function postAsk(text: string, origin?: string): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, network: "testnet" }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

async function postExecute(planId: string): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

test("local Verigate mode rejects browser requests from unapproved origins", async () => {
  const response = await postAsk("network status", "https://attacker.example");
  assert.equal(response.status, 403);
  assert.match(response.body.error, /Origin not allowed in local Verigate mode/);
});

test("local Verigate mode permits the configured local browser origin", async () => {
  const response = await postAsk("what can I do?", "http://localhost:8787");
  assert.equal(response.status, 200);
  assert.equal(response.body.kind, "help");
});

test("contract flip command cannot bypass the Verigate native-transfer gate", async () => {
  const response = await postAsk("flip the contract");
  assert.equal(response.status, 200);
  assert.match(response.body.answer, /Verigate integration blocks ink! contract writes/);
});

test("contract deployment cannot bypass the Verigate native-transfer gate", async () => {
  const response = await postAsk("deploy flipper contract");
  assert.equal(response.status, 200);
  assert.match(response.body.answer, /Verigate integration blocks ink! contract deployment/);
});

test("unguarded SDK execution is disabled when Verigate mode is enabled", async () => {
  const previousVercel = process.env.VERCEL;
  const previousMode = process.env.VERIGATE_SINGLE_PROCESS_MODE;
  delete process.env.VERCEL;
  process.env.VERIGATE_SINGLE_PROCESS_MODE = "true";
  try {
    await assert.rejects(
      executePlan("not-a-real-plan"),
      /Unguarded executePlan is disabled in Verigate or serverless mode/,
    );
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousMode === undefined) delete process.env.VERIGATE_SINGLE_PROCESS_MODE;
    else process.env.VERIGATE_SINGLE_PROCESS_MODE = previousMode;
  }
});

test("execute route refuses an unknown plan before consuming authorization or broadcasting", async () => {
  const previousVercel = process.env.VERCEL;
  const previousMode = process.env.VERIGATE_SINGLE_PROCESS_MODE;
  delete process.env.VERCEL;
  process.env.VERIGATE_SINGLE_PROCESS_MODE = "true";
  try {
    const response = await postExecute("not-a-real-authorized-plan-route-test");
    assert.equal(response.status, 400);
    assert.match(response.body.error, /No unconsumed Verigate authorization exists for this plan/);
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousMode === undefined) delete process.env.VERIGATE_SINGLE_PROCESS_MODE;
    else process.env.VERIGATE_SINGLE_PROCESS_MODE = previousMode;
  }
});
