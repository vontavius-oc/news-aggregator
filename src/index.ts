interface RedditPost {
  title: string;
  link: string;
  upvotes: string;
  thumbnail: string | null;
}

// Using the exact headers provided by the user
const HEADERS = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "priority": "u=0, i",
  "sec-ch-ua": "\"Not(A:Brand\";v=\"8\", \"Chromium\";v=\"144\", \"Microsoft Edge\";v=\"144\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0"
};

import * as cheerio from 'cheerio';

async function scrapeSubreddit(subreddit: string): Promise<RedditPost[]> {
  console.log(`Scraping r/${subreddit}...`);
  const url = `https://old.reddit.com/r/${subreddit}/`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: HEADERS
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    const $ = cheerio.load(data);
    const posts: RedditPost[] = [];

    $('.thing').each((i, element) => {
      if (i >= 25) return false;

      const titleEl = $(element).find('a.title');
      const title = titleEl.text();
      let link = titleEl.attr('href') || '';
      
      if (link.startsWith('/r/')) {
        link = `https://old.reddit.com${link}`;
      }

      const upvotes = $(element).find('.score.unvoted').text() || '0';
      
      const thumbImg = $(element).find('a.thumbnail img');
      const thumbnail = thumbImg.attr('src') ? `https:${thumbImg.attr('src')}` : null;

      posts.push({
        title,
        link,
        upvotes,
        thumbnail
      });
    });

    return posts;
  } catch (error) {
    console.error(`Error scraping ${subreddit}:`, (error as any).message);
    return [];
  }
}

async function main() {
  const subreddits = ['programming', 'technology', 'Romania'];
  
  for (const sub of subreddits) {
    const posts = await scrapeSubreddit(sub);
    console.log(`Found ${posts.length} posts in r/${sub}`);
    if (posts.length > 0) {
      posts.forEach((p, idx) => {
        console.log(`${idx + 1}. [${p.upvotes}] ${p.title}`);
      });
    }
    console.log('-------------------');
  }
}

main();
