import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from "next-auth/next"
import { authOptions } from "@/auth"
import { google, youtube_v3 } from 'googleapis';
import UserModel from '@/models/userModel';
import { connectToMongoDB } from '@/lib/db';
import puppeteer from 'puppeteer';

export async function POST(req: NextRequest) {
  console.log('Received POST request to /api/process');
  await connectToMongoDB();
  const session = await getServerSession(authOptions)

  console.log('Session:', JSON.stringify(session, null, 2));

  if (!session || !session.user?.email || !session.accessToken || !session.refreshToken) {
    console.log('Authentication failed. Session:', JSON.stringify(session, null, 2));
    return NextResponse.json({ error: 'Not authenticated', message: 'Authentication failed' }, { status: 401 })
  }

  const user = await UserModel.findOne({ email: session.user.email });
  console.log('User:', user);

  if (!user || !user.accessToken) {
    console.log('User not found or no access token');
    return NextResponse.json({ error: 'User not found or no access token', message: 'User data error' }, { status: 401 })
  }

  const { topic } = await req.json()
  console.log('Received topic:', topic);

  if (!topic) {
    console.log('Missing topic');
    return NextResponse.json({ error: 'Topic is required', message: 'Missing topic' }, { status: 400 })
  }

  const oauth2Client = new google.auth.OAuth2()
  oauth2Client.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken })

  try {
    await processVideos(oauth2Client, topic)
    return NextResponse.json({ message: 'YouTube video processing completed.' })
  } catch (error) {
    console.error('Error:', error)
    return NextResponse.json({ error: 'An error occurred during processing', message: 'Processing error' }, { status: 500 })
  }
}

async function searchVideos(youtube: youtube_v3.Youtube, topic: string): Promise<youtube_v3.Schema$SearchResult[]> {
  console.log(`Searching for videos on topic: "${topic}"...`);
  const response = await youtube.search.list({
    part: ['snippet'],
    q: topic,
    type: ['video'],
    videoDefinition: 'high',
    maxResults: 50
  } as youtube_v3.Params$Resource$Search$List);

  console.log(`Found ${response.data.items?.length || 0} videos.`);
  return response.data.items || [];
}

async function getVideoDuration(youtube: youtube_v3.Youtube, videoId: string): Promise<number> {
  console.log(`Getting duration for video: ${videoId}`);
  const response = await youtube.videos.list({
    part: ['contentDetails'],
    id: [videoId]
  });

  const videoDetails = response.data.items?.[0]?.contentDetails;
  if (!videoDetails || !videoDetails.duration) {
    console.log(`No duration found for video: ${videoId}`);
    return 0;
  }

  const duration = videoDetails.duration;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) {
    console.log(`Invalid duration format for video: ${videoId}`);
    return 0;
  }

  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');

  const totalMilliseconds = (hours * 60 * 60 + minutes * 60 + seconds) * 1000;
  console.log(`Video duration: ${totalMilliseconds / 1000} seconds`);
  return totalMilliseconds;
}

async function performActions(youtube: youtube_v3.Youtube, video: youtube_v3.Schema$SearchResult, topic: string): Promise<number> {
  const videoId = video.id?.videoId;
  const videoTitle = video.snippet?.title;

  if (!videoId) {
    console.log('Invalid video ID, skipping...');
    return 0;
  }

  try {
    console.log(`Processing video: "${videoTitle}" (ID: ${videoId})`);

    const videoDuration = await getVideoDuration(youtube, videoId);
    const watchDuration = Math.min(videoDuration, 20 * 60 * 1000); // Watch for 20 minutes or the full duration, whichever is shorter

    console.log('Watching the video...');
    await watchVideo(videoId, watchDuration);

    console.log('Liking the video...');
    try {
      await youtube.videos.rate({
        id: videoId,
        rating: 'like'
      });
      console.log('Video liked successfully');
    } catch (error) {
      console.error('Error liking the video:', error);
    }

    console.log('Commenting on the video...');
    const commentText = `Great ${topic} video!`;
    try {
      await youtube.commentThreads.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            videoId: videoId,
            topLevelComment: {
              snippet: {
                textOriginal: commentText
              }
            }
          }
        }
      });
      console.log('Comment posted successfully');
    } catch (error) {
      console.error('Error posting comment:', error);
    }

    console.log('Adding video to custom playlist...');
    try {
      const playlistsResponse = await youtube.playlists.list({
        part: ['snippet'],
        mine: true
      });

      let playlistId = playlistsResponse.data.items?.find(item => item.snippet?.title === `My ${topic} Playlist`)?.id;

      if (!playlistId) {
        console.log(`Creating new playlist: My ${topic} Playlist`);
        const newPlaylist = await youtube.playlists.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              title: `My ${topic} Playlist`,
              description: `A custom playlist for ${topic} videos`
            }
          }
        });
        playlistId = newPlaylist.data.id;
        console.log(`Created new playlist with ID: ${playlistId}`);
      }

      if (playlistId) {
        await youtube.playlistItems.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              playlistId: playlistId,
              resourceId: {
                kind: 'youtube#video',
                videoId: videoId
              }
            }
          }
        });
        console.log('Video added to custom playlist successfully');
      } else {
        console.log('Failed to create or find custom playlist');
      }
    } catch (error) {
      console.error('Error handling playlist:', error);
    }

    return watchDuration;
  } catch (error) {
    console.error('Error performing actions:', error);
    return 0;
  }
}

async function watchVideo(videoId: string, duration: number) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 60000, // 60 seconds for launching
      protocolTimeout: Math.max(duration + 30000, 60000), // At least 60 seconds or duration + 30 seconds
      executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // Adjust if needed
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60000); // 60 seconds for navigation

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`Navigating to ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: 'networkidle0' });

    console.log(`Watching video for ${duration / 1000} seconds`);
    await page.evaluate((durationMs) => {
      return new Promise((resolve) => {
        setTimeout(resolve, durationMs);
      });
    }, duration);

    console.log('Finished watching the video');
  } catch (error) {
    console.error('Error in watchVideo:', error);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
  }
}


async function findBestChannels(youtube: youtube_v3.Youtube, topic: string, maxChannels: number = 5): Promise<string[]> {
  console.log(`Searching for best channels on topic: "${topic}"...`);
  const response = await youtube.search.list({
    part: ['snippet'],
    q: topic,
    type: ['channel'],
    order: 'relevance',
    maxResults: maxChannels
  } as youtube_v3.Params$Resource$Search$List);

  const channelIds = response.data.items?.map(item => item.snippet?.channelId).filter(Boolean) as string[];
  console.log(`Found ${channelIds.length} top channels.`);
  return channelIds;
}

async function subscribeToChannel(youtube: youtube_v3.Youtube, channelId: string): Promise<void> {
  try {
    await youtube.subscriptions.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          resourceId: {
            kind: 'youtube#channel',
            channelId: channelId
          }
        }
      }
    });
    console.log(`Subscribed to channel: ${channelId}`);
  } catch (error) {
    console.error(`Error subscribing to channel ${channelId}:`, error);
  }
}

async function processVideos(auth: any, topic: string) {
  console.log(`Starting to process videos for topic: ${topic}`);
  const youtube = google.youtube({ version: 'v3', auth });
  const totalWatchTimeLimit = 30 * 60 * 60 * 1000; // 30 hours in milliseconds
  let totalWatchTime = 0;

  try {
    // Subscribe to best channels
    const bestChannels = await findBestChannels(youtube, topic);
    for (const channelId of bestChannels) {
      await subscribeToChannel(youtube, channelId);
    }

    const videos = await searchVideos(youtube, topic);
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      console.log(`Processing video ${i + 1}/${videos.length}: ${video.snippet?.title}`);
      const watchDuration = await performActions(youtube, video, topic);
      totalWatchTime += watchDuration;

      if (totalWatchTime >= totalWatchTimeLimit) {
        console.log('Reached total watch time limit.');
        break;
      }
    }
    console.log('Finished processing videos');
  } catch (error) {
    console.error('Error processing videos:', error);
    throw error;
  }
}
