import { app } from "./functions/api.js";
import axios from "axios";

async function testScrape(slug, ep) {
  const server = app.listen(0, async () => {
    const port = server.address().port;
    try {
      console.log(`Testing /scrape for slug: ${slug}, ep: ${ep}`);
      const res = await axios.get(`http://localhost:${port}/scrape?slug=${slug}&ep=${ep}`);
      console.log("Scrape status:", res.status);
      console.log("Counts:", res.data.counts);
      console.log("Sources:", res.data.sources);
    } catch (err) {
      console.error("Scrape failed:", err.response?.data || err.message);
    } finally {
      server.close();
    }
  });
}

testScrape("one-piece-odmau", "1");
