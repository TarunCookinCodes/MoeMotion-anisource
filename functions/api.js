import express from "express"
import axios from "axios"
import * as cheerio from "cheerio"
import cors from "cors"
import serverless from "serverless-http"

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

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || ""

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "AniNeko Scraper",
    publicBase: PUBLIC_BASE,
    endpoints: [
      "GET /search?q=naruto",
      "GET /scrape?slug=one-piece&ep=1               (returns all sources grouped by audio)",
      "GET /scrape?slug=one-piece&ep=1&type=sub      (only sub sources)",
      "GET /scrape?slug=one-piece&ep=1&type=dub      (only dub sources)",
      "GET /scrape?slug=one-piece&ep=1&type=hsub     (only hardsub sources)",
      "GET /proxy?url=ENCODED_M3U8_URL",
      "GET /segment?url=ENCODED_SEGMENT_URL",
      "GET /debug-html?slug=one-piece&ep=1",
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

    $(".nv-anime-card").each((_, el) => {
      const $el = $(el)
      const $link = $el.find("a[href*='/watch/']").first()
      const href = $link.attr("href") || ""
      const match = href.match(/\/watch\/([^/?#]+)/)
      if (!match) return
      const slug = match[1]
      if (seen.has(slug)) return
      seen.add(slug)

      const title = $el.find(".name, .title, h3, h4").text().trim() || $link.text().trim()
      const img = $el.find("img").attr("src") || $el.find("img").attr("data-src") || ""

      if (slug && title) {
        results.push({ slug, title, image: img })
      }
    })

    if (results.length === 0) {
      $("a[href*='/watch/']").each((_, el) => {
        const $el = $(el)
        const href = $el.attr("href") || ""
        const match = href.match(/\/watch\/([^/?#]+)/)
        if (!match) return
        const slug = match[1]
        if (seen.has(slug)) return
        seen.add(slug)

        const title =
          $el.find(".name, .title, h3, h4").text().trim() ||
          $el.attr("title") ||
          $el.find("img").attr("alt") ||
          $el.text().trim().slice(0, 100) ||
          slug.replace(/-/g, " ")

        const img = $el.find("img").attr("src") || $el.find("img").attr("data-src") || ""

        if (slug && title && title.length < 200) {
          results.push({ slug, title, image: img })
        }
      })
    }

    res.json({ results })
  } catch (err) {
    console.error("[/search]", err.message)
    res.status(500).json({ error: "Search failed", details: err.message })
  }
})

function groupVideosByAudio(html) {
  const groups = { hsub: [], sub: [], dub: [] }
  
  // 1. Identify all audio markers
  const markerRegex = /data-id=["'](hsub|sub|dub|softsub)["']/gi
  const markerPositions = []
  let m
  while ((m = markerRegex.exec(html)) !== null) {
    let type = m[1].toLowerCase()
    if (type === "softsub") type = "sub"
    markerPositions.push({ pos: m.index, type: type })
  }

  // 2. Identify all video entries
  const videoRegex = /data-video=["']([^"']+)["']/gi
  const videoEntries = []
  let v
  while ((v = videoRegex.exec(html)) !== null) {
    videoEntries.push({ url: v[1], pos: v.index })
  }

  // 3. Heuristic: If markers exist, group by preceding marker
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
  } 
  // 4. Fallback: If no markers found but videos exist, put them in 'hsub' as default
  else if (videoEntries.length > 0) {
    for (const entry of videoEntries) {
      const cleanUrl = entry.url.split("?")[0]
      if (!groups.hsub.some((u) => u.split("?")[0] === cleanUrl)) {
        groups.hsub.push(entry.url)
      }
    }
  }

  return groups
}

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
    const totalFound =
      grouped.hsub.length + grouped.sub.length + grouped.dub.length

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

    const results = await Promise.all(
      toProcess.map(async ({ url, audio }) => {
        try {
          const m3u8 = await extractM3u8FromEmbed(url)
          if (!m3u8) return null
          const cleanUrl = url.split("?")[0]
          const origin = getOrigin(cleanUrl)
          const base = PUBLIC_BASE || `https://${req.get('host')}`
          return {
            serverName: getServerName(cleanUrl),
            audio,
            embedUrl: cleanUrl,
            originalEmbedUrl: url,
            m3u8,
            proxiedM3u8: `${base}/proxy?url=${encodeURIComponent(m3u8)}&ref=${encodeURIComponent(origin)}`,
          }
        } catch (err) {
          return null
        }
      }),
    )

    const sources = results.filter(Boolean)

    if (sources.length === 0) {
      return res.status(500).json({
        error: "No m3u8 extracted from any embed",
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
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: ref.replace(/\/$/, "") },
      responseType: "text",
      timeout: 9000,
    })

    let body = upstream.data
        const baseUrl = url.substring(0, url.lastIndexOf("/") + 1)
    const base = PUBLIC_BASE || `https://${req.get('host')}`

    body = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) return line
        const absoluteUrl = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href
        if (absoluteUrl.includes(".m3u8")) {
          return `${base}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        } else {
          return `${base}/segment?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        }
      })
      .join("\n")

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl")
    res.setHeader("Access-Control-Allow-Origin", "*")
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
    res.status(502).send("Segment failed: " + err.message)
  }
})

async function extractM3u8FromEmbed(iframeUrl) {
  try {
    const { data: html } = await axios.get(iframeUrl, {
      headers: { ...COMMON_HEADERS, Referer: `${ANINEKO_BASE}/` },
      timeout: 9000,
    })

    // Priority 1: Direct master.m3u8
    const m3u8Master = html.match(/https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*/i)
    if (m3u8Master) return m3u8Master[0]

    // Priority 2: Standard .m3u8
    const m3u8Generic = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
    if (m3u8Generic) return m3u8Generic[0]

    // Priority 3: Player source definitions
    const sourceMatch = html.match(/(?:file|source|src|link)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i)
    if (sourceMatch) return sourceMatch[1]

    // Priority 4: Base64 encoded URLs
    const b64Regex = /[A-Za-z0-9+/]{40,}={0,2}/g
    const matches = html.match(b64Regex) || []
    for (const b64 of matches) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8')
        if (decoded.includes('.m3u8')) {
          const found = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
          if (found) return found[0]
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error(`[extractM3u8] Error for ${iframeUrl}:`, err.message)
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

const handler = serverless(app)
export { handler }
