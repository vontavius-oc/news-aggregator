import * as cheerio from 'cheerio';
import { ProxyAgent } from 'undici';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface NewsItem {
  source: string;
  title: string;
  link: string;
  summary: string;
}

const USER_AGENT = 'news-aggregator-bot/1.0.0 (by /u/radu2005)';

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,ro;q=0.8",
};

async function fetchHtml(url: string, dispatcher?: ProxyAgent): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      // @ts-ignore
      dispatcher,
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) return null;
    return await response.text();
  } catch (error: any) {
    return null;
  }
}

/**
 * Reddit has aggressive bot detection for Node.js fetch/axios.
 * We use curl via the proxy as a more robust way to fetch the JSON.
 */
async function scrapeReddit(subreddit: string, proxyUrl?: string): Promise<NewsItem[]> {
  const url = `https://www.reddit.com/r/${subreddit}.json?limit=5`;
  const proxyPart = proxyUrl ? `-x ${proxyUrl}` : '';
  const command = `curl -s ${proxyPart} -H "User-Agent: ${USER_AGENT}" "${url}"`;
  
  try {
    const { stdout } = await execAsync(command);
    const data = JSON.parse(stdout);
    
    if (!data.data || !data.data.children) return [];

    return data.data.children.map((child: any) => ({
        source: `reddit/r/${subreddit}`,
        title: child.data.title,
        link: child.data.url.startsWith('/') ? `https://reddit.com${child.data.url}` : child.data.url,
        summary: `Score: ${child.data.ups} | Comments: ${child.data.num_comments} | Author: ${child.data.author}`
    }));
  } catch (error: any) {
    console.error(`[Reddit] Fetch via curl failed: ${error.message}`);
    return [];
  }
}

async function scrapeDigi24(dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml('https://www.digi24.ro/', dispatcher);
  if (!html) return [];
  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  $('article').each((i, el) => {
    if (i >= 5) return false;
    const titleEl = $(el).find('h2 a, h3 a, .article-title a').first();
    const title = titleEl.text().trim();
    let link = titleEl.attr('href') || '';
    if (link && !link.startsWith('http')) link = `https://www.digi24.ro${link}`;
    const summary = $(el).find('p').first().text().trim();
    if (title && link) items.push({ source: 'Digi24', title, link, summary: summary || 'Latest update.' });
  });
  return items;
}

async function scrapeHotnews(dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml('https://hotnews.ro/', dispatcher);
  if (!html) return [];
  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  $('article').each((i, el) => {
    if (i >= 5) return false;
    const titleEl = $(el).find('h2 a, h1 a').first();
    const title = titleEl.text().trim();
    let link = titleEl.attr('href') || '';
    let summary = $(el).find('p, .article-excerpt, .lead').text().trim();
    if (title && link) items.push({ source: 'Hotnews', title, link, summary: summary.substring(0, 200) || 'News update.' });
  });
  return items;
}

async function scrapeBuletinDeBucuresti(dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml('https://buletin.de/bucuresti/', dispatcher);
  if (!html) return [];
  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  $('h1, h2, h3').each((i, el) => {
    const linkEl = $(el).find('a').first();
    const title = linkEl.text().trim();
    const link = linkEl.attr('href') || '';
    if (title && link && link.includes('buletin.de') && items.length < 5) {
        const summary = $(el).closest('div').find('p').first().text().trim();
        items.push({ source: 'Buletin de Bucuresti', title, link, summary: summary || 'Bucuresti local news.' });
    }
  });
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const proxyIdx = args.indexOf('--proxy');
  const proxyUrl = proxyIdx !== -1 ? args[proxyIdx + 1] : undefined;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  console.log(`Aggregating news... ${proxyUrl ? '(Proxy Active)' : '(Direct)'}`);

  const results = await Promise.all([
    scrapeReddit('programming', proxyUrl),
    scrapeReddit('technology', proxyUrl),
    scrapeDigi24(dispatcher),
    scrapeHotnews(dispatcher),
    scrapeBuletinDeBucuresti(dispatcher)
  ]);

  const allNews = results.flat();
  console.log(`\nFound ${allNews.length} total stories.\n`);

  allNews.forEach((news, idx) => {
    console.log(`${idx + 1}. [${news.source.toUpperCase()}] ${news.title}`);
    console.log(`   Link: ${news.link}`);
    console.log(`   Summary: ${news.summary}`);
    console.log('');
  });
}

main();
