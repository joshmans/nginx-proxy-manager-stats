# Nginx Proxy Manager with Traffic Statistics

This fork is [Nginx Proxy Manager](https://github.com/NginxProxyManager/nginx-proxy-manager) plus an
optional **Traffic Statistics** feature: request, status-code, bandwidth, client IP/path/country and
per-host statistics on the dashboard, built from the access logs NPM already writes.
It is off by default, so with the switch off the image behaves like upstream.

Features and settings are described in [docs/src/traffic-stats/index.md](docs/src/traffic-stats/index.md).
The same change is proposed upstream; if it is merged there, switch back to the official image.

## Install

The image is published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

```
ghcr.io/joshmans/nginx-proxy-manager-stats:latest
```

Use it exactly as you would use `jc21/nginx-proxy-manager`, with the same ports, volumes and environment.

### Docker Compose

```yml
services:
  app:
    image: 'ghcr.io/joshmans/nginx-proxy-manager-stats:latest'
    restart: unless-stopped
    ports:
      - '80:80'
      - '81:81'
      - '443:443'
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
```

### Unraid

Edit the NPM container and set **Repository** to `ghcr.io/joshmans/nginx-proxy-manager-stats:latest`.
Keep the existing paths and ports. Updating from the Docker tab then pulls this fork.

### Switching from the official image

1. **Back up** your `data` and `letsencrypt` folders first.
2. Change the image to the one above and recreate the container.

The fork adds database tables, which are created on first start. That migration is one way: going back
to the official image afterwards is untested and may be refused, so keep the backup if you want to return.

## Turn it on

Open **Settings > Traffic Statistics** as an administrator and switch on **Collect traffic statistics**.
Existing logs are imported straight away. Client countries, exact status codes, retention and an
optional InfluxDB target are in the same tab.

## Updating

`latest` follows the newest release of this fork. Releases are tagged `v<upstream version>-stats.<n>`.
The fork tracks upstream's `develop` branch and is rebased or merged when upstream changes.

## Building it yourself

```
cd frontend && yarn install && yarn locale-compile && yarn build && cd ..
docker build -f docker/Dockerfile -t npm-stats .
```
