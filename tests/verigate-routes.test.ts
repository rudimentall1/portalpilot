import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Import without starting PortalPilot's normal listener; this test owns an ephemeral server.
process.env.VERCEL = "1";
const { app } = await import("../src/server.ts");

async function postAsk(text: string): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, network: "testnet" }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

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
