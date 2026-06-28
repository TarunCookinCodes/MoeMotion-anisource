import express from "express"
import axios from "axios"
import * as cheerio from "cheerio"
import cors from "cors"

const app = express()

app.use(cors({ origin: "*" }))

const ANINEKO_BASE = "https://anineko.to"
const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

// PUBLIC base URL where this scraper is hosted (so we can rewrite proxy URLs)
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://anineko-scraper.vercel.app"

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "AniNeko Scraper",
    publicBase: PUBLIC_BASE,
    endpoints: [
      "GET /search?q=naruto",
      "GET /scrape?slug=one-piece&ep=1",
      "GET /proxy?url=ENCODED_M3U8_URL",
      "GET /segment?url=ENCODED_SEGMENT_URL",
    ],
  })
})

app.get("/search", async (req, res) => {
  const query = req.query.q
  if (!query) return res.status(400).json({ error: "Missing ?q parameter" })

  try {
    const url = `${ANINEKO_BASE}/browser?keyword=${encodeURIComponent(query)}`
    const { data: html } = await axios.get(url, { headers: COMMON_HEADERS, timeout: 9000 })
    const $ = cheerio.load(html)
    const results = []
    const seen = new Set()

    $("a[href*='/watch/']").each((_, el) => {
      const $el = $(el)
      const href = $el.attr("href") || ""
      const match = href.match(/\/watch\/([^/?#]+)/)
      if (!match) return
      const slug = match[1]
      if (seen.has(slug)) return
      seen.add(slug)

      const title =
        $el.attr("title") ||
        $el.find("img").attr("alt") ||
        $el.find(".name, .title, h3, h4").text().trim() ||
        $el.text().trim().slice(0, 100) ||
        slug.replace(/-/g, " ")

      const img = $el.find("img").attr("src") || $el.find("img").attr("data-src") || ""

      if (slug && title) {
        results.push({ slug, title, image: img })
      }
    })

    res.json({ results })
  } catch (err) {
    console.error("[/search]", err.message)
    res.status(500).json({ error: "Search failed", details: err.message })
  }
})

app.get("/scrape", async (req, res) => {
  const { slug, ep } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep parameter" })

  try {
    const epUrl = `${ANINEKO_BASE}/watch/${slug}/ep-${ep}`
    const { data: html } = await axios.get(epUrl, { headers: COMMON_HEADERS, timeout: 9000 })

    const dataVideoMatches = html.match(/data-video=["']([^"']+)["']/gi) || []
    const embedUrls = dataVideoMatches
      .map((m) => {
        const match = m.match(/data-video=["']([^"']+)["']/i)
        return match ? match[1] : null
      })
      .filter(Boolean)

    if (embedUrls.length === 0) {
      return res.status(404).json({ error: "No video servers found", url: epUrl })
    }

    console.log(`[scrape] Found ${embedUrls.length} embed servers for ${slug}/ep-${ep}`)

    const results = await Promise.all(
      embedUrls.map(async (embedUrl) => {
        try {
          const cleanUrl = embedUrl.split("?")[0]
          const m3u8 = await extractM3u8FromEmbed(cleanUrl)
          if (!m3u8) return null

          const origin = getOrigin(cleanUrl)
          return {
            serverName: getServerName(cleanUrl),
            embedUrl: cleanUrl,
            m3u8,
            // FULL absolute URL so client doesn't have to know our base
            proxiedM3u8: `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(m3u8)}&ref=${encodeURIComponent(origin)}`,
          }
        } catch (err) {
          console.warn(`[scrape] Failed ${embedUrl}:`, err.message)
          return null
        }
      }),
    )

    const sources = results.filter(Boolean)

    if (sources.length === 0) {
      return res.status(500).json({
        error: "No m3u8 extracted from any embed",
        embedsFound: embedUrls,
      })
    }

    res.json({ sources, total: sources.length, attempted: embedUrls.length })
  } catch (err) {
    console.error("[/scrape]", err.message)
    res.status(500).json({ error: "Scrape failed", details: err.message })
  }
})

// PROXY for master.m3u8 and quality variant playlists
app.get("/proxy", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://vivibebe.site/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const upstream = await axios.get(url, {
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: ref.replace(/\/$/, "") },
      responseType: "text",
      timeout: 9000,
    })

    let body = upstream.data
    // Base URL of the FETCHED file (so relative paths resolve)
    const baseUrl = url.substring(0, url.lastIndexOf("/") + 1)

    // Rewrite each line of the m3u8 playlist
    body = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        // Skip comments/empty lines
        if (!trimmed || trimmed.startsWith("#")) return line

        // It's a URL — make it absolute
        const absoluteUrl = trimmed.startsWith("http")
          ? trimmed
          : new URL(trimmed, baseUrl).href

        // Route to appropriate proxy endpoint based on extension
        if (absoluteUrl.includes(".m3u8")) {
          return `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        } else {
          // Assume .ts segment or anything else
          return `${PUBLIC_BASE}/segment?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        }
      })
      .join("\n")

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Cache-Control", "no-cache")
    res.send(body)
  } catch (err) {
    console.error("[/proxy]", err.message)
    res.status(502).send("Proxy failed: " + err.message)
  }
})

app.get("/segment", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://vivibebe.site/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const upstream = await axios.get(url, {
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: ref.replace(/\/$/, "") },
      responseType: "stream",
      timeout: 9000,
    })

    res.setHeader("Content-Type", "video/mp2t")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Cache-Control", "public, max-age=3600")
    upstream.data.pipe(res)
  } catch (err) {
    console.error("[/segment]", err.message)
    res.status(502).send("Segment failed: " + err.message)
  }
})

async function extractM3u8FromEmbed(iframeUrl) {
  const { data: html } = await axios.get(iframeUrl, {
    headers: { ...COMMON_HEADERS, Referer: `${ANINEKO_BASE}/` },
    timeout: 9000,
  })

  const m3u8Master = html.match(/https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*/i)
  if (m3u8Master) return m3u8Master[0]

  const m3u8Generic = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
  if (m3u8Generic) return m3u8Generic[0]

  const sourceMatch = html.match(/(?:file|source|src)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i)
  if (sourceMatch) return sourceMatch[1]

  const base64Matches = html.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []
  for (const b64 of base64Matches) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8")
      if (decoded.includes(".m3u8")) {
        const found = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
        if (found) return found[0]
      }
    } catch {}
  }

  return null
}

function getOrigin(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.hostname}/`
  } catch {
    return "https://vivibebe.site/"
  }
}

function getServerName(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")
    if (host.includes("vivibebe")) return "VibePlayer"
    if (host.includes("bibiemb")) return "BibiEmb"
    if (host.includes("otakuhg")) return "OtakuHG"
    if (host.includes("otakuvid")) return "OtakuVid"
    if (host.includes("playmogo")) return "PlayMogo"
    return host.split(".")[0]
  } catch {
    return "Unknown"
  }
}

// DEBUG: Returns the raw HTML so we can see what's actually on the page
app.get("/debug-html", async (req, res) => {
  const { slug, ep } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep" })

  try {
    const epUrl = `${ANINEKO_BASE}/watch/${slug}/ep-${ep}`
    const { data: html } = await axios.get(epUrl, { headers: COMMON_HEADERS, timeout: 9000 })

    // Find all data-* attributes that look like video sources
    const dataVideoMatches = html.match(/data-video=["']([^"']+)["']/gi) || []
    const dataSrcMatches = html.match(/data-src=["']([^"']+)["']/gi) || []
    const dataEmbedMatches = html.match(/data-embed=["']([^"']+)["']/gi) || []
    const dataIdMatches = html.match(/data-id=["']([^"']+)["']/gi) || []
    const dataServerMatches = html.match(/data-server=["']([^"']+)["']/gi) || []

    // Find anything that looks like a CDN URL
    const cdnHints = html.match(/https?:\/\/[a-z0-9-]+\.(?:site|xyz|workers\.dev|com|net)\/[a-z0-9]+/gi) || []

    // Find server containers
    const serverContainers = html.match(/<(?:div|ul|li)[^>]*(?:server|episode|player)[^>]*>/gi) || []

    res.json({
      url: epUrl,
      htmlLength: html.length,
      dataVideo: {
        count: dataVideoMatches.length,
        samples: dataVideoMatches.slice(0, 10),
      },
      dataSrc: {
        count: dataSrcMatches.length,
        samples: dataSrcMatches.slice(0, 10),
      },
      dataEmbed: {
        count: dataEmbedMatches.length,
        samples: dataEmbedMatches.slice(0, 10),
      },
      dataId: {
        count: dataIdMatches.length,
        samples: dataIdMatches.slice(0, 10),
      },
      dataServer: {
        count: dataServerMatches.length,
        samples: dataServerMatches.slice(0, 10),
      },
      cdnHints: {
        count: cdnHints.length,
        samples: [...new Set(cdnHints)].slice(0, 20),
      },
      serverContainers: serverContainers.slice(0, 5),
      firstChars: html.substring(0, 500),
      // Search for the word "DUB" in context
      dubContext: (html.match(/.{200}DUB.{200}/i) || [])[0]?.substring(0, 600) || "no DUB mention found",
      subContext: (html.match(/.{200}SUB.{200}/i) || [])[0]?.substring(0, 600) || "no SUB mention found",
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default app
