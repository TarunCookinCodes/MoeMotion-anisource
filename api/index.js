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

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://anineko-scraper.vercel.app"

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

/**
 * Group data-video URLs by their audio type (hsub/sub/dub) using a heuristic:
 *   - Find positions of all data-id="hsub|sub|dub" markers in the raw HTML
 *   - For each data-video, find which audio marker is the CLOSEST preceding one
 *   - That marker's audio type becomes that video's group
 *
 * Why this works: AniNeko renders audio tabs as <li data-id="sub"> followed by
 * their server <li data-video="..."> entries. So every video URL appears AFTER
 * an audio marker but BEFORE the next audio marker.
 */
function groupVideosByAudio(html) {
  const groups = { hsub: [], sub: [], dub: [] }

  // Find positions of all audio-type markers
  const markerPositions = []
  const markerRegex = /data-id=["'](hsub|sub|dub)["']/gi
  let m
  while ((m = markerRegex.exec(html)) !== null) {
    markerPositions.push({ pos: m.index, type: m[1].toLowerCase() })
  }

  // Find all data-video entries with their positions
  const videoRegex = /data-video=["']([^"']+)["']/gi
  let v
  while ((v = videoRegex.exec(html)) !== null) {
    const url = v[1]
    const pos = v.index

    // Find the closest preceding marker
    let bestType = null
    for (let i = markerPositions.length - 1; i >= 0; i--) {
      if (markerPositions[i].pos < pos) {
        bestType = markerPositions[i].type
        break
      }
    }

    if (bestType && groups[bestType]) {
      // Dedupe by clean URL (strip query params)
      const cleanUrl = url.split("?")[0]
      if (!groups[bestType].some((u) => u.split("?")[0] === cleanUrl)) {
        groups[bestType].push(url)
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

    console.log(
      `[scrape] ${slug}/ep-${ep} — hsub:${grouped.hsub.length} sub:${grouped.sub.length} dub:${grouped.dub.length}`,
    )

    // Decide which embeds to process
    let toProcess = []
    if (requestedType) {
      toProcess = grouped[requestedType].map((url) => ({ url, audio: requestedType }))
    } else {
      // All types
      for (const audio of ["hsub", "sub", "dub"]) {
        for (const url of grouped[audio]) {
          toProcess.push({ url, audio })
        }
      }
    }

    // Extract m3u8 from each in parallel
    const results = await Promise.all(
      toProcess.map(async ({ url, audio }) => {
        try {
          const cleanUrl = url.split("?")[0]
          const m3u8 = await extractM3u8FromEmbed(cleanUrl)
          if (!m3u8) return null

          const origin = getOrigin(cleanUrl)
          return {
            serverName: getServerName(cleanUrl),
            audio,
            embedUrl: cleanUrl,
            originalEmbedUrl: url,
            m3u8,
            proxiedM3u8: `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(m3u8)}&ref=${encodeURIComponent(origin)}`,
          }
        } catch (err) {
          console.warn(`[scrape] Failed ${url}:`, err.message)
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

    // Build per-audio source lists for easy client consumption
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
    console.error("[/scrape]", err.message)
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

    body = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) return line

        const absoluteUrl = trimmed.startsWith("http")
          ? trimmed
          : new URL(trimmed, baseUrl).href

        if (absoluteUrl.includes(".m3u8")) {
          return `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
        } else {
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

export default app
