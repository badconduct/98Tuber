"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const root = path.resolve(__dirname, "..");
const views = path.join(root, "views");
const server = fs.readFileSync(path.join(root, "viewer-server.js"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");

const video = {
  id: "jNQXAC9IVRw",
  title: "A test video",
  channelTitle: "Test Channel",
  description: "Fixture description",
  thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/default.jpg",
  duration: "0:19",
  durationSeconds: 19,
  publishedAt: "20 years ago",
  publishedDate: "April 23, 2005",
  viewCount: "1,000,000",
};

function render(name, data) {
  return ejs.renderFile(path.join(views, name), data);
}

test("the production image includes the period templates", () => {
  assert.match(dockerfile, /views\/header\.ejs views\/index\.ejs views\/search\.ejs views\/watch\.ejs \.\/views\//);
  for (const name of ["header", "index", "search", "watch"]) {
    assert.match(dockerignore, new RegExp(`!views/${name}\\.ejs`));
  }
  assert.match(server, /app\.set\("view engine", "ejs"\)/);
  assert.match(server, /chart: "mostPopular"/);
  assert.doesNotMatch(server, /layout\(/);
});

test("the home page renders real video links without diagnostic copy", async () => {
  const html = await render("index.ejs", {
    page: "home",
    recentlyFeatured: [video],
    featuredVideos: [video],
    activeChannels: [video],
    error: null,
  });
  assert.match(html, /YouTube - Broadcast Yourself\./);
  assert.match(html, /Recently Featured/);
  assert.match(html, /Today's Featured Videos/);
  assert.match(html, /\/watch\?v=jNQXAC9IVRw/);
  assert.doesNotMatch(html, /LAN only|no accounts|Windows 98 Video Viewer/i);
});

test("search and watch templates render IE6-compatible navigation and player", async () => {
  const search = await render("search.ejs", {
    page: "search",
    heading: "Search Results for \"test\"",
    query: "test",
    videos: [video],
    error: null,
  });
  const watch = await render("watch.ejs", {
    page: "videos",
    video,
    videoId: video.id,
    isCached: true,
    convertible: true,
    maxVideoMinutes: 15,
    error: null,
  });
  assert.match(search, /HTML 4\.01 Transitional/);
  assert.match(search, /\/thumbnail\?url=/);
  assert.match(watch, /CLSID:22D6F312-B0F6-11D0-94AB-0080C74C7E95/);
  assert.match(watch, /application\/x-mplayer2/);
  assert.match(watch, /\/cache\/jNQXAC9IVRw\.mpg/);
  assert.doesNotMatch(watch, /\bconst\b|\blet\b|=>|fetch\(/);
});

test("API text remains escaped by the templates", async () => {
  const unsafe = {
    ...video,
    title: '<script>alert("title")</script>',
    description: '<img src=x onerror="alert(1)">',
    channelTitle: 'Channel"><script>alert(2)</script>',
  };
  const html = await render("search.ejs", {
    page: "search",
    heading: '<script>alert("heading")</script>',
    query: '"><script>alert("query")</script>',
    videos: [unsafe],
    error: null,
  });
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;img src=x onerror=/);
});

test("the shared header contains no dead application routes", async () => {
  const header = await render("header.ejs", { page: "home", query: "" });
  const links = [...header.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(links.length > 5);
  for (const link of links) {
    assert.ok(link === "/" || link === "/videos" || link.startsWith("/search?"), `unexpected header link: ${link}`);
  }
});
