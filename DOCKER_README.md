# 98Tuber Docker Setup

## Prerequisites

1. Ensure your existing Traefik container is running on a network named `traefik_proxy`.

   - If your Traefik network has a different name, update the `networks` section in `docker-compose.yml`.
   - You can check your networks with: `docker network ls`

2. Ensure you have a `.env` file with your `YOUTUBE_API_KEY`.

## Running the Container

1. Build and start the container:

   ```bash
   docker-compose up -d --build
   ```

2. Update your hosts file (or DNS server) to point `youtube.home.local` to your Docker host's IP address.

3. Access the site at `http://youtube.home.local`.

## Notes

- This setup uses the system FFmpeg installed in the Alpine image, which is lighter than the static binary.
- The `cache` folder is mounted as a volume, so downloaded videos persist across restarts.
