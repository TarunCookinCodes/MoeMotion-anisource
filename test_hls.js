import assert from "node:assert"

function normalizeUrl(url, base) {
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
}

function rewriteManifest(manifestText, baseUrl, proxyHost, ref) {
  return manifestText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line

      if (trimmed.startsWith("#")) {
        return line.replace(/URI=["']([^"']+)["']/i, (_, uriVal) => {
          const absKeyUrl = normalizeUrl(uriVal, baseUrl)
          const proxiedKey = `${proxyHost}/key?url=${encodeURIComponent(absKeyUrl)}&ref=${encodeURIComponent(ref)}`
          return `URI="${proxiedKey}"`
        })
      }

      const absoluteUrl = normalizeUrl(trimmed, baseUrl)
      if (absoluteUrl.includes(".m3u8")) {
        return `${proxyHost}/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
      } else {
        return `${proxyHost}/segment?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`
      }
    })
    .join("\n")
}

// Self checks
const sampleManifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x01
#EXTINF:4.000,
segment0.ts
#EXT-X-STREAM-INF:BANDWIDTH=1280000
chunklist.m3u8`

const rewritten = rewriteManifest(
  sampleManifest,
  "https://cdn.example.com/hls/",
  "https://my-api.com",
  "https://example.com"
)

assert(rewritten.includes('URI="https://my-api.com/key?url='), "Key URI rewriting failed")
assert(rewritten.includes('https://my-api.com/segment?url='), "Segment URI rewriting failed")
assert(rewritten.includes('https://my-api.com/proxy?url='), "Sub-manifest URI rewriting failed")

console.log("All HLS manifest rewrite asserts passed.")
