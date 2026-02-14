import axios from 'axios';
import * as cheerio from 'cheerio';

interface RedditPost {
  title: string;
  link: string;
  upvotes: string;
  thumbnail: string | null;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0';

/**
 * Scrapes the first 25 posts from old.reddit.com for a given subreddit.
 * NOTE: Reddit often blocks automated requests from data center IPs with 403 Forbidden.
 */
async function scrapeSubreddit(subreddit: string): Promise<RedditPost[]> {
  console.log(`Scraping r/${subreddit}...`);
  const url = `https://old.reddit.com/r/${subreddit}`;
  
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

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
    // Log the message but don't crash
    console.error(`Error scraping ${subreddit}:`, (error as any).message);
    return [];
  }
}

async function main() {
  const subreddits = ['programming', 'technology', 'worldnews'];
  
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
