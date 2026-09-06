import express from "express"
import axios from "axios"
import * as cheerio from "cheerio"
import cors from "cors"
import serverless from "serverless-http"
import https from "https"
import crypto from "crypto"

const app = express()

app.use(cors({ origin: "*" }))

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

const HIANIME_BASE = "https://hianime.gr"
const MEGAPLAY_BASE = "https://megaplay.buzz"
const GOGO_STREAM_BASE = "https://gogoanime.com.by"

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || ""

function getBaseUrl(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http"
  const host = req.get("host") || "localhost:3000"
  return `${proto}://${host}`
}

const KNOWN_EP_OFFSETS = {
  "one-piece": 2142,
  "one-piece-odmau": 2142,
}

function decryptEnc(encStr) {
  try {
    let b64 = encStr.replace(/-/g, "+").replace(/_/g, "/")
    const mod = b64.length % 4
    if (mod) b64 += "=".repeat(4 - mod)
    const encryptedBuf = Buffer.from(b64, "base64")

    const keyStr = "i?LMTAx0Q6,:}50U"
    const key = Buffer.alloc(32)
    Buffer.from(keyStr, "utf-8").copy(key, 0, 0, Math.min(32, keyStr.length))
    const iv = Buffer.from("W0;27ToaUpl_P%'c", "utf-8")

    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)
    let decrypted = decipher.update(encryptedBuf, null, "utf-8")
    decrypted += decipher.final("utf-8")
    return JSON.parse(decrypted)
  } catch (err) {
    console.error("[decryptEnc error]", err.message)
    return null
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "HiAnime / MoeMotion Scraper API",
    publicBase: PUBLIC_BASE,
    endpoints: [
      "GET /search?q=naruto",
      "GET /scrape?slug=one-piece-odmau&ep=1               (returns all sources grouped by audio)",
      "GET /scrape?slug=one-piece-odmau&ep=1&type=sub      (only sub sources)",
      "GET /scrape?slug=one-piece-odmau&ep=1&type=dub      (only dub sources)",
      "GET /scrape?slug=one-piece-odmau&ep=1&type=hsub     (only hardsub sources)",
      "GET /proxy?url=ENCODED_M3U8_URL",
      "GET /segment?url=ENCODED_SEGMENT_URL",
      "GET /debug-html?slug=one-piece-odmau&ep=1",
    ],
  })
})

app.get("/search", async (req, res) => {
  const query = req.query.q
  if (!query) return res.status(400).json({ error: "Missing ?q parameter" })

  try {
    const url = `${HIANIME_BASE}/search?keyword=${encodeURIComponent(query)}`
    const { data: html } = await axios.get(url, { headers: COMMON_HEADERS, httpsAgent, timeout: 9000 })
    const $ = cheerio.load(html)
    const results = []
    const seen = new Set()

    $(".flw-item").each((_, el) => {
      const $el = $(el)
      const $link = $el.find("a[href*='/watch/']").first()
      const href = $link.attr("href") || ""
      const match = href.match(/\/watch\/([^/?#]+)/)
      if (!match) return

      let slug = match[1].replace(/\/ep-\d+.*$/, "")
      if (seen.has(slug)) return
      seen.add(slug)

      let title = $el.find(".film-name a, .dynamic-name").first().text().trim() || $link.attr("title") || ""
      if (!title) {
        title = $el.find(".film-name, .name, .title, h3").first().text().trim()
      }
      const img = $el.find("img").attr("data-src") || $el.find("img").attr("src") || ""

      if (slug && title) {
        results.push({ slug, title: title.split("\n")[0].trim(), image: img })
      }
    })

    if (results.length === 0) {
      $("a[href*='/watch/']").each((_, el) => {
        const $el = $(el)
        const href = $el.attr("href") || ""
        const match = href.match(/\/watch\/([^/?#]+)/)
        if (!match) return

        let slug = match[1].replace(/\/ep-\d+.*$/, "")
        if (seen.has(slug)) return
        seen.add(slug)

        const title = $el.attr("title") || $el.find("img").attr("alt") || $el.text().trim() || slug
        const img = $el.find("img").attr("data-src") || $el.find("img").attr("src") || ""

        if (slug && title && title.length < 200) {
          results.push({ slug, title: title.split("\n")[0].trim(), image: img })
        }
      })
    }

    res.json({ results })
  } catch (err) {
    console.error("[/search]", err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: "Search failed", details: err.message })
    }
  }
})

async function resolveEpisodeId(slug, epNumStr) {
  const epNum = parseInt(epNumStr, 10)
  
  // If epNumStr is already a numeric ID
  if (!isNaN(epNum) && epNum > 2000) {
    return epNum
  }

  // Check known offset map
  const cleanSlug = slug.toLowerCase().trim()
  if (KNOWN_EP_OFFSETS[cleanSlug] && !isNaN(epNum)) {
    return KNOWN_EP_OFFSETS[cleanSlug] + (epNum - 1)
  }

  // Fetch watch page to extract anime data-id or streaming iframe ep ID
  try {
    const watchUrl = `${HIANIME_BASE}/watch/${slug}/ep-${epNumStr}`
    const { data: watchHtml } = await axios.get(watchUrl, { headers: COMMON_HEADERS, httpsAgent, timeout: 9000 })
    const $ = cheerio.load(watchHtml)

    const streamingMatch = watchHtml.match(/ep=(\d+)/i)
    if (streamingMatch) {
      return parseInt(streamingMatch[1], 10)
    }

    const animeId = $("[data-id]").first().attr("data-id")
    if (animeId) {
      const listUrl = `${HIANIME_BASE}/ajax/episode/list/${animeId}`
      const { data: listData } = await axios.get(listUrl, {
        headers: { ...COMMON_HEADERS, "X-Requested-With": "XMLHttpRequest" },
        httpsAgent,
        timeout: 9000
      })
      const listHtml = listData.html || listData.result || listData
      const $l = cheerio.load(listHtml)

      let foundEpId = null
      $l(".ssl-item.ep-item").each((idx, el) => {
        const num = $l(el).attr("data-num") || $l(el).attr("data-slug")
        if (String(num) === String(epNumStr) || idx + 1 === epNum) {
          const epIdAttr = $l(el).attr("data-id") || $l(el).attr("data-ep-id")
          if (epIdAttr && !isNaN(parseInt(epIdAttr, 10))) {
            foundEpId = parseInt(epIdAttr, 10)
          }
        }
      })
      if (foundEpId) return foundEpId
    }
  } catch (err) {
    console.error("[resolveEpisodeId]", err.message)
  }

  if (!isNaN(epNum)) {
    return 2141 + epNum
  }
  return 2142
}

async function getMegaplayStream(epId, audioType = "sub") {
  try {
    const url = `${MEGAPLAY_BASE}/stream/getSources?id=${epId}&type=${audioType}`
    const embedUrl = `${GOGO_STREAM_BASE}/streaming.php?id=none&ep=${epId}&server=none&type=${audioType}&autostart=true`
    
    const res = await axios.get(url, {
      headers: { ...COMMON_HEADERS, Referer: `${MEGAPLAY_BASE}/` },
      httpsAgent,
      timeout: 9000,
    })

    if (res.data && res.data.enc) {
      const decrypted = decryptEnc(res.data.enc)
      if (decrypted && decrypted.file) {
        return {
          serverName: "MegaPlay",
          audio: audioType,
          embedUrl,
          originalEmbedUrl: `${MEGAPLAY_BASE}/stream/s-2/${epId}/${audioType}`,
          m3u8: decrypted.file,
          subtitles: res.data.tracks || [],
          intro: res.data.intro,
          outro: res.data.outro,
        }
      }
    }
  } catch (err) {
    console.error(`[getMegaplayStream ep:${epId}]`, err.message)
  }
  return null
}

app.get("/scrape", async (req, res) => {
  const { slug, ep, type } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep parameter" })

  const requestedType = type && ["sub", "dub", "hsub"].includes(type.toLowerCase())
    ? type.toLowerCase()
    : null

  try {
    const epId = await resolveEpisodeId(slug, ep)
    const base = getBaseUrl(req)

    const audioTypesToFetch = requestedType
      ? [requestedType]
      : ["sub", "dub", "hsub"]

    const results = await Promise.all(
      audioTypesToFetch.map(async (audioType) => {
        try {
          const actualType = audioType === "hsub" ? "sub" : audioType
          const stream = await getMegaplayStream(epId, actualType)
          if (!stream || !stream.m3u8) return null

          const origin = "https://megaplay.buzz/"
          return {
            ...stream,
            audio: audioType,
            proxiedM3u8: `${base}/proxy?url=${encodeURIComponent(stream.m3u8)}&ref=${encodeURIComponent(origin)}`,
          }
        } catch (err) {
          return null
        }
      })
    )

    const sources = results.filter(Boolean)

    if (sources.length === 0) {
      return res.status(500).json({
        error: "No m3u8 extracted from stream provider",
        epId,
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
      attempted: audioTypesToFetch.length,
    })
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Scrape failed", details: err.message })
    }
  }
})

app.get("/proxy", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://megaplay.buzz/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const upstream = await axios.get(url, {
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: ref.replace(/\/$/, "") },
      httpsAgent,
      responseType: "text",
      timeout: 9000,
    })

    let body = String(upstream.data || "")
    const baseUrl = url.substring(0, url.lastIndexOf("/") + 1)
    const base = getBaseUrl(req)

    body = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) return line
        try {
          const absoluteUrl = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href
          if (absoluteUrl.includes(".m3u8")) {
            return `${base}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
          } else {
            return `${base}/segment?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
          }
        } catch {
          return line
        }
      })
      .join("\n")

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Cache-Control", "no-cache")
    res.send(body)
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send("Proxy failed: " + err.message)
    }
  }
})

app.get("/segment", async (req, res) => {
  const url = req.query.url
  const ref = req.query.ref || "https://megaplay.buzz/"
  if (!url) return res.status(400).send("Missing url")

  try {
    const upstream = await axios.get(url, {
      headers: { ...COMMON_HEADERS, Referer: ref, Origin: ref.replace(/\/$/, "") },
      httpsAgent,
      responseType: "arraybuffer",
      timeout: 15000,
    })

    res.setHeader("Content-Type", "video/mp2t")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Cache-Control", "public, max-age=3600")
    res.send(Buffer.from(upstream.data))
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send("Segment failed: " + err.message)
    }
  }
})

app.get("/debug-html", async (req, res) => {
  const { slug, ep } = req.query
  if (!slug || !ep) return res.status(400).json({ error: "Missing slug or ep" })
  try {
    const epId = await resolveEpisodeId(slug, ep)
    const stream = await getMegaplayStream(epId, "sub")
    res.json({
      slug,
      ep,
      epId,
      stream,
    })
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) })
    }
  }
})

app.use((err, req, res, next) => {
  console.error("[Global Error]", err)
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || "Internal server error" })
  }
})

const handler = serverless(app, {
  binary: ["*/*", "video/*", "image/*", "application/octet-stream", "video/mp2t"],
})
export { app, handler }
