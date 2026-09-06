import { app } from "./functions/api.js"
import express from "express"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(path.join(__dirname, "public")))

process.on("uncaughtException", (err) => {
  console.error("[Uncaught Exception]", err)
})

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason)
})

const PORT = parseInt(process.env.PORT || "3000", 10)

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server listening on http://localhost:${PORT}`)
  console.log(`- Endpoints:`)
  console.log(`  • http://localhost:${PORT}/`)
  console.log(`  • http://localhost:${PORT}/search?q=one%20piece`)
  console.log(`  • http://localhost:${PORT}/scrape?slug=one-piece-odmau&ep=1\n`)
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Error: Port ${PORT} is already in use. Please close the running instance or run with PORT=3001.\n`)
  } else {
    console.error("\n❌ Server error:", err.message)
  }
  process.exit(1)
})
