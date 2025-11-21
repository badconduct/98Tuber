FROM node:22-alpine

# Install FFmpeg (required for transcoding)
# We use the alpine package instead of ffmpeg-static to keep the image smaller and compatible
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./

# Install dependencies
# We include optional dependencies because 'sharp' needs platform-specific binaries (linuxmusl)
# Install nodemon globally to ensure it's available in the path, avoiding issues with volume mounting
RUN npm install -g nodemon
RUN npm install

COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
