import axios from "axios";
import * as cheerio from "cheerio";

const ANINEKO_BASE = "https://anineko.to";
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

function groupVideosByAudio(html) {
  const groups = { hsub: [], sub: [], dub: [] };
  const markerPositions = [];
  const markerRegex = /data-id=["'](hsub|sub|dub)["']/gi;
  let m;
  while ((m = markerRegex.exec(html)) !== null) {
    markerPositions.push({ pos: m.index, type: m[1].toLowerCase() });
  }

  const videoRegex = /data-video=["']([^"']+)["']/gi;
  let v;
  while ((v = videoRegex.exec(html)) !== null) {
    const url = v[1];
    const pos = v.index;
    let bestType = null;
    for (let i = markerPositions.length - 1; i >= 0; i--) {
      if (markerPositions[i].pos < pos) {
        bestType = markerPositions[i].type;
        break;
      }
    }
    if (bestType && groups[bestType]) {
      const cleanUrl = url.split("?")[0];
      if (!groups[bestType].some((u) => u.split("?")[0] === cleanUrl)) {
        groups[bestType].push(url);
      }
    }
  }
  return groups;
}

async function extractM3u8FromEmbed(iframeUrl) {
  try {
    const { data: html } = await axios.get(iframeUrl, {
      headers: { ...COMMON_HEADERS, Referer: `${ANINEKO_BASE}/` },
      timeout: 9000,
    });
    const m3u8Master = html.match(/https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*/i);
    if (m3u8Master) return m3u8Master[0];
    const m3u8Generic = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    if (m3u8Generic) return m3u8Generic[0];
    return null;
  } catch (err) {
    return null;
  }
}

async function testScrape(slug, ep) {
  try {
    const epUrl = `${ANINEKO_BASE}/watch/${slug}/ep-${ep}`;
    console.log("Scraping:", epUrl);
    const { data: html } = await axios.get(epUrl, { headers: COMMON_HEADERS });
    const grouped = groupVideosByAudio(html);
    console.log("Grouped counts:", {
      hsub: grouped.hsub.length,
      sub: grouped.sub.length,
      dub: grouped.dub.length
    });

    if (grouped.hsub.length > 0) {
        console.log("Testing first hsub embed:", grouped.hsub[0]);
        const m3u8 = await extractM3u8FromEmbed(grouped.hsub[0]);
        console.log("Extracted m3u8:", m3u8);
    }
  } catch (err) {
    console.error("Scrape failed:", err.message);
  }
}

testScrape("one-piece", "1116");
