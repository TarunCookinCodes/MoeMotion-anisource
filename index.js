import { handler } from "./functions/api.js"
import http from "node:http"

const PORT = process.env.PORT || 3000

// In local mode, create standard server wrapping express handler
const server = http.createServer((req, res) => {
  // Let express app handle requests directly via functions/api.js router
  handler(req, res)
})

server.listen(PORT, () => {
  console.log(`HLS Streams Scraper running on port ${PORT}`)
})
