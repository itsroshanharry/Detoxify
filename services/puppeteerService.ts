import puppeteer, { Browser } from 'puppeteer';
import fs from 'fs';
import path from 'path';

async function launchBrowser(): Promise<Browser> {
  let cookies = [];
  
  console.log('Attempting to parse YOUTUBE_COOKIES environment variable');
  
  try {
    if (process.env.YOUTUBE_COOKIES) {
      cookies = JSON.parse(process.env.YOUTUBE_COOKIES);
      console.log(`Successfully parsed ${cookies.length} cookies`);
    } else {
      console.log('YOUTUBE_COOKIES environment variable is not set');
    }
  } catch (error) {
    console.error('Error parsing YOUTUBE_COOKIES:', error);
    console.log('YOUTUBE_COOKIES value:', process.env.YOUTUBE_COOKIES);
  }

  console.log('Launching browser');
  const userDataDir = path.join(process.cwd(), 'chrome-user-data');
  
  // Ensure the directory exists and is empty
  if (fs.existsSync(userDataDir)) {
    fs.rmdirSync(userDataDir, { recursive: true });
  }
  fs.mkdirSync(userDataDir, { recursive: true });

  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      timeout: 180000,
      protocolTimeout: 180000,
      userDataDir: userDataDir
    });

    const pages = await browser.pages();
    if (pages.length > 0) {
      console.log('Setting cookies on first page');
      try {
        await pages[0].setCookie(...cookies);
        console.log('Cookies set successfully');
      } catch (error) {
        console.error('Error setting cookies:', error);
      }
    } else {
      console.log('No pages available to set cookies');
    }

    return browser;
  } catch (error) {
    console.error('Error launching browser:', error);
    throw error;
  }
}

async function closeBrowser(browser: Browser) {
  if (browser) {
    await browser.close();
  }
  const userDataDir = path.join(process.cwd(), 'chrome-user-data');
  if (fs.existsSync(userDataDir)) {
    fs.rmdirSync(userDataDir, { recursive: true });
  }
}

async function watchVideo(browser: Browser, videoId: string, duration: number) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60000);

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`Navigating to ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: 'networkidle0' });

    console.log(`Watching video for ${duration / 1000} seconds`);
    await page.evaluate((durationMs: number) => {
      return new Promise((resolve) => {
        setTimeout(resolve, durationMs);
      });
    }, duration);

    console.log('Finished watching the video');
  } catch (error) {
    console.error('Error in watchVideo:', error);
  } finally {
    await page.close();
  }
}

export { launchBrowser, closeBrowser, watchVideo };