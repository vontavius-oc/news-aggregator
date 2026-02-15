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
  imageUrl?: string;
}

interface WebsiteConfig {
  name: string;
  url: string;
  type: string;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

function cleanNewsHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, head, nav, footer, header, aside, svg, canvas, link, meta').remove();
  $('.ads, .advertisement, .social-share, .comments, .related-posts, .newsletter-signup, .cookie-banner, .post-bottom').remove();

  const selectors = [
    'article', 'main', '#article-body', '.article-body', '.article-content',
    '.entry-content', '.post-content', '.story-content', '.content-area',
    '.main-content', '.post-content-area', '.ca-content'
  ];

  let target: cheerio.Cheerio<cheerio.AnyNode> | null = null;
  for (const selector of selectors) {
    const el = $(selector);
    if (el.length && el.text().trim().length > 300) {
      target = el.first();
      break;
    }
  }

  if (!target) target = $('body');
  target.find('div, section, span, p').filter(function() {
    return $(this).text().trim().length === 0;
  }).remove();

  return target.html() || '';
}

async function fetchLinkContent(url: string, proxyUrl?: string): Promise<{ html?: string, image?: string }> {
  if (!url || url.includes('reddit.com/r/') || url.includes('old.reddit.com/r/')) return {};
  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(url);
  if (isImage) return { image: url };
  if (url.includes('imgur.com') || url.includes('v.redd.it') || url.includes('youtube.com') || url.includes('youtu.be')) return { image: url };
  
  try {
    let html: string = '';
    if (proxyUrl) {
      let headerFlags = `-H "User-Agent: ${BROWSER_UA}" `;
      for (const [k, v] of Object.entries(STEALTH_HEADERS)) {
        headerFlags += `-H "${k}: ${v}" `;
      }
      const command = `curl -s -L -x ${proxyUrl} ${headerFlags} --max-time 30 "${url}"`;
      const { stdout } = await execAsync(command);
      html = stdout;
    } else {
      const response = await fetch(url, { method: 'GET', headers: { "User-Agent": BROWSER_UA, ...STEALTH_HEADERS }, signal: AbortSignal.timeout(15000) });
      if (response.ok) html = await response.text();
    }

    if (html && html.trim().length > 500) {
        const cleaned = cleanNewsHtml(html);
        const textOnly = cheerio.load(cleaned).text().trim();
        if (cleaned.length > 20000 && textOnly.length < 500) return {};
        return { html: cleaned.length > 0 ? cleaned.substring(0, 15000) : undefined };
    }
  } catch {}
  return {};
}

async function fetchHtml(url: string, dispatcher?: ProxyAgent): Promise<string | null> {
  try {
    const response = await fetch(url, { method: 'GET', headers: { "User-Agent": BROWSER_UA, ...STEALTH_HEADERS },
      // @ts-ignore
      dispatcher, signal: AbortSignal.timeout(20000)
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

async function scrapeReddit(subreddit: string, proxyUrl?: string): Promise<NewsItem[]> {
  const url = `https://www.reddit.com/r/${subreddit}.json?limit=5`;
  const proxyPart = proxyUrl ? `-x ${proxyUrl}` : '';
  const command = `curl -s ${proxyPart} -H "User-Agent: news-aggregator-bot/1.0.0 (by /u/radu2005)" "${url}"`;
  
  try {
    const { stdout } = await execAsync(command);
    const data = JSON.parse(stdout);
    if (!data.data || !data.data.children) return [];

    const items: NewsItem[] = data.data.children.map((child: any) => ({
        source: `reddit/r/${subreddit}`,
        title: child.data.title,
        link: child.data.url.startsWith('/') ? `https://reddit.com${child.data.url}` : child.data.url,
        summary: `Score: ${child.data.ups} | Author: ${child.data.author}`
    }));

    for (const item of items) {
        console.log(`[Reddit] Smart scraping: ${item.title.substring(0, 40)}...`);
        const result = await fetchLinkContent(item.link, proxyUrl);
        item.contentHtml = result.html;
        item.imageUrl = result.image;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return items;
  } catch { return []; }
}

async function genericScrape(config: WebsiteConfig, selector: string, dispatcher?: ProxyAgent, proxyUrl?: string): Promise<NewsItem[]> {
  const html = await fetchHtml(config.url, dispatcher);
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
      items.push({ source: config.name, title, link, summary: 'Deep scrape pending...' });
    }
  });

  if (items.length === 0) {
    console.warn(`[${config.name}] No headlines found with selector: ${selector}`);
  }

  for (const item of items) {
    console.log(`[${config.name}] Deep scraping: ${item.title.substring(0, 40)}...`);
    const result = await fetchLinkContent(item.link, proxyUrl);
    item.contentHtml = result.html;
    item.imageUrl = result.image;
    await new Promise(resolve => setTimeout(resolve, 500));
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

  try {
    subreddits = JSON.parse(await readFile(path.join(configPath, 'subreddits.json'), 'utf-8'));
    websites = JSON.parse(await readFile(path.join(configPath, 'websites.json'), 'utf-8'));
  } catch (err: any) {
    console.error(`Failed to load config files: ${err.message}`);
    process.exit(1);
  }

  const tasks: Promise<NewsItem[]>[] = [];
  subreddits.forEach(sub => tasks.push(scrapeReddit(sub, proxyUrl)));

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
    else if (type === 'reuters') selector = 'h3[data-testid="Heading"]';
    else if (type === 'axios') selector = 'item';

    tasks.push(genericScrape(site, selector, dispatcher, proxyUrl));
  });

  const results = await Promise.all(tasks);
  const allNews = results.flat();

  console.log(`\n--- TOP STORIES (${allNews.length}) ---\n`);
  const outputPath = path.join(process.cwd(), 'output.json');
  await writeFile(outputPath, JSON.stringify(allNews, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

main();
