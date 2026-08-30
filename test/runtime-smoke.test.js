"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}

test("file-mounted API key starts a live service and shuts down cleanly", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "98tuber-test-"));
  const secret = path.join(temporary, "youtube-api-key");
  fs.writeFileSync(secret, "ci-placeholder\n", { mode: 0o600 });
  const port = await availablePort();
  const environment = { ...process.env, APP_DATA_DIR: path.join(temporary, "data"), PORT: String(port), YOUTUBE_API_KEY_FILE: secret };
  delete environment.YOUTUBE_API_KEY;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "viewer-server.js")], {
    cwd: os.tmpdir(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });

  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/health/live`);
        break;
      } catch {
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(response && response.status, 200, diagnostics);
    await response.json();
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    if (process.platform !== "win32") assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
