import axios from "axios";
import * as cheerio from "cheerio";

const ANINEKO_BASE = "https://anineko.to";
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function testSearch(query) {
  try {
    const url = `${ANINEKO_BASE}/browser?keyword=${encodeURIComponent(query)}`;
    console.log("Searching:", url);
    const { data: html } = await axios.get(url, { headers: COMMON_HEADERS });
    const $ = cheerio.load(html);
    const results = [];
    
    $("a[href*='/watch/']").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      const match = href.match(/\/watch\/([^/?#]+)/);
      if (!match) return;
      const slug = match[1];
      const title = $el.find(".name, .title, h3, h4").text().trim() || $el.text().trim();
      results.push({ slug, title });
    });

    console.log("Results found:", results.length);
    console.log("First 3 results:", results.slice(0, 3));
  } catch (err) {
    console.error("Search failed:", err.message);
  }
}

testSearch("one piece");
