// Pinterest design-research extractor. The /ideas/ pages are SEO-rendered:
// pin cards (img alt = pin title), /pin/<id>/ links, and "people searched"
// counts are all in the raw HTML even for logged-out visitors. This pulls
// all of it per page — no login required.
// Usage: node scripts/pinterest-extract.mjs <ideas-url> [more-urls...]
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

for (const url of process.argv.slice(2)) {
  console.log(`\n=== ${url} ===`);
  const html = await fetchHtml(url);
  const searched = [...html.matchAll(/([\d.]+[kmg]?) people searched this/gi)].map((m) => m[1]);
  console.log(`searched: ${searched.join(', ') || '(none)'}`);

  const alts = [...html.matchAll(/<img[^>]+alt="([^"]{15,140})"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim())
    .filter((a) => !/^pin on pinterest|^image$/i.test(a));
  console.log(`pin titles (${alts.length}):`);
  for (const a of [...new Set(alts)].slice(0, 40)) console.log(`  - ${a}`);

  const pins = [...new Set([...html.matchAll(/\/pin\/(\d{6,})\//g)].map((m) => m[1]))];
  console.log(`pin links (${pins.length}): ${pins.slice(0, 12).join(', ')}${pins.length > 12 ? ' …' : ''}`);

  const ideas = [...new Set([...html.matchAll(/\/ideas\/([a-z0-9-]+)\/(\d+)\//g)].map((m) => m[1]))];
  console.log(`related ideas (${ideas.length}): ${ideas.slice(0, 24).join(', ')}`);

  const ld = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (ld) {
    try {
      const data = JSON.parse(ld[1]);
      console.log('ld+json:', JSON.stringify(data, null, 1).slice(0, 3000));
    } catch (e) {
      console.log(`ld+json parse failed: ${e.message}`);
      console.log(`raw (${ld[1].length} chars): ${ld[1].slice(0, 1500)}`);
    }
  }

}
