"use strict";

const express = require("express");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = express();
const port = 3211;
const samples = Array.from({ length: 12 }, (_, index) => ({
  id: `fixture${String(index + 1).padStart(4, "0")}`,
  title: [
    "A Tour of a Classic Computer Room",
    "The Internet in 2005",
    "Building a Pentium III Gaming PC",
    "Dial-Up Modem Sounds",
  ][index % 4],
  channelTitle: ["Retro Tech", "Archive Channel", "Computer Show", "Classic Media"][index % 4],
  description: "A sample description used only to preview the period layout before release.",
  thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/default.jpg",
  duration: `${2 + index}:19`,
  durationSeconds: 139 + index * 60,
  publishedAt: `${index + 1} days ago`,
  publishedDate: "April 23, 2005",
  viewCount: (1000000 + index * 54321).toLocaleString("en-US"),
}));

app.set("view engine", "ejs");
app.set("views", path.join(root, "views"));
app.use(express.static(path.join(root, "public")));
app.get("/", (request, response) => response.render("index", {
  page: "home",
  recentlyFeatured: samples.slice(0, 4),
  featuredVideos: samples.slice(4),
  activeChannels: samples.slice(0, 4),
  error: null,
}));
app.get("/thumbnail", (request, response) => response.sendFile(path.join(root, "public", "images", "youtube_logo.jpg")));

app.listen(port, "127.0.0.1", () => {
  console.log(`Layout preview: http://127.0.0.1:${port}/`);
});
