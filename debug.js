import axios from "axios"

const url = "https://anineko.to/watch/one-piece/ep-1"

const res = await axios.get(url, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  timeout: 15000,
})

const html = res.data

console.log("─── ALL iframe occurrences ───")
const iframeMatches = html.match(/<iframe[^>]*>/gi) || []
iframeMatches.forEach((m, i) => {
  console.log(`\n[${i}]`, m)
})

console.log("\n─── ALL vivibebe occurrences ───")
const vivibebeMatches = html.match(/[^\s"'<>]*vivibebe[^\s"'<>]*/gi) || []
vivibebeMatches.slice(0, 10).forEach((m, i) => {
  console.log(`\n[${i}]`, m)
})

console.log("\n─── data-src attributes ───")
const dataSrcMatches = html.match(/data-src=["'][^"']+["']/gi) || []
dataSrcMatches.slice(0, 10).forEach((m, i) => {
  console.log(`[${i}]`, m)
})

console.log("\n─── data-video attributes ───")
const dataVideoMatches = html.match(/data-video=["'][^"']+["']/gi) || []
dataVideoMatches.slice(0, 10).forEach((m, i) => {
  console.log(`[${i}]`, m)
})

console.log("\n─── data-embed attributes ───")
const dataEmbedMatches = html.match(/data-embed=["'][^"']+["']/gi) || []
dataEmbedMatches.slice(0, 10).forEach((m, i) => {
  console.log(`[${i}]`, m)
})