"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runMediaPreflight, sampleEndByte } = require("../scripts/media-preflight");

test("media preflight exercises one bounded combined-media request", async () => {
  let requestedVideoId;
  let requestedOptions;
  let cancelled = false;
  const bytes = await runMediaPreflight("M7lc1UVf-VE", async () => ({
    async download(videoId, options) {
      requestedVideoId = videoId;
      requestedOptions = options;
      return {
        getReader() {
          return {
            async read() { return { done: false, value: new Uint8Array(1024) }; },
            async cancel() { cancelled = true; },
          };
        },
      };
    },
  }));

  assert.equal(bytes, 1024);
  assert.equal(requestedVideoId, "M7lc1UVf-VE");
  assert.deepEqual(requestedOptions, {
    type: "video+audio",
    quality: "best",
    format: "mp4",
    range: { start: 0, end: sampleEndByte },
  });
  assert.equal(cancelled, true);
});

test("media preflight rejects a missing or malformed video ID before networking", async () => {
  let requested = false;
  await assert.rejects(
    runMediaPreflight("not a video", async () => { requested = true; }),
    /valid authorized YouTube video ID/,
  );
  assert.equal(requested, false);
});
