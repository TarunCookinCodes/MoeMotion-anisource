import axios from "axios"

const SOURCES = {
  anineko: "https://anineko.to",
  reanime: "https://reanime.to",
  anikoto: "https://anikototv.to",
  animepahe: "https://animepahe.ru",
}

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

async function testSite(name, searchUrl, scrapeUrl) {
  console.log(`\n================ Testing ${name} ================`)
  
  // 1. Search Test
  try {
    const res = await axios.get(searchUrl, { headers: COMMON_HEADERS, timeout: 10000 })
    console.log(`[${name}] Search status:`, res.status, `(data length: ${res.data.length || 0})`)
  } catch (err) {
    console.log(`[${name}] Search test failed/blocked:`, err.message)
  }

  // 2. Scrape Test
  try {
    const res = await axios.get(scrapeUrl, { headers: COMMON_HEADERS, timeout: 10000 })
    console.log(`[${name}] Scrape page status:`, res.status)
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data)
    const hasVideos = text.includes("data-video=") || text.includes("master.m3u8") || text.includes("iframe")
    console.log(`[${name}] Video/embeds detected in HTML:`, hasVideos)
  } catch (err) {
    console.log(`[${name}] Scrape page failed/blocked:`, err.message)
  }
}

async function runAll() {
  await testSite(
    "AniNeko",
    `${SOURCES.anineko}/browser?keyword=one-piece`,
    `${SOURCES.anineko}/watch/classroom-of-the-elite-iv/ep-1`
  )
  await testSite(
    "ReAnime",
    `${SOURCES.reanime}/browser?keyword=one-piece`,
    `${SOURCES.reanime}/watch/one-piece/ep-1`
  )
  await testSite(
    "Anikoto",
    `${SOURCES.anikoto}/search?keyword=one-piece`,
    `${SOURCES.anikoto}/watch/one-piece/ep-1`
  )
  await testSite(
    "AnimePahe",
    `${SOURCES.animepahe}/api?m=search&q=one+piece`,
    `${SOURCES.animepahe}/play/4347`
  )
}

runAll()
