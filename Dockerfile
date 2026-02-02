FROM node:22-alpine

# Install FFmpeg (required for transcoding) and upgrade system packages for security
# We use the alpine package instead of ffmpeg-static to keep the image smaller and compatible
RUN apk update && apk upgrade --no-cache && apk add --no-cache ffmpeg openssl

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
