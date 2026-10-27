import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, parseJsonPreservingNumbers, potToBaseUnits } from "../src/verigate.ts";

test("canonical JSON preserves Python integral-float spellings from signed artifacts", () => {
  const parsed = parseJsonPreservingNumbers('{"payload":{"n":1.0,"nested":[2.00,3e0]}}');
  assert.equal(canonicalJson(parsed.payload), '{"nested":[2.00,3e0],"n":1.0}');
});

test("canonical JSON sorts keys recursively and does not add whitespace", () => {
  const parsed = parseJsonPreservingNumbers('{"z":1,"a":{"y":true,"x":"ok"}}');
  assert.equal(canonicalJson(parsed), '{"a":{"x":"ok","y":true},"z":1}');
});

test("POT conversion uses exact 14-decimal integer arithmetic", () => {
  assert.equal(potToBaseUnits("1"), "100000000000000");
  assert.equal(potToBaseUnits("0.00000000000001"), "1");
  assert.equal(potToBaseUnits("12.3405"), "1234050000000000");
});

test("POT conversion rejects zero, non-canonical values, and excess precision", () => {
  for (const value of ["0", "00.1", "1e2", "-1", "0.000000000000001", " 1"]) {
    assert.throws(() => potToBaseUnits(value));
  }
});
