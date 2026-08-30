"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createEvaluator } = require("../youtube-client");

test("Jinter evaluates the signature and throttling transforms required by youtubei", async () => {
  const { Jinter } = await import("jintr");
  const evaluate = createEvaluator(Jinter);
  const result = await evaluate({
    output: "var exportedVars = { nFunction: function(value) { return value + '-n'; }, sigFunction: function(value) { return value + '-sig'; } };",
  }, { n: "throttle", sig: "signature" });
  assert.deepEqual(result, { n: "throttle-n", sig: "signature-sig" });
});
