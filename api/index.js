import express from "express"
import axios from "axios"
import * as cheerio from "cheerio"
import cors from "cors"

const app = express()
app.use(cors({ origin: "*" }))

const ANINEKO_BASE = "https://anineko.to"
const ANITAKU_BASE = "https://anitaku.com.ro"
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://moescrapper.netlify.app"
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

function getOrigin(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.hostname}/`
  } catch {
    return "https://vivibebe.site/"
  }
}

function getServerName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    if (host.includes("vivibebe")) return "VibePlayer"
    if (host.includes("bibiemb")) return "BibiEmb"
    if (host.includes("otakuhg")) return "OtakuHG"
    if (host.includes("otakuvid")) return "OtakuVid"
    if (host.includes("playmogo")) return "PlayMogo"
    if (host.includes("gogo") || host.includes("anitaku")) return "AniTaku"
    return host.split(".")[0]
  } catch {
    return "Unknown"
  }
}

function groupVideosByAudio(html) {
  const groups = { hsub: [], sub: [], dub: [] }
  const markers = []
  const markerRegex = /data-id=["'](hsub|sub|dub)["']/gi
  let match
  while ((match = markerRegex.exec(html)) !== null) markers.push({ pos: match.index, type: match[1].toLowerCase() })

  const videoRegex = /data-video=["']([^"']+)["']/gi
  while ((match = videoRegex.exec(html)) !== null) {
    const url = match[1]
    let type = null
    for (let i = markers.length - 1; i >= 0; i--) {
      if (markers[i].pos < match.index) {
        type = markers[i].type
        break
      }
    }
    if (!type || !groups[type]) continue
    const clean = url.split("?")[0]
    if (!groups[type].some((item) => item.split("?")[0] === clean)) groups[type].push(url)
  }
  return groups
}

async function extractM3u8FromEmbed(iframeUrl, referer = `${ANINEKO_BASE}/`) {
  const { data: html } = await axios.get(iframeUrl, {
    headers: { ...COMMON_HEADERS, Referer: referer },
    timeout: 9000,
  })
  const master = html.match(/https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*/i)
  if (master) return master[0]
  const generic = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
  if (generic) return generic[0]
  const source = html.match(/(?:file|source|src)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i)
  if (source) return source[1]
  for (const base64 of html.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []) {
    try {
      const decoded = Buffer.from(base64, "base64").toString("utf-8")
      if (!decoded.includes(".m3u8")) continue
      const found = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
      if (found) return found[0]
    } catch {}
  }
  return null
}

async function buildSource(url, audio, referer) {
  const cleanUrl = url.split("?")[0]
  const m3u8 = await extractM3u8FromEmbed(cleanUrl, referer)
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
}

async function scrapeAnineko(slug, ep, requestedType) {
  const pageUrl = `${ANINEKO_BASE}/watch/${slug}/ep-${ep}`
  const { data: html } = await axios.get(pageUrl, { headers: COMMON_HEADERS, timeout: 9000 })
  const grouped = groupVideosByAudio(html)
  const jobs = []
  for (const audio of requestedType ? [requestedType] : ["hsub", "sub", "dub"]) {
    for (const url of grouped[audio] || []) jobs.push({ url, audio })
  }
  const sources = (await Promise.all(jobs.map(async ({ url, audio }) => {
    try { return await buildSource(url, audio, `${ANINEKO_BASE}/`) } catch { return null }
  }))).filter(Boolean)
  return { sources, pageUrl, provider: "anineko" }
}

async function searchAnitaku(query) {
  const url = `${ANITAKU_BASE}/search.html?keyword=${encodeURIComponent(query)}`
  const { data: html } = await axios.get(url, { headers: { ...COMMON_HEADERS, Referer: `${ANITAKU_BASE}/` }, timeout: 9000 })
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()
  $("a[href*='/category/'], a[href*='/anime/']").each((_, el) => {
    const href = $(el).attr("href") || ""
    const match = href.match(/\/(?:category|anime)\/([^/?#]+)/)
    if (!match || seen.has(match[1])) return
    seen.add(match[1])
    const title = $(el).attr("title") || $(el).find("img").attr("alt") || $(el).text().trim() || match[1]
    const image = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || ""
    results.push({ slug: match[1], title, image, provider: "anitaku" })
  })
  return results
}

async function scrapeAnitaku(slug, ep, requestedType) {
  const pageUrl = `${ANITAKU_BASE}/${slug}-episode-${ep}`
  const { data: html } = await axios.get(pageUrl, { headers: { ...COMMON_HEADERS, Referer: `${ANITAKU_BASE}/` }, timeout: 9000 })
  const $ = cheerio.load(html)
  const embeds = new Set()

  $("iframe, a[href*='streaming.php'], a[href*='embed'], a[data-video], li[data-video], [data-video]").each((_, el) => {
    const value = $(el).attr("src") || $(el).attr("data-video") || $(el).attr("href") || ""
    if (value && /https?:\/\//i.test(value)) embeds.add(value.split("?")[0])
  })

  for (const match of html.matchAll(/(?:data-video|data-src|href)=["'](https?:\/\/[^"']+)["']/gi)) {
    if (/embed|streaming|player|gogo|anitaku|vivibebe|play/i.test(match[1])) embeds.add(match[1].split("?")[0])
  }

  const jobs = [...embeds].map((url) => ({
    url,
    audio: requestedType || (/(?:-dub|\/dub|audio=dub)/i.test(url) ? "dub" : "sub"),
  }))

  const sources = (await Promise.all(jobs.map(async ({ url, audio }) => {
    try { return await buildSource(url, audio, `${ANITAKU_BASE}/`) } catch { return null }
  }))).filter(Boolean)

  return { sources, pageUrl, provider: "anitaku" }
}

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "MoeMotion Scraper",
    publicBase: PUBLIC_BASE,
    providers: ["anineko.to", "anitaku.com.ro"],
    endpoints: [
      "GET /search?q=naruto",
      "GET /scrape?slug=one-piece&ep=1",
      "GET /scrape?slug=one-piece&ep=1&type=sub",
      "GET /scrape?slug=one-piece&ep=1&source=anitaku",
      "GET /proxy?url=ENCODED_M3U8_URL",
      "GET /segment?url=ENCODED_SEGMENT_URL",
    ],
  })
})

app.get("/search", async (req, res) => {
  const query = req.query.q
  if (!query) return res.status(400).json({ error: "Missing ?q parameter" })
  try {
    const [aninekoHtml, anitaku] = await Promise.all([
      axios.get(`${ANINEKO_BASE}/browser?keyword=${encodeURIComponent(query)}`, { headers: COMMON_HEADERS, timeout: 9000 }).then((r) => r.data).catch(() => ""),
      searchAnitaku(query).catch(() => []),
    ])

    const $ = cheerio.load(aninekoHtml || "")
    const results = []
    const seen = new Set()
    $("a[href*='/watch/']").each((_, el) => {
      const href = $(el).attr("href") || ""
      const match = href.match(/\/watch\/([^/?#]+)/)
      if (!match || seen.has(match[1])) return
      seen.add(match[1])
      results.push({
        slug: match[1],
        title: $(el).attr("title") || $(el).find("img").attr("alt") || $(el).text().trim().slice(0, 100) || match[1],
        image: $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || "",
        provider: "anineko",
      })
    })

    for (const item of anitaku) {
      if (seen.has(item.slug)) continue
      seen.add(item.slug)
      results.push(item)
    }

    res.json({ results })
  } catch (err) {
    res.status(500).json({ error: "Search failed", details: err.message })
  }
})

app.get("/scrape", async (req, res) => {
  const { slug, ep, type, source } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep parameter" })
  const requestedType = type && ["sub", "dub", "hsub"].includes(String(type).toLowerCase()) ? String(type).toLowerCase() : null
  const preferred = source && ["anineko", "anitaku"].includes(String(source).toLowerCase()) ? String(source).toLowerCase() : null

  try {
    const order = preferred === "anitaku" ? ["anitaku", "anineko"] : preferred === "anineko" ? ["anineko", "anitaku"] : ["anineko", "anitaku"]
    let sources = []
    let used = null
    for (const provider of order) {
      try {
        const result = provider === "anitaku" ? await scrapeAnitaku(slug, ep, requestedType) : await scrapeAnineko(slug, ep, requestedType)
        if (result.sources.length) {
          sources = result.sources
          used = result
          break
        }
      } catch (err) {
        console.warn(`[scrape:${provider}]`, err.message)
      }
    }

    if (!sources.length) return res.status(404).json({ error: "No streams found from anineko.to or anitaku.com.ro", slug, ep })

    const byAudio = {
      hsub: sources.filter((s) => s.audio === "hsub"),
      sub: sources.filter((s) => s.audio === "sub"),
      dub: sources.filter((s) => s.audio === "dub"),
    }

    res.json({
      sources,
      byAudio,
      counts: { hsub: byAudio.hsub.length, sub: byAudio.sub.length, dub: byAudio.dub.length, total: sources.length },
      provider: used?.provider,
      pageUrl: used?.pageUrl,
      attempted: sources.length,
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
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: String(ref).replace(/\/$/, "") },
      responseType: "text",
      timeout: 9000,
    })
    const baseUrl = String(url).substring(0, String(url).lastIndexOf("/") + 1)
    const body = String(upstream.data)
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) return line
        const absoluteUrl = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href
        return absoluteUrl.includes(".m3u8")
          ? `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
          : `${PUBLIC_BASE}/segment?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
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
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: String(ref).replace(/\/$/, "") },
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

export default app
