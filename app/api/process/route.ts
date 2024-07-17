import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { google, youtube_v3 } from 'googleapis';
import UserModel from '@/models/userModel';
import { connectToMongoDB } from '@/lib/db';
import { launchBrowser, closeBrowser, watchVideo } from '@/services/puppeteerService';
import { Browser } from 'puppeteer';

export async function POST(req: NextRequest) {
  console.log('Received POST request to /api/process');
  await connectToMongoDB();
  const session = await getServerSession(authOptions);

  if (!session || !session.user?.email) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const user = await UserModel.findOne({ email: session.user.email });

  if (!user || !user.accessToken || !user.refreshToken) {
    return NextResponse.json({ error: 'User data error' }, { status: 401 });
  }

  const { topic } = await req.json();

  if (!topic) {
    return NextResponse.json({ error: 'Topic is required' }, { status: 400 });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );
  oauth2Client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken
  });

  try {
    await processVideos(oauth2Client, topic);
    return NextResponse.json({ message: 'YouTube video processing completed.' });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json({ error: 'An error occurred during processing' }, { status: 500 });
  }
}

async function processVideos(auth: any, topic: string) {
  const youtube = google.youtube('v3');
  youtube.context._options.auth = auth;

  const videos = await searchVideos(youtube, topic);
  if (videos.length === 0) {
    console.log(`No videos found for topic: "${topic}"`);
    return;
  }

    let browser: Browser | null = null;

  try {
    browser = await launchBrowser();

    if (!browser) {
      throw new Error('Failed to launch browser');
    }

    let totalWatchTime = 0;
    for (const video of videos) {
      totalWatchTime += await performActions(youtube, browser, video, topic);
      if (totalWatchTime >= 20 * 60 * 1000) {
        console.log('Reached the 20-minute limit');
        break;
      }
    }

    const bestChannels = await findBestChannels(youtube, topic);
    console.log('Best channels:', bestChannels);
  } catch (error) {
    console.error('Error during video processing:', error);
    throw error;
  } finally {
    if(browser) {
      await closeBrowser(browser);
    }  }
}

async function searchVideos(youtube: youtube_v3.Youtube, topic: string): Promise<youtube_v3.Schema$SearchResult[]> {
  console.log(`Searching for videos on topic: "${topic}"...`);
  const response = await youtube.search.list({
    part: ['snippet'],
    q: topic,
    type: ['video'],
    videoDefinition: 'high',
    maxResults: 50
  });

  console.log(`Found ${response.data.items?.length || 0} videos.`);
  return response.data.items || [];
}

async function performActions(youtube: youtube_v3.Youtube, browser: Browser, video: youtube_v3.Schema$SearchResult, topic: string): Promise<number> {
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
    await watchVideo(browser, videoId, watchDuration);

    console.log('Liking the video...');
    try {
      await youtube.videos.rate({
        id: videoId!,
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
            videoId: videoId!,
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

async function findBestChannels(youtube: youtube_v3.Youtube, topic: string, maxChannels: number = 5): Promise<string[]> {
  console.log(`Searching for best channels on topic: "${topic}"...`);
  const response = await youtube.search.list({
    part: ['snippet'],
    q: topic,
    type: ['channel'],
    order: 'relevance',
    maxResults: maxChannels
  });

  const channels = response.data.items?.map(item => item.snippet?.channelId).filter(channelId => !!channelId) as string[] || [];

  console.log(`Found ${channels.length} channels.`);
  return channels;
}
