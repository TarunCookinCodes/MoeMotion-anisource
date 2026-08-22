import express from "express"
import axios from "axios"
import * as cheerio from "cheerio"
import cors from "cors"
import serverless from "serverless-http"

const app = express()

app.use(cors({ origin: "*" }))
app.use(express.json())

const ANINEKO_BASE = process.env.ANINEKO_BASE || "https://anineko.to"
const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || ""

function getBaseUrl(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE.replace(/\/$/, "")
  const host = req.get("host") || "localhost:3000"
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http"
  return `${proto}://${host}`
}

function normalizeUrl(url, base) {
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
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
    const host = u.hostname.replace(/^www\./, "").toLowerCase()
    if (host.includes("vivibebe")) return "VibePlayer"
    if (host.includes("vibevibe") || host.includes("workers.dev")) return "VibeWorker"
    if (host.includes("bibiemb")) return "BibiEmb"
    if (host.includes("otakuhg")) return "OtakuHG"
    if (host.includes("otakuvid")) return "OtakuVid"
    if (host.includes("playmogo")) return "PlayMogo"
    if (host.includes("megacloud")) return "MegaCloud"
    if (host.includes("rapid-cloud")) return "RapidCloud"
    if (host.includes("streamtape")) return "Streamtape"
    if (host.includes("mp4upload")) return "Mp4Upload"
    return host.split(".")[0]
  } catch {
    return "Unknown"
  }
}

async function extractM3u8FromEmbed(iframeUrl) {
  try {
    const targetUrl = iframeUrl.trim()
    // If target itself is already an m3u8 stream
    if (targetUrl.includes(".m3u8")) {
      return targetUrl
    }

    const { data: html } = await axios.get(targetUrl, {
      headers: {
        ...COMMON_HEADERS,
        Referer: `${ANINEKO_BASE}/`,
      },
      timeout: 9000,
    })

    const text = typeof html === "string" ? html : JSON.stringify(html)

    // Match Cloudflare worker / vibevibe / direct master.m3u8 URLs
    const m3u8Master = text.match(/https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*/i)
    if (m3u8Master) return m3u8Master[0]

    // Match generic .m3u8 URLs (like /index.m3u8 or 360p/index.m3u8)
    const m3u8Generic = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
    if (m3u8Generic) return m3u8Generic[0]

    // Match player source JS objects
    const sourceMatch = text.match(/(?:file|source|src|link)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i)
    if (sourceMatch) return sourceMatch[1]

    // Base64 encoded stream lookup
    const b64Regex = /[A-Za-z0-9+/]{40,}={0,2}/g
    const matches = text.match(b64Regex) || []
    for (const b64 of matches) {
      try {
        const decoded = Buffer.from(b64, "base64").toString("utf-8")
        if (decoded.includes(".m3u8")) {
          const found = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
          if (found) return found[0]
        }
      } catch {}
    }
  } catch (err) {
    console.error(`[extractM3u8] Error for ${iframeUrl}:`, err.message)
  }
  return null
}

function groupVideosByAudio(html) {
  const groups = { hsub: [], sub: [], dub: [] }
  const markerRegex = /data-id=["'](hsub|sub|dub|softsub)["']/gi
  const markerPositions = []
  let m
  while ((m = markerRegex.exec(html)) !== null) {
    let type = m[1].toLowerCase()
    if (type === "softsub") type = "sub"
    markerPositions.push({ pos: m.index, type })
  }

  const videoRegex = /data-video=["']([^"']+)["']/gi
  const videoEntries = []
  let v
  while ((v = videoRegex.exec(html)) !== null) {
    videoEntries.push({ url: v[1], pos: v.index })
  }

  // Also collect any direct m3u8 links if embedded in html
  const directM3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi
  let directMatch
  while ((directMatch = directM3u8Regex.exec(html)) !== null) {
    videoEntries.push({ url: directMatch[0], pos: directMatch.index })
  }

  if (markerPositions.length > 0) {
    for (const entry of videoEntries) {
      let bestType = null
      for (let i = markerPositions.length - 1; i >= 0; i--) {
        if (markerPositions[i].pos < entry.pos) {
          bestType = markerPositions[i].type
          break
        }
      }
      if (bestType && groups[bestType]) {
        const cleanUrl = entry.url.split("?")[0]
        if (!groups[bestType].some((u) => u.split("?")[0] === cleanUrl)) {
          groups[bestType].push(entry.url)
        }
      }
    }
  } else if (videoEntries.length > 0) {
    for (const entry of videoEntries) {
      const cleanUrl = entry.url.split("?")[0]
      if (!groups.hsub.some((u) => u.split("?")[0] === cleanUrl)) {
        groups.hsub.push(entry.url)
      }
    }
  }

  return groups
}

app.get("/", (req, res) => {
  const base = getBaseUrl(req)
  res.json({
    status: "ok",
    service: "HLS Streams Scraper & Proxy",
    publicBase: base,
    endpoints: {
      search: "GET /search?q=classroom-of-the-elite",
      scrape: "GET /scrape?slug=classroom-of-the-elite-iv&ep=1[&type=sub|dub|hsub]",
      extract: "GET /extract?url=ENCODED_EMBED_OR_M3U8_URL",
      proxyM3u8: "GET /proxy?url=ENCODED_M3U8_URL&ref=ENCODED_REFERER",
      proxySegment: "GET /segment?url=ENCODED_SEGMENT_URL&ref=ENCODED_REFERER",
      proxyKey: "GET /key?url=ENCODED_KEY_URL&ref=ENCODED_REFERER",
      debug: "GET /debug-html?slug=classroom-of-the-elite-iv&ep=1",
    },
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

    $(".nv-anime-card, .film-item, a[href*='/watch/']").each((_, el) => {
      const $el = $(el)
      const href = $el.is("a") ? $el.attr("href") : ($el.find("a[href*='/watch/']").first().attr("href") || "")
      const match = href ? href.match(/\/watch\/([^/?#]+)/) : null
      if (!match) return
      const slug = match[1]
      if (seen.has(slug)) return
      seen.add(slug)

      let title =
        $el.find(".name, .title, h3, h4").first().text().trim() ||
        $el.attr("title") ||
        $el.find("img").attr("alt") ||
        $el.text().trim().slice(0, 100) ||
        slug.replace(/-/g, " ")

      title = title.split("\n")[0].trim()
      title = title.replace(/\s+(TV|Movie|Special|OVA|ONA)\s*$/i, "").trim()
      title = title.replace(/\s+CC\s+\d+.*$/i, "").trim()
      const img = $el.find("img").attr("src") || $el.find("img").attr("data-src") || ""

      if (slug && title) {
        results.push({ slug, title, image: img })
      }
    })

    res.json({ results, total: results.length })
  } catch (err) {
    res.status(500).json({ error: "Search failed", details: err.message })
  }
})

app.get("/extract", async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: "Missing ?url parameter" })

  try {
    const streamUrl = await extractM3u8FromEmbed(url)
    if (!streamUrl) {
      return res.status(404).json({ error: "No HLS stream found for given embed" })
    }

    const base = getBaseUrl(req)
    const ref = getOrigin(url)

    res.json({
      originalUrl: url,
      serverName: getServerName(url),
      streamUrl,
      proxiedM3u8: `${base}/proxy?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent(ref)}`,
    })
  } catch (err) {
    res.status(500).json({ error: "Extraction failed", details: err.message })
  }
})

app.get("/scrape", async (req, res) => {
  const { slug, ep, type } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep parameter" })

  const requestedType = type && ["sub", "dub", "hsub"].includes(type.toLowerCase())
    ? type.toLowerCase()
    : null

  try {
    const epUrl = `${ANINEKO_BASE}/watch/${slug}/ep-${ep}`
    const { data: html } = await axios.get(epUrl, { headers: COMMON_HEADERS, timeout: 9000 })

    const grouped = groupVideosByAudio(html)
    const totalFound = grouped.hsub.length + grouped.sub.length + grouped.dub.length

    if (totalFound === 0) {
      return res.status(404).json({
        error: "No video servers found",
        url: epUrl,
      })
    }

    let toProcess = []
    if (requestedType) {
      toProcess = grouped[requestedType].map((url) => ({ url, audio: requestedType }))
    } else {
      for (const audio of ["hsub", "sub", "dub"]) {
        for (const url of grouped[audio]) {
          toProcess.push({ url, audio })
        }
      }
    }

    const base = getBaseUrl(req)
    const results = await Promise.all(
      toProcess.map(async ({ url, audio }) => {
        try {
          const m3u8 = await extractM3u8FromEmbed(url)
          if (!m3u8) return null
          const cleanUrl = url.split("?")[0]
          const origin = getOrigin(cleanUrl)
          return {
            serverName: getServerName(cleanUrl),
            audio,
            embedUrl: cleanUrl,
            originalEmbedUrl: url,
            m3u8,
            proxiedM3u8: `${base}/proxy?url=${encodeURIComponent(m3u8)}&ref=${encodeURIComponent(origin)}`,
          }
        } catch {
          return null
        }
      }),
    )

    const sources = results.filter(Boolean)

    if (sources.length === 0) {
      return res.status(500).json({
        error: "No HLS streams extracted from embed servers",
        groupedCounts: {
          hsub: grouped.hsub.length,
          sub: grouped.sub.length,
          dub: grouped.dub.length,
        },
      })
    }

    const byAudio = {
      hsub: sources.filter((s) => s.audio === "hsub"),
      sub: sources.filter((s) => s.audio === "sub"),
      dub: sources.filter((s) => s.audio === "dub"),
    }

    res.json({
      sources,
      byAudio,
      counts: {
        hsub: byAudio.hsub.length,
        sub: byAudio.sub.length,
        dub: byAudio.dub.length,
        total: sources.length,
      },
      attempted: toProcess.length,
    })
  } catch (err) {
    res.status(500).json({ error: "Scrape failed", details: err.message })
  }
})

app.get("/proxy", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://vivibebe.site/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const upstream = await axios.get(url, {
      headers: {
        ...COMMON_HEADERS,
        Referer: ref,
        Origin: ref.replace(/\/$/, ""),
      },
      responseType: "text",
      timeout: 9000,
    })

    let body = upstream.data
    const baseUrl = url.substring(0, url.lastIndexOf("/") + 1)
    const base = getBaseUrl(req)

    // Rewrite HLS manifest lines
    body = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line

        // Rewrite URI in tags (e.g. #EXT-X-KEY, #EXT-X-MAP)
        if (trimmed.startsWith("#")) {
          return line.replace(/URI=["']([^"']+)["']/i, (_, uriVal) => {
            const absKeyUrl = normalizeUrl(uriVal, baseUrl)
            const proxiedKey = `${base}/key?url=${encodeURIComponent(absKeyUrl)}&ref=${encodeURIComponent(ref)}`
            return `URI="${proxiedKey}"`
          })
        }

        const absoluteUrl = normalizeUrl(trimmed, baseUrl)
        if (absoluteUrl.includes(".m3u8")) {
          return `${base}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        } else {
          return `${base}/segment?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        }
      })
      .join("\n")

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Cache-Control", "no-cache")
    res.send(body)
  } catch (err) {
    res.status(502).send("Proxy failed: " + err.message)
  }
})

app.get("/segment", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://vivibebe.site/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const headers = {
      ...COMMON_HEADERS,
      Referer: ref,
      Origin: ref.replace(/\/$/, ""),
    }
    if (req.headers.range) {
      headers.range = req.headers.range
    }

    const upstream = await axios.get(url, {
      headers,
      responseType: "stream",
      timeout: 12000,
    })

    if (upstream.headers["content-type"]) {
      res.setHeader("Content-Type", upstream.headers["content-type"])
    } else {
      res.setHeader("Content-Type", "video/mp2t")
    }

    if (upstream.headers["content-length"]) {
      res.setHeader("Content-Length", upstream.headers["content-length"])
    }
    if (upstream.headers["content-range"]) {
      res.setHeader("Content-Range", upstream.headers["content-range"])
      res.status(206)
    }

    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Cache-Control", "public, max-age=86400")
    upstream.data.pipe(res)
  } catch (err) {
    res.status(502).send("Segment failed: " + err.message)
  }
})

app.get("/key", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://vivibebe.site/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const upstream = await axios.get(url, {
      headers: {
        ...COMMON_HEADERS,
        Referer: ref,
        Origin: ref.replace(/\/$/, ""),
      },
      responseType: "arraybuffer",
      timeout: 9000,
    })

    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Cache-Control", "public, max-age=86400")
    res.send(Buffer.from(upstream.data))
  } catch (err) {
    res.status(502).send("Key fetch failed: " + err.message)
  }
})

app.get("/debug-html", async (req, res) => {
  const { slug, ep } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep" })
  try {
    const epUrl = `${ANINEKO_BASE}/watch/${slug}/ep-${ep}`
    const { data: html } = await axios.get(epUrl, { headers: COMMON_HEADERS, timeout: 9000 })
    const grouped = groupVideosByAudio(html)
    res.json({
      url: epUrl,
      htmlLength: html.length,
      grouped: {
        hsub: { count: grouped.hsub.length, samples: grouped.hsub.slice(0, 5) },
        sub: { count: grouped.sub.length, samples: grouped.sub.slice(0, 5) },
        dub: { count: grouped.dub.length, samples: grouped.dub.slice(0, 5) },
      },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ponytail: Express wrapper for Netlify/Vercel serverless. Upgrade to fastify/hono if high throughput needed.
const handler = serverless(app)
export { handler }
