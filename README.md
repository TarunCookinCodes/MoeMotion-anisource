# HLS Streams Scraper & Proxy for MoeMotion

High-performance HLS streams scraper with multi-audio extraction and reverse proxying for streaming players.

## Features
- **Scrape & Stream Extraction:** Scrapes anime sources (`hsub`, `sub`, `dub`) with direct M3U8 extraction.
- **Worker & Direct M3U8 Support:** Resolves Cloudflare worker streams (e.g. `vibevibe.workers.dev`) and embed players.
- **M3U8 Reverse Proxy:** Automatically rewrites child playlists (`chunklist.m3u8`), segments (`.ts`/`.m4s`), and AES decryption keys (`#EXT-X-KEY`).
- **Deploy Anywhere:** Ready for Netlify, Vercel, Render, Railway, or local Node.

## Endpoints
- `GET /search?q=one+piece` - Search anime titles
- `GET /scrape?slug=one-piece&ep=1[&type=sub|dub|hsub]` - Scrape all or filtered audio streams
- `GET /extract?url=ENCODED_URL` - Extract M3U8 stream from an embed or worker URL
- `GET /proxy?url=ENCODED_M3U8_URL&ref=ENCODED_REFERER` - Reverse proxy M3U8 manifest
- `GET /segment?url=ENCODED_TS_URL&ref=ENCODED_REFERER` - Proxy video segments (supports `Range` header)
- `GET /key?url=ENCODED_KEY_URL&ref=ENCODED_REFERER` - Proxy AES-128 encryption key
- `GET /debug-html?slug=one-piece&ep=1` - Debug raw page parsing

## Local Development
```bash
npm install
npm start
```
Default port: `3000`.
