"use strict";

const { getInnertube } = require("../youtube-client");

const videoIdPattern = /^[A-Za-z0-9_-]{6,20}$/;
const sampleEndByte = 1023;

async function runMediaPreflight(videoId, createClient = getInnertube) {
  if (!videoIdPattern.test(videoId || "")) {
    throw new Error("MEDIA_PREFLIGHT_VIDEO_ID must be a valid authorized YouTube video ID.");
  }

  const client = await createClient();
  const stream = await client.download(videoId, {
    type: "video+audio",
    quality: "best",
    format: "mp4",
    range: { start: 0, end: sampleEndByte },
  });
  const reader = stream.getReader();

  try {
    const result = await reader.read();
    const bytes = result.value && result.value.byteLength || 0;
    if (result.done || bytes < 1 || bytes > sampleEndByte + 1) {
      throw new Error("The bounded media request returned an invalid sample.");
    }
    return bytes;
  } finally {
    try {
      await reader.cancel("98Tuber media preflight complete");
    } catch {
      // The bounded read already supplied the evidence; cancellation is cleanup.
    }
  }
}

if (require.main === module) {
  const videoId = String(process.env.MEDIA_PREFLIGHT_VIDEO_ID || "").trim();
  runMediaPreflight(videoId)
    .then((bytes) => console.log(`Media preflight succeeded with ${bytes} bytes.`))
    .catch((error) => {
      console.error(`Media preflight failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { runMediaPreflight, sampleEndByte };
