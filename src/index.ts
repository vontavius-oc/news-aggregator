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
  postLink?: string;
  imageUrl?: string;
}

interface WebsiteConfig {
  name: string;
  url: string;
  type: string;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STEALTH_HEADERS = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,ro;q=0.8",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1"
};

async function fetchHtml(url: string, userAgent: string, dispatcher?: ProxyAgent): Promise<string | null> {
  try {
    const response = await fetch(url, { 
      method: 'GET', 
      headers: { "User-Agent": userAgent, ...STEALTH_HEADERS },
      // @ts-ignore
      dispatcher, 
      signal: AbortSignal.timeout(20000) 
    });
    if (!response.ok) {
        console.error(`[Fetch] ${url} failed with status: ${response.status}`);
        return null;
    }
    return await response.text();
  } catch (err: any) { 
    console.error(`[Fetch] ${url} failed with error: ${err.message}`);
    return null; 
  }
}

async function scrapeReddit(subreddit: string, userAgent: string, proxyUrl?: string): Promise<NewsItem[]> {
  const url = `https://www.reddit.com/r/${subreddit}/.json?limit=25`;
  const proxyPart = proxyUrl ? `-x ${proxyUrl}` : '';
  const command = `curl -s ${proxyPart} -L -A "${userAgent}" "${url}"`;
  
  try {
    const { stdout } = await execAsync(command);
    if (!stdout.trim()) return [];
    
    if (stdout.trim().startsWith('<!doctype') || stdout.trim().startsWith('<body')) {
        console.warn(`[Reddit] ${subreddit} blocked (HTML returned).`);
        return [];
    }

    const data = JSON.parse(stdout);
    if (!data.data || !data.data.children) return [];

    return data.data.children.map((child: any) => {
        const post = child.data;
        const item: NewsItem = {
            source: `reddit/r/${subreddit}`,
            title: post.title,
            link: post.url.startsWith('/') ? `https://reddit.com${post.url}` : post.url,
            postLink: `https://reddit.com${post.permalink}`
        };

        if (post.post_hint === 'image' || post.url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            item.imageUrl = post.url;
        } else if (post.preview?.images?.[0]?.source?.url) {
            item.imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
        }

        return item;
    });
  } catch (err: any) { 
    console.error(`[Reddit] ${subreddit} failed: ${err.message}`);
    return []; 
  }
}

async function genericScrape(config: WebsiteConfig, selector: string, userAgent: string, dispatcher?: ProxyAgent): Promise<NewsItem[]> {
  const html = await fetchHtml(config.url, userAgent, dispatcher);
  if (!html) return [];
  const $ = cheerio.load(html, { xmlMode: config.type === 'axios' });
  const items: NewsItem[] = [];

  $(selector).each((i, el) => {
    if (items.length >= 5) return false;
    let title = '';
    let link = '';

    if (config.type === 'axios') {
        title = $(el).find('title').text().trim();
        link = $(el).find('link').text().trim();
    } else {
        const linkEl = $(el).find('a').first().length ? $(el).find('a').first() : ($(el).is('a') ? $(el) : null);
        if (!linkEl) return;
        title = linkEl.text().trim();
        link = linkEl.attr('href') || '';
    }

    if (link && !link.startsWith('http')) {
        const base = new URL(config.url);
        link = `${base.protocol}//${base.host}${link}`;
    }
    if (title.length > 10 && link) {
      items.push({ source: config.name, title, link });
    }
  });

  if (items.length === 0) {
    console.warn(`[${config.name}] No headlines found with selector: ${selector}`);
  }

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
  let userAgent = DEFAULT_UA;

  try {
    subreddits = JSON.parse(await readFile(path.join(configPath, 'subreddits.json'), 'utf-8'));
    websites = JSON.parse(await readFile(path.join(configPath, 'websites.json'), 'utf-8'));
    try {
        const uaConfig = JSON.parse(await readFile(path.join(configPath, 'useragent.json'), 'utf-8'));
        if (uaConfig.userAgent) userAgent = uaConfig.userAgent;
    } catch {
        console.log("Using default User-Agent (useragent.json not found or invalid)");
    }
  } catch (err: any) {
    console.error(`Failed to load config files: ${err.message}`);
    process.exit(1);
  }

  const tasks: Promise<NewsItem[]>[] = [];
  subreddits.forEach(sub => tasks.push(scrapeReddit(sub, userAgent, proxyUrl)));

  websites.forEach(site => {
    let selector = 'h2, h3';
    const type = site.type.toLowerCase();
    
    if (type === 'digi24') selector = 'article h2, article h3';
    else if (type === 'hotnews') selector = 'article h2';
    else if (type === 'buletin') selector = 'h3';
    else if (type === 'profit') selector = '.article-title';
    else if (type === 'economedia') selector = '.article__title';
    else if (type === 'economica') selector = '.article__title';
    else if (type === 'cnn') selector = 'a.container__link';
    else if (type === 'euronews') selector = 'a.the-media-object__link';
    else if (type === 'g4media') selector = '.article__title';
    else if (type === 'axios') selector = 'item';
    else if (type === 'bbc') selector = 'h2, a[href*="/news/articles/"]';

    tasks.push(genericScrape(site, selector, userAgent, dispatcher));
  });

  const results = await Promise.all(tasks);
  const allNews = results.flat();

  console.log(`\n--- TOP STORIES (${allNews.length}) ---\n`);
  const outputPath = path.join(process.cwd(), 'output.json');
  await writeFile(outputPath, JSON.stringify(allNews, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

main();