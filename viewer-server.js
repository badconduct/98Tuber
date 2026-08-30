"use strict";

const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const sharp = require("sharp");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.APP_DATA_DIR || path.join(__dirname, "cache");
const cacheDir = path.join(dataDir, "cache");
const maxVideoSeconds = Number(process.env.MAX_VIDEO_SECONDS || 900);
const maxOutputBytes = Number(process.env.MAX_OUTPUT_BYTES || 314572800);
const videoIdPattern = /^[A-Za-z0-9_-]{6,20}$/;
const thumbnailHosts = new Set([
  "i.ytimg.com",
  "img.youtube.com",
  "yt3.ggpht.com",
  "yt3.googleusercontent.com",
]);
const progress = new Map();
let activeVideoId = null;
let youtubeReady = false;

if (!process.env.YOUTUBE_API_KEY) {
  throw new Error("YOUTUBE_API_KEY must be provided through the runtime secret.");
}
fs.mkdirSync(cacheDir, { recursive: true });

const youtube = google.youtube({ version: "v3", auth: process.env.YOUTUBE_API_KEY });

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function cachePath(videoId) {
  return path.join(cacheDir, `${videoId}.mpg`);
}

function isValidVideoId(videoId) {
  return videoIdPattern.test(videoId || "");
}

function layout(title, body) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head><title>${escapeHtml(title)}</title><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><link rel="stylesheet" href="/base.css" type="text/css"></head><body><div id="baseDiv"><div id="logoTagDiv"><a href="/"><img src="/images/youtube_logo.jpg" alt="98Tuber" width="120" border="0"></a></div><div id="utilDiv">Windows 98 viewer &middot; LAN only</div><div id="searchDiv"><form method="get" action="/search"><span class="smallLabel">Search for&nbsp;</span><input type="text" name="q" maxlength="128" class="searchField"> <input type="submit" value="Search"></form></div>${body}</div></body></html>`;
}

function videoCard(video) {
  const thumb = encodeURIComponent(video.snippet.thumbnails.default.url);
  const title = escapeHtml(video.snippet.title);
  const channel = escapeHtml(video.snippet.channelTitle);
  const description = escapeHtml(video.snippet.description || "").slice(0, 180);
  const duration = formatDuration(parseDuration(video.contentDetails && video.contentDetails.duration));
  const views = Number(video.statistics && video.statistics.viewCount || 0).toLocaleString();
  return `<tr><td width="130" valign="top"><a href="/watch?v=${video.id}"><img src="/thumbnail?url=${thumb}" width="120" height="90" border="0" alt=""></a></td><td valign="top"><a href="/watch?v=${video.id}" class="video_title_large">${title}</a><br><span class="video_meta">${description}</span><br><br><span class="video_details">Time: <b>${duration}</b><br>From: ${channel}<br>Views: ${views}</span></td></tr>`;
}

function requireVideoId(req, res) {
  if (!isValidVideoId(req.params.videoId || req.query.v)) {
    res.status(400).send("Invalid video identifier.");
    return false;
  }
  return true;
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));
app.use("/cache", express.static(cacheDir, { fallthrough: false, maxAge: "30d" }));

app.get("/health/live", (req, res) => res.json({ ok: true, service: "98tuber-viewer" }));
app.get("/health/ready", (req, res) => res.status(youtubeReady ? 200 : 503).json({ ok: youtubeReady }));

app.get("/", (req, res) => {
  res.send(layout("98Tuber", "<div style=\"padding:20px\"><h2>Windows 98 Video Viewer</h2><p>Search for a video, then request an MPEG-1 conversion for Windows Media Player 6.4.</p><p>This viewer has no accounts, comments, favorites, or uploads.</p></div>"));
});

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 128);
  if (!query) return res.redirect("/");
  try {
    const search = await youtube.search.list({ part: "id", q: query, type: "video", maxResults: 10 });
    const ids = search.data.items.map((item) => item.id.videoId).filter(Boolean);
    const details = ids.length ? await youtube.videos.list({ part: "snippet,statistics,contentDetails", id: ids.join(",") }) : { data: { items: [] } };
    youtubeReady = true;
    const rows = details.data.items.map(videoCard).join("") || "<tr><td>No videos found.</td></tr>";
    res.send(layout(`Search: ${query}`, `<div class="section_title">Search Results for &quot;${escapeHtml(query)}&quot;</div><table width="100%" border="0" cellspacing="0" cellpadding="5">${rows}</table>`));
  } catch (error) {
    console.error("Search failed:", error.message);
    res.status(502).send(layout("Search unavailable", "<p>Video search is temporarily unavailable. Try again later.</p>"));
  }
});

app.get("/watch", async (req, res) => {
  if (!requireVideoId(req, res)) return;
  const videoId = req.query.v;
  try {
    const result = await youtube.videos.list({ part: "snippet,statistics,contentDetails", id: videoId });
    const video = result.data.items[0];
    if (!video) return res.status(404).send(layout("Video unavailable", "<p>Video was not found.</p>"));
    youtubeReady = true;
    const seconds = parseDuration(video.contentDetails.duration);
    const cached = fs.existsSync(cachePath(videoId));
    const title = escapeHtml(video.snippet.title);
    const player = cached
      ? `<object classid="CLSID:22D6F312-B0F6-11D0-94AB-0080C74C7E95" width="450" height="370"><param name="FileName" value="/cache/${videoId}.mpg"><param name="AutoStart" value="true"><param name="ShowControls" value="true"><embed type="application/x-mplayer2" src="/cache/${videoId}.mpg" width="450" height="370" autostart="true"></embed></object>`
      : `<p><a href="/stream/${videoId}?duration=${seconds}">Start conversion for Windows 98</a></p><p>Maximum conversion length: ${Math.floor(maxVideoSeconds / 60)} minutes. One conversion runs at a time.</p>`;
    res.send(layout(title, `<h2>${title}</h2><div>${player}</div><p><b>From:</b> ${escapeHtml(video.snippet.channelTitle)}<br><b>Length:</b> ${formatDuration(seconds)}<br><b>Views:</b> ${Number(video.statistics.viewCount || 0).toLocaleString()}</p><p>${escapeHtml(video.snippet.description || "").replace(/\n/g, "<br>")}</p>`));
  } catch (error) {
    console.error("Watch lookup failed:", error.message);
    res.status(502).send(layout("Video unavailable", "<p>Video details are temporarily unavailable.</p>"));
  }
});

app.get("/thumbnail", (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || "")); } catch { return res.status(400).send("Invalid thumbnail URL"); }
  if (url.protocol !== "https:" || !thumbnailHosts.has(url.hostname)) return res.status(400).send("Thumbnail host is not allowed");
  https.get(url, { timeout: 10000 }, (upstream) => {
    if (upstream.statusCode !== 200) { upstream.resume(); return res.status(502).send("Thumbnail unavailable"); }
    res.setHeader("Content-Type", "image/jpeg");
    upstream.pipe(sharp().resize(120, 90, { fit: "cover" }).jpeg()).on("error", () => { if (!res.headersSent) res.status(502).end(); }).pipe(res);
  }).on("timeout", function () { this.destroy(); }).on("error", () => res.status(502).send("Thumbnail unavailable"));
});

app.get("/stream/:videoId", async (req, res) => {
  if (!requireVideoId(req, res)) return;
  const videoId = req.params.videoId;
  const duration = Number(req.query.duration || 0);
  const output = cachePath(videoId);
  if (fs.existsSync(output)) return res.redirect(`/cache/${videoId}.mpg`);
  if (duration <= 0 || duration > maxVideoSeconds) return res.status(400).send("Video is longer than this viewer permits.");
  if (activeVideoId && activeVideoId !== videoId) return res.status(429).send("Another video conversion is running. Try again shortly.");
  if (activeVideoId === videoId) return res.status(202).send("Conversion already in progress. Reload the video page shortly.");

  activeVideoId = videoId;
  progress.set(videoId, "processing");
  try {
    const { Innertube, UniversalCache } = await import("youtubei.js");
    const innertube = await Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true, client_type: "ANDROID" });
    const input = await innertube.download(videoId, { type: "video+audio", quality: "best", format: "mp4" });
    const ffmpeg = spawn("ffmpeg", ["-y", "-i", "-", "-threads", "1", "-target", "ntsc-vcd", "-acodec", "libmp3lame", "-ab", "192k", "-ac", "2", "-ar", "44100", "-fs", String(maxOutputBytes), output], { stdio: ["pipe", "ignore", "pipe"] });
    ffmpeg.on("close", (code) => { progress.set(videoId, code === 0 ? "complete" : "error"); activeVideoId = null; if (code !== 0) fs.rm(output, { force: true }, () => {}); });
    ffmpeg.on("error", () => { progress.set(videoId, "error"); activeVideoId = null; });
    (async () => { try { for await (const chunk of input) { if (!ffmpeg.stdin.write(chunk)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve)); } ffmpeg.stdin.end(); } catch (error) { console.error("Conversion input failed:", error.message); ffmpeg.kill("SIGTERM"); } })();
    res.status(202).send("Conversion started. Reload the video page in a few minutes.");
  } catch (error) {
    activeVideoId = null;
    progress.set(videoId, "error");
    console.error("Conversion start failed:", error.message);
    res.status(502).send("Unable to start conversion.");
  }
});

app.get("/status/:videoId", (req, res) => {
  if (!requireVideoId(req, res)) return;
  res.type("text/plain").send(progress.get(req.params.videoId) || "unknown");
});

app.listen(port, "0.0.0.0", () => console.log(`98Tuber viewer listening on ${port}`));
