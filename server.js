const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const { spawn } = require("child_process");
// Use system ffmpeg if ffmpeg-static is not available (Docker)
let ffmpegPath;
try {
  ffmpegPath = require("ffmpeg-static");
} catch (e) {
  ffmpegPath = "ffmpeg";
}
const { PassThrough } = require("stream");
const sharp = require("sharp");
const https = require("https");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, "cache");
const transcodingProgress = new Map();

// Simple In-Memory Cache
const apiCache = {
  home: { data: null, expires: 0 },
  videos: {}, // Keyed by filter + pageToken
};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Simple in-memory history cache (Last 10 videos)
let historyCache = [];

// Initialize YouTubei
let yt;
(async () => {
  try {
    const { Innertube, UniversalCache, Platform } = await import("youtubei.js");
    const { Jinter } = await import("jintr");

    Platform.shim.eval = async (data, env) => {
      // Construct the code to evaluate, appending the logic to call the decipher functions
      const properties = [];
      if (env.n) {
        properties.push(`n: exportedVars.nFunction("${env.n}")`);
      }
      if (env.sig) {
        properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
      }

      const code = `
            ${data.output}
            var result = { ${properties.join(", ")} };
            result;
        `;

      const jinter = new Jinter(code);
      for (const [key, value] of Object.entries(env)) {
        jinter.defineObject(key, value);
      }

      // Polyfill Object.assign for Jinter
      jinter.defineObject("Object", {
        assign: function (target, ...sources) {
          target = target || {};
          for (const src of sources) {
            if (src && typeof src === "object") {
              for (const key in src) {
                target[key] = src[key];
              }
            }
          }
          return target;
        },
      });

      // Inject other common globals required by YouTube's player script
      jinter.defineObject("RegExp", RegExp);
      jinter.defineObject("String", String);
      jinter.defineObject("Number", Number);
      jinter.defineObject("Array", Array);
      jinter.defineObject("Math", Math);
      jinter.defineObject("Date", Date);
      jinter.defineObject("JSON", JSON);
      jinter.defineObject("Promise", Promise);
      jinter.defineObject("Error", Error);
      jinter.defineObject("parseInt", parseInt);
      jinter.defineObject("parseFloat", parseFloat);
      jinter.defineObject("console", console);

      return jinter.evaluate(code);
    };
    yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      client_type: "ANDROID",
    });
    console.log("YouTubei.js initialized successfully");
  } catch (error) {
    console.error("Failed to initialize YouTubei.js:", error);
  }
})();

// Helper to parse ISO 8601 duration (PT1H2M10S) -> Seconds
function parseISO8601Duration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

// Helper to format seconds into MM:SS or HH:MM:SS
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const mStr = m.toString().padStart(2, "0");
  const sStr = s.toString().padStart(2, "0");

  if (h > 0) {
    return `${h}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
}

// Helper for relative time (e.g. "3 months ago")
function getRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " years ago";

  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " months ago";

  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " days ago";

  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + " hours ago";

  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + " minutes ago";

  return Math.floor(seconds) + " seconds ago";
}

// Helper to format view count with commas
function formatViews(views) {
  return parseInt(views).toLocaleString();
}

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
  console.log(`Created cache directory at: ${CACHE_DIR}`);
} else {
  console.log(`Using existing cache directory at: ${CACHE_DIR}`);
  const files = fs.readdirSync(CACHE_DIR);
  console.log(`Found ${files.length} cached files.`);
}

// Setup View Engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/cache", express.static(CACHE_DIR));

// YouTube API Client
const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});

// Helper to decode HTML entities from YouTube API
function decodeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&amp;/g, "&") // Decode ampersands first
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "’") // Smart quote
    .replace(/&#8220;/g, "“") // Smart quote open
    .replace(/&#8221;/g, "”"); // Smart quote close
}

// Helper to escape HTML (for safety when we render raw)
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Helper to fetch video details for a list of IDs
async function fetchVideoDetails(videoIds) {
  if (!videoIds || videoIds.length === 0) return [];

  const detailsResponse = await youtube.videos.list({
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
  });

  return detailsResponse.data.items.map((v) => {
    const durationSec = parseISO8601Duration(v.contentDetails.duration);
    return {
      id: v.id,
      title: decodeHtml(v.snippet.title),
      channelTitle: decodeHtml(v.snippet.channelTitle),
      description: decodeHtml(v.snippet.description),
      thumbnail: v.snippet.thumbnails.default.url,
      duration: formatDuration(durationSec),
      publishedAt: getRelativeTime(v.snippet.publishedAt),
      viewCount: formatViews(v.statistics.viewCount || 0),
      rating: Math.floor(Math.random() * 5) + 1, // Mock rating 1-5
      ratingCount: Math.floor(Math.random() * 1000) + 10, // Mock count
    };
  });
}

// Routes
app.get("/", async (req, res) => {
  try {
    // Check Cache
    const now = Date.now();
    if (apiCache.home.data && apiCache.home.expires > now) {
      console.log("Serving Home from Cache");
      return res.render("index", { ...apiCache.home.data, page: "home" });
    }

    // 1. Director Videos (Top Row - 4 items) - Using "short film" as proxy
    const directorSearch = await youtube.search.list({
      part: "id",
      q: "short film",
      type: "video",
      maxResults: 4,
    });
    const directorIds = directorSearch.data.items.map((v) => v.id.videoId);
    const directorVideos = await fetchVideoDetails(directorIds);

    // 2. Featured Videos (Left Column - 10 items) - Most Popular
    const featuredResponse = await youtube.videos.list({
      part: "snippet,statistics,contentDetails",
      chart: "mostPopular",
      regionCode: "US",
      maxResults: 10,
    });

    const featuredVideos = featuredResponse.data.items.map((v) => {
      const durationSec = parseISO8601Duration(v.contentDetails.duration);
      return {
        id: v.id,
        title: decodeHtml(v.snippet.title),
        channelTitle: decodeHtml(v.snippet.channelTitle),
        description: decodeHtml(v.snippet.description),
        thumbnail: v.snippet.thumbnails.default.url,
        duration: formatDuration(durationSec),
        publishedAt: getRelativeTime(v.snippet.publishedAt),
        viewCount: formatViews(v.statistics.viewCount || 0),
        rating: Math.floor(Math.random() * 5) + 1,
        ratingCount: Math.floor(Math.random() * 2000) + 50,
      };
    });

    // 3. Active Channels (Right Sidebar - 4 items)
    const channelSearch = await youtube.search.list({
      part: "snippet",
      type: "channel",
      order: "viewCount",
      maxResults: 4,
      q: "creator",
    });
    const activeChannels = channelSearch.data.items.map((item) => ({
      id: item.id.channelId,
      title: decodeHtml(item.snippet.title),
      thumbnail: item.snippet.thumbnails.default.url,
      videoCount: Math.floor(Math.random() * 100) + 10, // Mock
      subscriberCount: Math.floor(Math.random() * 10000) + 100, // Mock
    }));

    // 4. Active Groups (Right Sidebar - 2 items)
    const groupSearch = await youtube.search.list({
      part: "snippet",
      type: "playlist",
      q: "community",
      maxResults: 2,
    });
    const activeGroups = groupSearch.data.items.map((item) => ({
      id: item.id.playlistId,
      title: decodeHtml(item.snippet.title),
      thumbnail: item.snippet.thumbnails.default.url,
      videoCount: Math.floor(Math.random() * 50) + 5, // Mock
      topicCount: Math.floor(Math.random() * 20) + 1, // Mock
    }));

    const homeData = {
      directorVideos,
      featuredVideos,
      activeChannels,
      activeGroups,
    };

    // Update Cache
    apiCache.home = {
      data: homeData,
      expires: now + CACHE_TTL,
    };

    res.render("index", {
      ...homeData,
      page: "home",
    });
  } catch (error) {
    console.error("Error loading home:", error);
    res.render("error", { message: "Failed to load home page." });
  }
});

app.get("/videos", async (req, res) => {
  const filter = req.query.filter || "viewed"; // viewed, recent, rated, discussed
  const pageToken = req.query.pageToken || "";
  const cacheKey = `${filter}_${pageToken}`;

  try {
    // Check Cache
    const now = Date.now();
    if (apiCache.videos[cacheKey] && apiCache.videos[cacheKey].expires > now) {
      console.log(`Serving Videos (${cacheKey}) from Cache`);
      return res.render("videos", {
        ...apiCache.videos[cacheKey].data,
        page: "videos",
      });
    }

    let videoIds = [];
    let videos = [];
    let nextPageToken = null;
    let prevPageToken = null;

    // Step 1: Get Video IDs based on filter
    if (filter === "recent") {
      const response = await youtube.search.list({
        part: "id",
        type: "video",
        order: "date",
        maxResults: 10, // Reduced from 20
        pageToken: pageToken,
        q: "vlog", // Generic query to ensure results
      });
      videoIds = response.data.items.map((v) => v.id.videoId);
      nextPageToken = response.data.nextPageToken;
      prevPageToken = response.data.prevPageToken;
    } else if (filter === "viewed") {
      const response = await youtube.search.list({
        part: "id",
        type: "video",
        order: "viewCount",
        maxResults: 10, // Reduced from 20
        pageToken: pageToken,
        q: "viral", // Generic query
      });
      videoIds = response.data.items.map((v) => v.id.videoId);
      nextPageToken = response.data.nextPageToken;
      prevPageToken = response.data.prevPageToken;
    } else if (filter === "rated") {
      // "Top Rated" -> Most Popular (Chart)
      const response = await youtube.videos.list({
        part: "snippet,statistics,contentDetails",
        chart: "mostPopular",
        regionCode: "US",
        maxResults: 10, // Reduced from 20
        pageToken: pageToken,
      });
      videos = response.data.items;
      nextPageToken = response.data.nextPageToken;
      prevPageToken = response.data.prevPageToken;
    } else if (filter === "discussed") {
      const response = await youtube.search.list({
        part: "id",
        type: "video",
        order: "relevance",
        maxResults: 10, // Reduced from 20
        pageToken: pageToken,
        q: "news",
      });
      videoIds = response.data.items.map((v) => v.id.videoId);
      nextPageToken = response.data.nextPageToken;
      prevPageToken = response.data.prevPageToken;
    } else {
      // Default fallback
      const response = await youtube.videos.list({
        part: "snippet,statistics,contentDetails",
        chart: "mostPopular",
        regionCode: "US",
        maxResults: 10, // Reduced from 20
        pageToken: pageToken,
      });
      videos = response.data.items;
      nextPageToken = response.data.nextPageToken;
      prevPageToken = response.data.prevPageToken;
    }

    // Step 2: If we only have IDs, fetch full details
    if (videoIds.length > 0) {
      const detailsResponse = await youtube.videos.list({
        part: "snippet,statistics,contentDetails",
        id: videoIds.join(","),
      });
      videos = detailsResponse.data.items;
    }

    // Step 3: Process and Format Data
    videos = videos.map((v) => {
      const durationSec = parseISO8601Duration(v.contentDetails.duration);
      return {
        id: v.id,
        title: decodeHtml(v.snippet.title),
        channelTitle: decodeHtml(v.snippet.channelTitle),
        thumbnail: v.snippet.thumbnails.default.url,
        duration: formatDuration(durationSec),
        publishedAt: getRelativeTime(v.snippet.publishedAt),
        viewCount: formatViews(v.statistics.viewCount || 0),
        // Mock rating based on likes (just for visual)
        rating: 5,
      };
    });

    const videosData = { videos, filter, nextPageToken, prevPageToken };

    // Update Cache
    apiCache.videos[cacheKey] = {
      data: videosData,
      expires: now + CACHE_TTL,
    };

    res.render("videos", { ...videosData, page: "videos" });
  } catch (error) {
    console.error("Error fetching videos:", error);
    res.render("error", {
      message: "Failed to load videos. Check API Key.",
    });
  }
});

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.redirect("/");

  try {
    const response = await youtube.search.list({
      part: "snippet",
      q: query,
      type: "video",
      maxResults: 12,
    });

    // Get video IDs to fetch details
    const videoIds = response.data.items
      .map((item) => item.id.videoId)
      .join(",");
    let videos = [];

    if (videoIds) {
      const detailsResponse = await youtube.videos.list({
        part: "snippet,statistics,contentDetails",
        id: videoIds,
      });

      videos = detailsResponse.data.items.map((v) => {
        const durationSec = parseISO8601Duration(v.contentDetails.duration);
        return {
          id: v.id,
          snippet: {
            title: decodeHtml(v.snippet.title),
            channelTitle: decodeHtml(v.snippet.channelTitle),
            description: decodeHtml(v.snippet.description),
            thumbnails: v.snippet.thumbnails,
          },
          duration: formatDuration(durationSec),
          publishedAt: getRelativeTime(v.snippet.publishedAt),
          viewCount: formatViews(v.statistics.viewCount || 0),
          rating: Math.floor(Math.random() * 5000) + 500, // Mock rating count
        };
      });
    }

    res.render("search", { videos: videos, query, page: "search" });
  } catch (error) {
    console.error("Error searching:", error);
    res.render("error", { message: "Search failed." });
  }
});

app.get("/watch", async (req, res) => {
  const videoId = req.query.v;
  if (!videoId) return res.redirect("/");

  try {
    // 1. Fetch Main Video Details
    const response = await youtube.videos.list({
      part: "snippet,statistics,contentDetails",
      id: videoId,
    });

    const video = response.data.items[0];
    const duration = parseISO8601Duration(video.contentDetails.duration);

    // Decode title
    video.snippet.title = decodeHtml(video.snippet.title);
    video.snippet.channelTitle = decodeHtml(video.snippet.channelTitle);

    // Format description with <br> tags
    if (video.snippet.description) {
      let desc = decodeHtml(video.snippet.description);
      video.snippet.descriptionHtml = escapeHtml(desc).replace(/\n/g, "<br>");
    } else {
      video.snippet.descriptionHtml = "";
    }

    // Add formatted fields for the view
    video.formattedDuration = formatDuration(duration);
    video.formattedViews = formatViews(video.statistics.viewCount || 0);
    video.relativeDate = getRelativeTime(video.snippet.publishedAt);
    video.formattedDate = new Date(
      video.snippet.publishedAt
    ).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    video.commentCount = video.statistics.commentCount
      ? parseInt(video.statistics.commentCount).toLocaleString()
      : "0";

    // --- HISTORY LOGIC START ---
    // Create a simplified video object for history
    const historyItem = {
      id: video.id,
      title: video.snippet.title,
      description: video.snippet.description,
      thumbnail: video.snippet.thumbnails.medium
        ? video.snippet.thumbnails.medium.url
        : video.snippet.thumbnails.default.url,
      channelTitle: video.snippet.channelTitle,
      viewCount: video.formattedViews,
      publishedAt: video.snippet.publishedAt,
      relativeDate: video.relativeDate,
      duration: video.formattedDuration,
    };

    // Remove if already exists (to move it to the top)
    historyCache = historyCache.filter((item) => item.id !== video.id);

    // Add to top
    historyCache.unshift(historyItem);

    // Keep only last 10
    if (historyCache.length > 10) {
      historyCache.pop();
    }
    // --- HISTORY LOGIC END ---

    // 2. Fetch Related Videos
    let relatedVideos = [];
    try {
      // Use title to search for related videos since relatedToVideoId is deprecated
      const relatedResponse = await youtube.search.list({
        part: "id",
        q: video.snippet.title,
        type: "video",
        maxResults: 11, // Fetch 11 in case we need to filter out the current one
      });

      const relatedIds = relatedResponse.data.items
        .map((item) => item.id.videoId)
        .filter((id) => id !== videoId)
        .slice(0, 10)
        .join(",");

      if (relatedIds) {
        const relatedDetails = await youtube.videos.list({
          part: "snippet,statistics,contentDetails",
          id: relatedIds,
        });

        relatedVideos = relatedDetails.data.items.map((v) => {
          const d = parseISO8601Duration(v.contentDetails.duration);
          return {
            id: v.id,
            title: decodeHtml(v.snippet.title),
            channelTitle: decodeHtml(v.snippet.channelTitle),
            thumbnail: v.snippet.thumbnails.default.url,
            duration: formatDuration(d),
            viewCount: formatViews(v.statistics.viewCount || 0),
          };
        });
      }
    } catch (err) {
      console.error("Error fetching related videos:", err);
    }

    // Check if we have a cached version
    const cachedFile = path.join(CACHE_DIR, `${videoId}.mpg`);
    const isCached = fs.existsSync(cachedFile);

    res.render("watch", {
      video,
      relatedVideos,
      isCached,
      videoId,
      duration,
      page: "watch",
    });
  } catch (error) {
    console.error("Error loading video:", error);
    res.render("error", { message: "Failed to load video details." });
  }
});

// New History Route
app.get("/history", (req, res) => {
  res.render("history", {
    videos: historyCache,
    page: "home", // History is a sub-feature of Home/My Account
  });
});

// Channels Route
app.get("/channels", async (req, res) => {
  try {
    // Search for popular channels (generic query)
    const response = await youtube.search.list({
      part: "snippet",
      type: "channel",
      order: "viewCount",
      maxResults: 20,
      q: "official",
    });

    const channels = response.data.items.map((item) => ({
      id: item.id.channelId,
      title: decodeHtml(item.snippet.title),
      description: decodeHtml(item.snippet.description),
      thumbnail: item.snippet.thumbnails.default.url,
    }));

    res.render("channels", { channels, page: "channels" });
  } catch (error) {
    console.error("Error fetching channels:", error);
    res.render("error", { message: "Failed to load channels." });
  }
});

// Groups (mapped to Playlists) Route
app.get("/groups", async (req, res) => {
  try {
    // Search for playlists
    const response = await youtube.search.list({
      part: "snippet",
      type: "playlist",
      order: "relevance",
      maxResults: 20,
      q: "collection",
    });

    const groups = response.data.items.map((item) => ({
      id: item.id.playlistId,
      title: decodeHtml(item.snippet.title),
      description: decodeHtml(item.snippet.description),
      thumbnail: item.snippet.thumbnails.default.url,
      channelTitle: decodeHtml(item.snippet.channelTitle),
    }));

    res.render("groups", { groups, page: "groups" });
  } catch (error) {
    console.error("Error fetching groups:", error);
    res.render("error", { message: "Failed to load groups." });
  }
});

// Categories Route
app.get("/categories", async (req, res) => {
  try {
    const response = await youtube.videoCategories.list({
      part: "snippet",
      regionCode: "US",
    });

    // Filter out unassignable categories if needed, but usually all returned are valid
    const categories = response.data.items.map((item) => ({
      id: item.id,
      title: item.snippet.title,
    }));

    res.render("categories", { categories, page: "categories" });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.render("error", { message: "Failed to load categories." });
  }
});

// Category Browser Route
app.get("/category/:id", async (req, res) => {
  const categoryId = req.params.id;
  try {
    const response = await youtube.videos.list({
      part: "snippet,statistics,contentDetails",
      chart: "mostPopular",
      videoCategoryId: categoryId,
      regionCode: "US",
      maxResults: 20,
    });

    const videos = response.data.items.map((v) => {
      const durationSec = parseISO8601Duration(v.contentDetails.duration);
      return {
        id: v.id,
        title: decodeHtml(v.snippet.title),
        channelTitle: decodeHtml(v.snippet.channelTitle),
        thumbnail: v.snippet.thumbnails.default.url,
        duration: formatDuration(durationSec),
        publishedAt: getRelativeTime(v.snippet.publishedAt),
        viewCount: formatViews(v.statistics.viewCount || 0),
      };
    });

    res.render("index", { videos, filter: "category" });
  } catch (error) {
    console.error("Error fetching category videos:", error);
    res.render("error", {
      message: "Failed to load videos for this category.",
    });
  }
});

// Upload Route (Dummy)
app.get("/upload", (req, res) => {
  res.render("upload", { page: "upload" });
});

// Comments Route
app.get("/comments/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const pageToken = req.query.pageToken || "";

  try {
    const response = await youtube.commentThreads.list({
      part: "snippet",
      videoId: videoId,
      maxResults: 10,
      pageToken: pageToken,
      textFormat: "plainText",
    });

    const comments = response.data.items.map((item) => ({
      author: decodeHtml(
        item.snippet.topLevelComment.snippet.authorDisplayName
      ),
      text: escapeHtml(
        decodeHtml(item.snippet.topLevelComment.snippet.textDisplay)
      ).replace(/\n/g, "<br>"),
      date: new Date(
        item.snippet.topLevelComment.snippet.publishedAt
      ).toLocaleDateString(),
    }));

    res.json({
      comments,
      nextPageToken: response.data.nextPageToken || null,
      prevPageToken: null, // API doesn't easily support prev without caching tokens
    });
  } catch (error) {
    console.error("Error fetching comments:", error.message);
    // Return empty comments if disabled or error
    res.json({
      comments: [],
      nextPageToken: null,
      prevPageToken: null,
    });
  }
});

// Thumbnail Proxy Route
app.get("/thumbnail", (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send("Missing URL");

  https
    .get(imageUrl, (stream) => {
      if (stream.statusCode !== 200) {
        return res.status(stream.statusCode).send("Failed to fetch image");
      }

      const transform = sharp()
        .resize(120, 90, { fit: "cover" })
        .toFormat("jpeg");

      res.setHeader("Content-Type", "image/jpeg");
      stream.pipe(transform).pipe(res);
    })
    .on("error", (err) => {
      console.error("Thumbnail proxy error:", err);
      res.status(500).send("Proxy error");
    });
});

// Transcode Route
app.get("/stream/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const duration = parseInt(req.query.duration) || 0;
  const outputPath = path.join(CACHE_DIR, `${videoId}.mpg`);

  if (fs.existsSync(outputPath)) {
    // If already cached, redirect to static file
    return res.redirect(`/cache/${videoId}.mpg`);
  }

  console.log(
    `[${new Date().toLocaleTimeString()}] Starting transcode for ${videoId}...`
  );
  transcodingProgress.set(videoId, { percent: 0, status: "processing" });

  try {
    if (!yt) {
      throw new Error("YouTubei.js is not initialized yet");
    }

    // Get stream from youtubei.js
    console.log(`[${videoId}] Fetching stream via InnerTube...`);

    const stream = await yt.download(videoId, {
      type: "video+audio",
      quality: "best",
      format: "mp4",
    });

    // Spawn FFmpeg process
    const ffmpeg = spawn(ffmpegPath, [
      "-y", // Overwrite output file
      "-i",
      "-", // Input from stdin
      "-target",
      "ntsc-vcd", // VCD standard (MPEG-1, 352x240, 1150k video, 224k audio)
      "-ac",
      "2", // Stereo audio
      "-ar",
      "44100", // 44.1kHz audio
      outputPath,
    ]);

    ffmpeg.stderr.on("data", (data) => {
      const str = data.toString();
      const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (timeMatch && duration > 0) {
        const hours = parseInt(timeMatch[1]);
        const mins = parseInt(timeMatch[2]);
        const secs = parseInt(timeMatch[3]);
        const currentTime = hours * 3600 + mins * 60 + secs;
        const percent = Math.min(
          99,
          Math.round((currentTime / duration) * 100)
        );

        // Log progress every 10% to avoid spamming console
        const prevPercent = transcodingProgress.get(videoId)?.percent || 0;
        if (percent > prevPercent && percent % 10 === 0) {
          console.log(`[${videoId}] Progress: ${percent}%`);
        }

        transcodingProgress.set(videoId, { percent, status: "processing" });
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log(`[${videoId}] Transcoding finished successfully.`);
        transcodingProgress.set(videoId, { percent: 100, status: "complete" });
      } else {
        console.error(`[${videoId}] FFmpeg process exited with code ${code}`);
        transcodingProgress.set(videoId, { percent: 0, status: "error" });
      }
    });

    // Handle spawn errors (e.g. ENOENT)
    ffmpeg.on("error", (err) => {
      console.error(`[${videoId}] Failed to spawn FFmpeg:`, err);
      transcodingProgress.set(videoId, { percent: 0, status: "error" });
    });

    // Pipe YouTube stream to FFmpeg stdin
    // youtubei.js returns a ReadableStream (web standard) or similar async iterator
    // We need to write it to the ffmpeg stdin
    (async () => {
      try {
        for await (const chunk of stream) {
          if (ffmpeg.stdin.writable) {
            ffmpeg.stdin.write(chunk);
          } else {
            break;
          }
        }
        ffmpeg.stdin.end();
      } catch (err) {
        console.error(`[${videoId}] Error piping stream:`, err);
        ffmpeg.kill();
      }
    })();

    res.send("Transcoding started. Please wait a moment and reload the page.");
  } catch (error) {
    console.error("Stream error:", error);
    res.status(500).send("Error starting stream: " + error.message);
  }
});

app.get("/status/:videoId", (req, res) => {
  const videoId = req.params.videoId;
  const progress = transcodingProgress.get(videoId);
  if (!progress) {
    return res.send("0|unknown");
  }
  res.send(`${progress.percent}|${progress.status}`);
});

app.listen(PORT, () => {
  console.log(`98Tuber server running on http://localhost:${PORT}`);
});
