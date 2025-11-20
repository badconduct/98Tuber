# 98Tuber - Retro YouTube Proxy

A Node.js server that acts as a bridge between modern YouTube and Windows 98 / Internet Explorer 6. It recreates the look and feel of YouTube circa 2006.

## Features

- **Proxy Server**: Fetches data from YouTube Data API v3.
- **Transcoding**: Converts modern H.264/VP9 video to MPEG-1 (VCD) compatible with Windows Media Player 6.4.
- **Retro Frontend**: HTML 4.01 strict templates designed for IE6.
- **Caching**: Saves converted videos locally to avoid re-downloading.
- **Pagination**: Browse through video results with IE6-compatible navigation.
- **Docker Support**: Easily run the server in a containerized environment.

## Prerequisites

### Option A: Docker (Recommended)

- **Docker Desktop**: Install Docker Desktop for Windows/Mac/Linux.

### Option B: Manual Installation

1.  **Node.js**: Install Node.js (v14+ recommended).
2.  **FFmpeg**:
    - Download FFmpeg from [ffmpeg.org](https://ffmpeg.org/download.html).
    - Add the `bin` folder to your system's **PATH**.
    - Verify by running `ffmpeg -version`.

## Configuration

1.  **Get a YouTube API Key**:

    - Go to [Google Cloud Console](https://console.cloud.google.com/).
    - Create a project and enable **YouTube Data API v3**.
    - Create an API Key.

2.  **Create Environment File**:
    - Create a file named `.env` in the root directory.
    - Add the following content:
      ```env
      PORT=3000
      YOUTUBE_API_KEY=your_actual_api_key_here
      ```

## Running the Server

### Using Docker

1.  Build and start the container:
    ```bash
    docker-compose up -d --build
    ```
2.  The server will be running at `http://localhost:3000`.

### Manual Run

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Start the server:
    ```bash
    npm start
    ```

## Usage on Windows 98

1.  Ensure the Windows 98 machine is on the same network as the host.
2.  Open Internet Explorer 6.
3.  Navigate to `http://<HOST_IP_ADDRESS>:3000`.
4.  Search for a video or browse the homepage.
5.  Click "Start Conversion" on a video page to transcode it for WMP 6.4.

## Notes

- The `cache` folder stores downloaded videos. It is ignored by git but will persist in Docker volumes or local storage.
- The interface is designed for 800x600 or 1024x768 resolution.
