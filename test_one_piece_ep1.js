import axios from 'axios';
const ANINEKO_BASE = 'https://anineko.to';
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

async function test() {
  try {
    const url = 'https://anineko.to/watch/one-piece/ep-1';
    console.log('Testing URL:', url);
    const { data } = await axios.get(url, { headers: COMMON_HEADERS });
    console.log('HTML Length:', data.length);
    const hasVideo = data.includes('data-video=');
    console.log('Contains data-video:', hasVideo);
    if (!hasVideo) {
        const idx = data.indexOf('player');
        if (idx !== -1) {
            console.log('Sample HTML around player:', data.substring(idx, idx + 1000));
        } else {
            console.log('No player found in HTML');
        }
    } else {
        const markerRegex = /data-id=["'](hsub|sub|dub|softsub)["']/gi;
        let m;
        while ((m = markerRegex.exec(data)) !== null) {
            console.log('Found marker:', m[1], 'at', m.index);
        }
    }
  } catch (e) {
    console.error(e.message);
  }
}
test();
