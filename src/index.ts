import * as cheerio from 'cheerio';
import { ProxyAgent } from 'undici';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

interface NewsItem {
  source: string;
  title: string;
  link: string;
  summary: string;
  contentHtml?: string;
}

interface WebsiteConfig {
  name: string;
  url: string;
  type: string;
}

const USER_AGENT = 'news-aggregator-bot/1.0.0 (by /u/radu2005)';

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,ro;q=0.8",
};

/**
 * Attempts to fetch the HTML content of a given URL.
 * Uses curl if proxy is provided for better reliability.
 */
async function fetchLinkContent(url: string, proxyUrl?: string): Promise<string | undefined> {
  if (!url || url.includes('reddit.com/r/')) return undefined; // Skip internal reddit discussion links
  
  try {
    if (proxyUrl) {
      const command = `curl -s -L -x ${proxyUrl} -H "User-Agent: ${USER_AGENT}" --max-time 15 "${url}"`;
      const { stdout } = await execAsync(command);
      return stdout;
    } else {
      const response = await fetch(url, {
        method: 'GET',
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) return await response.text();
    }
  } catch (err) {
    // Silent fail, we just won't have content
  }
  return undefined;
}

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

async function scrapeReddit(subreddit: string, proxyUrl?: string): Promise<NewsItem[]> {
  const url = `https://www.reddit.com/r/${subreddit}.json?limit=5`;
  const proxyPart = proxyUrl ? `-x ${proxyUrl}` : '';
  const command = `curl -s ${proxyPart} -H "User-Agent: ${USER_AGENT}" "${url}"`;
  
  try {
    const { stdout } = await execAsync(command);
    const data = JSON.parse(stdout);
    if (!data.data || !data.data.children) return [];

    const items: NewsItem[] = data.data.children.map((child: any) => ({
        source: `reddit/r/${subreddit}`,
        title: child.data.title,
        link: child.data.url.startsWith('/') ? `https://reddit.com${child.data.url}` : child.data.url,
        summary: `Score: ${child.data.ups} | Comments: ${child.data.num_comments} | Author: ${child.data.author}`
    }));

    // For Reddit posts, try to fetch the linked content
    for (const item of items) {
        console.log(`[Reddit] Attempting to fetch content for: ${item.title.substring(0, 30)}...`);
        const content = await fetchLinkContent(item.link, proxyUrl);
        if (content) {
            item.contentHtml = content.substring(0, 10000); // Store up to 10k chars of HTML
        }
    }

    return items;
  } catch {
    return [];
  }
}

async function scrapeDigi24(config: WebsiteConfig, dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml(config.url, dispatcher);
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
    if (title && link) items.push({ source: config.name, title, link, summary: summary || 'Latest update.' });
  });
  return items;
}

async function scrapeHotnews(config: WebsiteConfig, dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml(config.url, dispatcher);
  if (!html) return [];
  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  $('article').each((i, el) => {
    if (i >= 5) return false;
    const titleEl = $(el).find('h2 a, h1 a').first();
    const title = titleEl.text().trim();
    let link = titleEl.attr('href') || '';
    let summary = $(el).find('p, .article-excerpt, .lead').text().trim();
    if (title && link) items.push({ source: config.name, title, link, summary: summary.substring(0, 200) || 'News update.' });
  });
  return items;
}

async function scrapeBuletin(config: WebsiteConfig, dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml(config.url, dispatcher);
  if (!html) return [];
  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  $('h1, h2, h3').each((i, el) => {
    const linkEl = $(el).find('a').first();
    const title = linkEl.text().trim();
    const link = linkEl.attr('href') || '';
    if (title && link && link.includes('buletin.de') && items.length < 5) {
        const summary = $(el).closest('div').find('p').first().text().trim();
        items.push({ source: config.name, title, link, summary: summary || 'Bucuresti local news.' });
    }
  });
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const proxyIdx = args.indexOf('--proxy');
  const proxyUrl = proxyIdx !== -1 ? args[proxyIdx + 1] : undefined;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  console.log(`Starting Aggregator... ${proxyUrl ? '(Proxy Active)' : '(Direct Network)'}`);

  const configPath = path.join(process.cwd(), 'config');
  let subreddits: string[] = [];
  let websites: WebsiteConfig[] = [];

  try {
    subreddits = JSON.parse(await readFile(path.join(configPath, 'subreddits.json'), 'utf-8'));
    websites = JSON.parse(await readFile(path.join(configPath, 'websites.json'), 'utf-8'));
  } catch (err: any) {
    console.error(`Failed to load config files: ${err.message}`);
    process.exit(1);
  }

  const tasks: Promise<NewsItem[]>[] = [];

  subreddits.forEach(sub => {
    tasks.push(scrapeReddit(sub, proxyUrl));
  });

  websites.forEach(site => {
    if (site.type === 'digi24') tasks.push(scrapeDigi24(site, dispatcher));
    else if (site.type === 'hotnews') tasks.push(scrapeHotnews(site, dispatcher));
    else if (site.type === 'buletin') tasks.push(scrapeBuletin(site, dispatcher));
  });

  const results = await Promise.all(tasks);
  const allNews = results.flat();

  console.log(`\n--- TOP STORIES (${allNews.length}) ---\n`);
  allNews.forEach((news, idx) => {
    console.log(`${idx + 1}. [${news.source.toUpperCase()}] ${news.title}`);
    console.log(`   Link: ${news.link}`);
    if (news.contentHtml) {
        console.log(`   Content: [Scraped ${news.contentHtml.length} bytes]`);
    }
    console.log('');
  });

  // Save to output file
  const outputPath = path.join(process.cwd(), 'output.json');
  await writeFile(outputPath, JSON.stringify(allNews, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

main();
