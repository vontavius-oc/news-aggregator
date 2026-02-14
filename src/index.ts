import * as cheerio from 'cheerio';

interface RedditPost {
  title: string;
  link: string;
  upvotes: string;
  thumbnail: string | null;
}

// Exact headers provided by you + a standard User-Agent
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1"
};

async function scrapeSubreddit(subreddit: string): Promise<RedditPost[]> {
  console.log(`Scraping r/${subreddit}...`);
  // Try without the trailing slash to be safe
  const url = `https://old.reddit.com/r/${subreddit}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: HEADERS,
      // Adding a signal/timeout might help catch silent hangs
      signal: AbortSignal.timeout(10000) 
    });

    if (!response.ok) {
      console.error(`HTTP error for ${subreddit}: ${response.status} ${response.statusText}`);
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const posts: RedditPost[] = [];

    $('.thing').each((i, element) => {
      if (i >= 25) return false;

      const titleEl = $(element).find('a.title');
      const title = titleEl.text().trim();
      let link = titleEl.attr('href') || '';
      
      if (link.startsWith('/r/')) {
        link = `https://old.reddit.com${link}`;
      }

      // Upvotes on old.reddit are usually in .score.unvoted or .score.likes
      const upvotes = $(element).find('.score.unvoted').text().trim() || '0';
      
      const thumbImg = $(element).find('a.thumbnail img');
      const thumbnail = thumbImg.attr('src') ? `https:${thumbImg.attr('src')}` : null;

      if (title) {
        posts.push({ title, link, upvotes, thumbnail });
      }
    });

    return posts;
  } catch (error: any) {
    // If it's a fetch failed error, we want the "cause" to see if it's DNS or SSL
    console.error(`Fetch failed for r/${subreddit}:`, error.message);
    if (error.cause) {
      console.error('Underlying cause:', error.cause);
    }
    return [];
  }
}

async function main() {
  const subreddits = ['programming', 'technology', 'Romania'];
  
  for (const sub of subreddits) {
    const posts = await scrapeSubreddit(sub);
    console.log(`Found ${posts.length} posts in r/${sub}`);
    if (posts.length > 0) {
      console.log(`Top post: ${posts[0].title} (${posts[0].upvotes} upvotes)`);
    }
    console.log('-------------------');
  }
}

main();
