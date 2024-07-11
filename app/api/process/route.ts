import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from "next-auth/next"
import { google, youtube_v3 } from 'googleapis';
import UserModel from '@/models/userModel';
import { connectToMongoDB } from '@/lib/db';

// interface types {
//   access_token: String;
//   refresh_token: String;
// }

export async function POST(req: NextRequest) {
  await connectToMongoDB();
  const session = await getServerSession()

  if (!session || !session.user?.email || !session.accessToken || !session.refreshToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const user = await UserModel.findOne({ email: session.user.email });
  if (!user || !user.accessToken) {
    return NextResponse.json({ error: 'User not found or no access token' }, { status: 401 })
  }

  const { topic } = await req.json()

  if (!topic) {
    return NextResponse.json({ error: 'Topic is required' }, { status: 400 })
  }

  const oauth2Client = new google.auth.OAuth2()
  oauth2Client.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken })

  try {
    await processVideos(oauth2Client, topic)
    return NextResponse.json({ message: 'YouTube video processing completed.' })
  } catch (error) {
    console.error('Error:', error)
    return NextResponse.json({ error: 'An error occurred during processing' }, { status: 500 })
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
  const response = await youtube.videos.list({
    part: ['contentDetails'],
    id: [videoId]
  });

  const videoDetails = response.data.items?.[0]?.contentDetails;
  if (!videoDetails || !videoDetails.duration) return 0;

  const duration = videoDetails.duration;
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1]) || 0;
  const minutes = parseInt(match[2]) || 0;
  const seconds = parseInt(match[3]) || 0;

  return (hours * 60 * 60 + minutes * 60 + seconds) * 1000; // Convert to milliseconds
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
    console.log(`Video duration: ${videoDuration / 1000} seconds`);

    console.log('Liking the video...');
    await youtube.videos.rate({
      id: videoId,
      rating: 'like'
    });

    console.log('Commenting on the video...');
    const commentText = `Great ${topic} video!`;
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

    console.log('Adding video to custom playlist...');
    const playlistsResponse = await youtube.playlists.list({
      part: ['snippet'],
      mine: true
    });

    let playlistId = playlistsResponse.data.items?.find(item => item.snippet?.title === `My ${topic} Playlist`)?.id;

    if (!playlistId) {
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
      console.log(`Created new playlist: My ${topic} Playlist`);
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

    return videoDuration;
  } catch (error) {
    console.error('Error performing actions:', error);
    return 0;
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
      if (totalWatchTime >= totalWatchTimeLimit) break;

      console.log(`\nProcessing video ${i + 1} of ${videos.length}`);
      const watchTime = await performActions(youtube, videos[i], topic);
      totalWatchTime += watchTime;

      console.log(`Total watch time: ${totalWatchTime / (60 * 60 * 1000)} hours`);
    }

    console.log(`\nFinished processing videos. Total watch time: ${totalWatchTime / (60 * 60 * 1000)} hours`);
  } catch (error) {
    console.error('Error processing videos:', error);
  }
}