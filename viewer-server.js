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
const maxCacheBytes = Number(process.env.MAX_CACHE_BYTES || 21474836480);
const youtubeApiTimeoutMs = Number(process.env.YOUTUBE_API_TIMEOUT_MS || 15000);
const videoIdPattern = /^[A-Za-z0-9_-]{6,20}$/;
const thumbnailHosts = new Set([
  "i.ytimg.com",
  "img.youtube.com",
  "yt3.ggpht.com",
  "yt3.googleusercontent.com",
]);
const progress = new Map();
let activeVideoId = null;
let activeFfmpeg = null;
let activePartialPath = null;
let youtubeReady = false;
let popularVideoCache = { expiresAt: 0, videos: [] };
let mediaClientFactory = null;

async function getMediaClient() {
  if (!mediaClientFactory) {
    mediaClientFactory = require("./youtube-client").getInnertube;
  }
  return mediaClientFactory();
}

function readRequiredSecret(name) {
  const fileName = process.env[`${name}_FILE`];
  if (fileName && process.env[name]) throw new Error(`Set only ${name}_FILE or ${name}, not both.`);
  const value = fileName ? fs.readFileSync(fileName, "utf8").trim() : String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name}_FILE or ${name} must provide a non-empty value.`);
  return value;
}

const youtubeApiKey = readRequiredSecret("YOUTUBE_API_KEY");
if (![maxVideoSeconds, maxOutputBytes, maxCacheBytes, youtubeApiTimeoutMs].every(Number.isFinite) ||
    maxVideoSeconds <= 0 || maxOutputBytes <= 0 || maxCacheBytes < maxOutputBytes || youtubeApiTimeoutMs <= 0) {
  throw new Error("Conversion and cache limits must be positive, and MAX_CACHE_BYTES must cover MAX_OUTPUT_BYTES.");
}
fs.mkdirSync(cacheDir, { recursive: true });
for (const name of fs.readdirSync(cacheDir).filter((entry) => entry.endsWith(".partial"))) {
  fs.rmSync(path.join(cacheDir, name), { force: true });
}

const youtube = google.youtube({ version: "v3", auth: youtubeApiKey });

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

function relativeTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "Unknown";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [seconds, label] of units) {
    if (elapsedSeconds >= seconds) {
      const count = Math.floor(elapsedSeconds / seconds);
      return `${count} ${label}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "Just now";
}

function normalizeVideo(video) {
  const snippet = video && video.snippet || {};
  const statistics = video && video.statistics || {};
  const contentDetails = video && video.contentDetails || {};
  const thumbnails = snippet.thumbnails || {};
  const thumbnail = thumbnails.medium || thumbnails.default || thumbnails.high || {};
  const durationSeconds = parseDuration(contentDetails.duration);
  return {
    id: String(video && video.id || ""),
    title: String(snippet.title || "Untitled video"),
    channelTitle: String(snippet.channelTitle || "Unknown"),
    description: String(snippet.description || ""),
    thumbnail: String(thumbnail.url || ""),
    duration: formatDuration(durationSeconds),
    durationSeconds,
    publishedAt: relativeTime(snippet.publishedAt),
    publishedDate: snippet.publishedAt
      ? new Date(snippet.publishedAt).toLocaleDateString("en-CA", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "Unknown",
    viewCount: Number(statistics.viewCount || 0).toLocaleString("en-US"),
  };
}

async function loadPopularVideos() {
  const now = Date.now();
  if (popularVideoCache.videos.length && popularVideoCache.expiresAt > now) {
    return popularVideoCache.videos;
  }
  const result = await youtube.videos.list({
    part: "snippet,statistics,contentDetails",
    chart: "mostPopular",
    regionCode: "CA",
    maxResults: 12,
  }, { timeout: youtubeApiTimeoutMs });
  const videos = result.data.items.map(normalizeVideo).filter((video) => video.id);
  if (!videos.length) throw new Error("YouTube returned no popular videos.");
  popularVideoCache = { videos, expiresAt: now + 15 * 60 * 1000 };
  youtubeReady = true;
  return videos;
}

function cachePath(videoId) {
  return path.join(cacheDir, `${videoId}.mpg`);
}

function partialCachePath(videoId) {
  return path.join(cacheDir, `.${videoId}.partial`);
}

function reserveCacheSpace() {
  const files = fs.readdirSync(cacheDir)
    .filter((name) => name.endsWith(".mpg"))
    .map((name) => {
      const filePath = path.join(cacheDir, name);
      return { filePath, ...fs.statSync(filePath) };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  while (files.length && total + maxOutputBytes > maxCacheBytes) {
    const oldest = files.shift();
    fs.rmSync(oldest.filePath, { force: true });
    total -= oldest.size;
  }
  if (total + maxOutputBytes > maxCacheBytes) throw new Error("Cache has insufficient space for a conversion.");
}

async function getVideoDuration(videoId) {
  const result = await youtube.videos.list({ part: "contentDetails", id: videoId }, { timeout: youtubeApiTimeoutMs });
  const video = result.data.items[0];
  if (!video) return null;
  return parseDuration(video.contentDetails.duration);
}

function isValidVideoId(videoId) {
  return videoIdPattern.test(videoId || "");
}

function requireVideoId(req, res) {
  if (!isValidVideoId(req.params.videoId || req.query.v)) {
    res.status(400).send("Invalid video identifier.");
    return false;
  }
  return true;
}

app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));
app.use("/cache", express.static(cacheDir, { fallthrough: false, maxAge: "30d" }));

app.get("/health/live", (req, res) => res.json({ ok: true, service: "98tuber-viewer" }));
app.get("/health/ready", (req, res) => res.status(youtubeReady ? 200 : 503).json({ ok: youtubeReady }));

app.get("/", async (req, res) => {
  try {
    const videos = await loadPopularVideos();
    res.render("index", {
      page: "home",
      recentlyFeatured: videos.slice(0, 4),
      featuredVideos: videos.slice(4),
      activeChannels: [...new Map(videos.map((video) => [video.channelTitle, video])).values()].slice(0, 5),
      error: null,
    });
  } catch (error) {
    console.error("Home page lookup failed:", error.message);
    res.render("index", {
      page: "home",
      recentlyFeatured: [],
      featuredVideos: [],
      activeChannels: [],
      error: "Featured videos are temporarily unavailable. Search may still be used.",
    });
  }
});

app.get("/videos", async (req, res) => {
  try {
    const videos = await loadPopularVideos();
    res.render("search", { page: "videos", heading: "Most Viewed Videos", query: "", videos, error: null });
  } catch (error) {
    console.error("Video directory lookup failed:", error.message);
    res.status(502).render("search", { page: "videos", heading: "Most Viewed Videos", query: "", videos: [], error: "Videos are temporarily unavailable." });
  }
});

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 128);
  if (!query) return res.redirect("/");
  try {
    const search = await youtube.search.list({ part: "id", q: query, type: "video", maxResults: 10 }, { timeout: youtubeApiTimeoutMs });
    const ids = search.data.items.map((item) => item.id.videoId).filter(Boolean);
    const details = ids.length ? await youtube.videos.list({ part: "snippet,statistics,contentDetails", id: ids.join(",") }, { timeout: youtubeApiTimeoutMs }) : { data: { items: [] } };
    youtubeReady = true;
    const videos = details.data.items.map(normalizeVideo);
    res.render("search", { page: "search", heading: `Search Results for \"${query}\"`, query, videos, error: null });
  } catch (error) {
    console.error("Search failed:", error.message);
    res.status(502).render("search", { page: "search", heading: `Search Results for \"${query}\"`, query, videos: [], error: "Video search is temporarily unavailable. Try again later." });
  }
});

app.get("/watch", async (req, res) => {
  if (!requireVideoId(req, res)) return;
  const videoId = req.query.v;
  try {
    const result = await youtube.videos.list({ part: "snippet,statistics,contentDetails", id: videoId }, { timeout: youtubeApiTimeoutMs });
    const video = result.data.items[0];
    if (!video) {
      return res.status(404).render("watch", {
        page: "videos",
        video: null,
        videoId,
        isCached: false,
        convertible: false,
        maxVideoMinutes: Math.floor(maxVideoSeconds / 60),
        error: "Video was not found.",
      });
    }
    youtubeReady = true;
    const normalized = normalizeVideo(video);
    const seconds = normalized.durationSeconds;
    const cached = fs.existsSync(cachePath(videoId));
    res.render("watch", {
      page: "videos",
      video: normalized,
      videoId,
      isCached: cached,
      convertible: seconds > 0 && seconds <= maxVideoSeconds,
      maxVideoMinutes: Math.floor(maxVideoSeconds / 60),
      error: null,
    });
  } catch (error) {
    console.error("Watch lookup failed:", error.message);
    res.status(502).render("watch", { page: "videos", video: null, videoId, isCached: false, convertible: false, maxVideoMinutes: Math.floor(maxVideoSeconds / 60), error: "Video details are temporarily unavailable." });
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
  const output = cachePath(videoId);
  const partial = partialCachePath(videoId);
  if (fs.existsSync(output)) return res.redirect(`/cache/${videoId}.mpg`);
  if (activeVideoId && activeVideoId !== videoId) return res.status(429).send("Another video conversion is running. Try again shortly.");
  if (activeVideoId === videoId) return res.status(202).send("Conversion already in progress. Reload the video page shortly.");

  activeVideoId = videoId;
  progress.set(videoId, "processing");
  try {
    const duration = await getVideoDuration(videoId);
    if (duration === null) throw new Error("Video was not found.");
    if (duration <= 0 || duration > maxVideoSeconds) {
      activeVideoId = null;
      progress.set(videoId, "rejected");
      return res.status(400).send("Video is longer than this viewer permits.");
    }
    reserveCacheSpace();
    fs.rmSync(partial, { force: true });
    const innertube = await getMediaClient();
    const input = await innertube.download(videoId, { type: "video+audio", quality: "best", format: "mp4" });
    const ffmpeg = spawn("ffmpeg", ["-y", "-i", "-", "-threads", "1", "-target", "ntsc-vcd", "-acodec", "libmp3lame", "-ab", "192k", "-ac", "2", "-ar", "44100", "-fs", String(maxOutputBytes), "-f", "vcd", partial], { stdio: ["pipe", "ignore", "pipe"] });
    activeFfmpeg = ffmpeg;
    activePartialPath = partial;
    ffmpeg.stderr.resume();
    let finalized = false;
    const finalize = (completed) => {
      if (finalized) return;
      finalized = true;
      if (!completed) fs.rmSync(partial, { force: true });
      progress.set(videoId, completed ? "complete" : "error");
      if (activeVideoId === videoId) activeVideoId = null;
      if (activeFfmpeg === ffmpeg) activeFfmpeg = null;
      if (activePartialPath === partial) activePartialPath = null;
    };
    ffmpeg.once("close", (code) => {
      let completed = false;
      if (code === 0 && fs.existsSync(partial)) {
        try {
          fs.renameSync(partial, output);
          completed = true;
        } catch (error) {
          console.error("Unable to publish converted video:", error.message);
        }
      }
      finalize(completed);
    });
    ffmpeg.once("error", () => finalize(false));
    (async () => { try { for await (const chunk of input) { if (!ffmpeg.stdin.write(chunk)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve)); } ffmpeg.stdin.end(); } catch (error) { console.error("Conversion input failed:", error.message); ffmpeg.kill("SIGTERM"); } })();
    res.status(202).send("Conversion started. Reload the video page in a few minutes.");
  } catch (error) {
    activeVideoId = null;
    activeFfmpeg = null;
    activePartialPath = null;
    fs.rmSync(partial, { force: true });
    progress.set(videoId, "error");
    console.error("Conversion start failed:", error.message);
    res.status(502).send("Unable to start conversion.");
  }
});

app.get("/status/:videoId", (req, res) => {
  if (!requireVideoId(req, res)) return;
  res.type("text/plain").send(progress.get(req.params.videoId) || "unknown");
});

const server = app.listen(port, "0.0.0.0", () => console.log(`98Tuber viewer listening on ${port}`));

function shutdown(signal) {
  console.log(`${signal} received; stopping 98Tuber.`);
  if (activeFfmpeg) activeFfmpeg.kill("SIGTERM");
  if (activePartialPath) fs.rmSync(activePartialPath, { force: true });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
