import axios from "axios"

const ANINEKO_BASE = "https://anineko.to"
const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
}

async function testExtractAndProxy() {
  const testUrl = "https://morning-credit-3bcc.vibevibe.workers.dev/ag22a261cdd26c9334fd3dca717b9395044h/master.m3u8"
  console.log("Testing HLS worker stream:", testUrl)

  try {
    const res = await axios.get(testUrl, {
      headers: { ...COMMON_HEADERS, Referer: `${ANINEKO_BASE}/` },
      timeout: 10000,
    })
    console.log("Status:", res.status)
    console.log("Manifest header snippet:\n", res.data.slice(0, 200))
  } catch (err) {
    console.log("Request outcome:", err.message)
  }
}

testExtractAndProxy()
