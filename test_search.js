import { app } from "./functions/api.js";
import axios from "axios";

async function testSearch(query) {
  const server = app.listen(0, async () => {
    const port = server.address().port;
    try {
      console.log(`Testing /search for query: "${query}"`);
      const res = await axios.get(`http://localhost:${port}/search?q=${encodeURIComponent(query)}`);
      console.log("Search status:", res.status);
      console.log("Results count:", res.data.results.length);
      console.log("First 3 results:", res.data.results.slice(0, 3));
    } catch (err) {
      console.error("Search failed:", err.response?.data || err.message);
    } finally {
      server.close();
    }
  });
}

testSearch("one piece");
