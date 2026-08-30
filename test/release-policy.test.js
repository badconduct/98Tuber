"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "viewer-server.js"), "utf8");
const youtubeClient = fs.readFileSync(path.join(root, "youtube-client.js"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");

test("conversion policy is enforced from server metadata", () => {
  assert.doesNotMatch(server, /req\.query\.duration/);
  assert.match(server, /getVideoDuration\(videoId\)/);
  assert.match(server, /duration > maxVideoSeconds/);
});

test("conversion output is drained and atomically published", () => {
  assert.match(server, /ffmpeg\.stderr\.resume\(\)/);
  assert.match(server, /"-f", "vcd", partial/);
  assert.match(server, /partialCachePath/);
  assert.match(server, /fs\.renameSync\(partial, output\)/);
  assert.match(workflow, /Exercise the production FFmpeg VCD command/);
});

test("runtime supports file-mounted secrets and bounded cache", () => {
  assert.match(server, /process\.env\[`\$\{name\}_FILE`\]/);
  assert.match(server, /MAX_CACHE_BYTES/);
  assert.match(server, /reserveCacheSpace\(\)/);
  assert.match(server, /timeout: youtubeApiTimeoutMs/);
});

test("youtubei media downloads have the required deciphering evaluator", () => {
  assert.match(youtubeClient, /Platform\.shim\.eval/);
  assert.match(youtubeClient, /new Jinter/);
  assert.match(youtubeClient, /parseFloat, console/);
  assert.match(server, /getInnertube\(\)/);
  assert.match(dockerfile, /COPY --chown=node:node viewer-server\.js youtube-client\.js/);
});

test("container base and CI actions are immutable", () => {
  assert.match(dockerfile, /^FROM node:[^\n]+@sha256:[a-f0-9]{64}/m);
  assert.doesNotMatch(workflow, /uses: [^\s]+@v\d/m);
});

test("CI scans and publishes the same loaded image", () => {
  const builds = workflow.match(/docker\/build-push-action@/g) || [];
  assert.equal(builds.length, 1);
  assert.match(workflow, /image-ref: 98tuber:ci/);
  assert.match(workflow, /docker tag 98tuber:ci/);
});
