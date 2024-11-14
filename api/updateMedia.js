const express = require('express');
const { createDirectus, rest, authentication, readItems, updateItem, createItem } = require("@directus/sdk");
const axios = require("axios");
const dotenv = require("dotenv");
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const util = require('util');

dotenv.config();

if (!process.env.DIRECTUS_URL) throw new Error('DIRECTUS_URL is not defined');
const directus = createDirectus(process.env.DIRECTUS_URL)
  .with(rest())
  .with(authentication());

const router = express.Router();

router.get('/', async (req, res) => {
  console.log('TikTok media update process started log');
  res.status(202).json({ msg: "TikTok media update process started." });
  await core().catch(error => {
    console.error("Error in core function:", error);
  });
  console.log('TikTok media update process ended log');
});

function logApiError(error, context) {
  if (axios.isAxiosError(error)) {
    console.error(`API Error (${context}):`, {
      url: error.config?.url,
      status: error.response?.status,
      data: util.inspect(error.response?.data, { depth: 2, colors: true })
    });
  } else {
    console.error(`Non-Axios Error (${context}):`, error.message);
  }
}

async function core() {
  console.log('core: start');
  
  await directus.login(process.env.DIRECTUS_ADMIN_EMAIL, process.env.DIRECTUS_ADMIN_PASSWORD);
  
  try {
    const tiktokUsers = await directus.request(readItems('tiktok_users', { limit: -1 }));
    console.log('got the tiktok_users');    
    
    const stats = { total: tiktokUsers.length, updated: 0, skipped: 0, failed: 0 };

    for (let i = 0; i < tiktokUsers.length; i++) {
      const user = tiktokUsers[i];
      try {
        if (await checkIfShouldUpdate(user)) {
          console.log(`[${i + 1}/${stats.total}] Processing videos for user: ${user.unique_id}`);
          await updateUserVideos(user);
          stats.updated++;
        } else {
          console.log(`[${i + 1}/${stats.total}] Skipping ${user.unique_id} - Next update in ${getTimeRemaining(user)}`);
          stats.skipped++;
        }
      } catch (error) {
        stats.failed++;
        console.error(`[ERROR ${stats.failed}] Failed to update videos for ${user.unique_id}: ${error.message}`);
      }
    }

    console.log('Summary:', stats);
  } catch (error) {
    logApiError(error, 'core');
  }
}

function getTimeRemaining(user) {
  const now = new Date();
  const lastUpdated = new Date(user.last_media_updated);
  const mediaInterval = user.media_interval * 60 * 60 * 1000;
  const remainingMs = (lastUpdated.getTime() + mediaInterval) - now.getTime();
  
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  
  return `${hours}h ${minutes}m`;
}

async function checkIfShouldUpdate(user) {
  if (user.last_media_updated === null) return true;

  const now = new Date();
  const lastUpdated = new Date(user.last_media_updated);
  const mediaInterval = user.media_interval * 60 * 60 * 1000; // Convert hours to milliseconds

  return now.getTime() - lastUpdated.getTime() > mediaInterval;
}

async function updateUserVideos(user) {
  try {
    console.log(`[START] Updating videos for user: ${user.unique_id}`);
    const isFirstUpdate = user.last_media_updated === null;
    let nextPageId = null;
    let totalVideosProcessed = 0;

    do {
      const tiktokVideoData = await fetchTikTokVideos(user.unique_id, nextPageId);
      const videosCount = await saveTikTokVideos(tiktokVideoData.response, user.id);
      totalVideosProcessed += videosCount;
      nextPageId = isFirstUpdate ? tiktokVideoData.next_page_id : null;
    } while (nextPageId);

    await updateLastUpdated(user.id);
    console.log(`[COMPLETE] Updated videos for user: ${user.unique_id} | Total videos: ${totalVideosProcessed}`);
  } catch (error) {
    console.log(`[FAILED] Failed to update videos for user: ${user.unique_id}`);
    throw error;
  }
}

async function fetchTikTokVideos(username, pageId = null) {
  try {
    const url = new URL(process.env.TIKTOK_PAPI_URL + "/user/videos/by/username");
    url.searchParams.append("username", username);
    if (pageId) {
      url.searchParams.append("page_id", pageId);
    }

    const response = await axios.get(url.toString(), {
      headers: {
        "x-access-key": process.env.TIKTOK_PAPI_KEY,
      },
    });
    return response.data;
  } catch (error) {
    logApiError(error, `fetchTikTokVideos:${username}`);
    throw error;
  }
}

// Configure AWS SDK for Backblaze B2
const s3 = new AWS.S3({
  endpoint: process.env.B2_ENDPOINT,
  accessKeyId: process.env.B2_APPLICATION_KEY_ID,
  secretAccessKey: process.env.B2_APPLICATION_KEY,
  s3ForcePathStyle: true,
  signatureVersion: 'v4'
});

const CUSTOM_DOMAIN = process.env.B2_CUSTOM_DOMAIN;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;
const B2_DOMAIN = process.env.B2_DOMAIN;

async function uploadToB2(imageUrl, fileName) {
  if (!imageUrl) {
    console.warn('Empty or invalid image URL provided');
    return null;
  }

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');

    const params = {
      Bucket: B2_BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: response.headers['content-type'],
    };

    await s3.upload(params).promise();
    // Construct the URL using the custom domain
    return `https://${CUSTOM_DOMAIN}/file/${B2_BUCKET_NAME}/${fileName}`;
  } catch (error) {
    logApiError(error, `uploadToB2:${fileName}`);
    return null;
  }
}

async function saveTikTokVideos(videoData, authorId) {
  try {
    const itemList = videoData.itemList || videoData.items || [];

    if (!Array.isArray(itemList)) {
      logApiError(
        new Error(`itemList is not an array: ${JSON.stringify(itemList)}`),
        `saveTikTokVideos:${authorId}`
      );
      return 0;
    } else {
       console.log('saveTikTokVideos: itemList length', itemList.length);
    }

    // Fetch the current user data
    const currentUser = await directus.request(
      readItems('tiktok_users', {
        filter: { id: authorId },
        limit: 1,
      })
    );

    const currentLastVideoActivity = currentUser[0]?.last_video_activity;
    let newLastVideoActivity = null;

    for (const item of itemList) {
      const videoTimestamp = new Date(item.createTime * 1000).toISOString();
      
      // Set newLastVideoActivity only for the first non-pinned video
      if (newLastVideoActivity === null && !item.isPinnedItem) {
        newLastVideoActivity = videoTimestamp;
      }

      const existingVideo = await directus.request(
        readItems('tiktok_videos', {
          filter: { tiktok_id: item.id },
          limit: 1,
        })
      );
      
      let coverUrl = item.video?.cover || null;
      
      if (coverUrl) {
        if (existingVideo && existingVideo.length > 0) {
          // Check if the existing cover is already a B2 URL (using either custom domain or B2 domain)
          const isB2Url = existingVideo[0].cover && (
            existingVideo[0].cover.includes(CUSTOM_DOMAIN) ||
            (B2_DOMAIN && existingVideo[0].cover.includes(B2_DOMAIN))
          );
          
          if (isB2Url) {
            coverUrl = existingVideo[0].cover;
          } else {
            // Upload cover image to B2 only if it's not already a B2 URL
            const coverFileName = `tiktok_video_covers/${uuidv4()}.jpg`;
            coverUrl = await uploadToB2(coverUrl, coverFileName) || coverUrl;
          }
        } else {
          // For new entries, always upload to B2
          const coverFileName = `tiktok_video_covers/${uuidv4()}.jpg`;
          coverUrl = await uploadToB2(coverUrl, coverFileName) || coverUrl;
        }
      }

      const video = {
        tiktok_id: item.id,
        author: authorId,
        created: videoTimestamp,
        desc: item.desc,
        collected: parseInt(item.statsV2?.collectCount || '0'),
        comments: parseInt(item.statsV2?.commentCount || '0'),
        hearts: parseInt(item.statsV2?.diggCount || '0'),
        plays: parseInt(item.statsV2?.playCount || '0'),
        shares: parseInt(item.statsV2?.shareCount || '0'),
        cover: coverUrl,
        duration: item.video?.duration,
        dynamic_cover: item.video?.dynamicCover,
      };

      if (existingVideo && existingVideo.length > 0) {
        console.log('saveTikTokVideos: updated video (id, tiktok_id, desc)', existingVideo[0].id, video.tiktok_id, video.desc.slice(0, 30));
        await directus.request(
          updateItem('tiktok_videos', existingVideo[0].id, video)
        );
      } else {
        const newVideo = await directus.request(
          createItem('tiktok_videos', video)
        );
        console.log('saveTikTokVideos: created video (id, tiktok_id, desc)', newVideo.id, video.tiktok_id, video.desc.slice(0, 30));
      }
    }

    // Update last_video_activity only if the new value is more recent
    if (newLastVideoActivity && (!currentLastVideoActivity || newLastVideoActivity > currentLastVideoActivity)) {
      await directus.request(
        updateItem('tiktok_users', authorId, {
          last_video_activity: newLastVideoActivity
        })
      );
      console.log(`Updated last_video_activity for user ${authorId} to ${newLastVideoActivity}`);
    }

    return itemList.length;
  } catch (error) {
    logApiError(error, `saveTikTokVideos:${authorId}`);
    return 0;
  }
}

async function updateLastUpdated(userId) {
  await directus.request(
    updateItem('tiktok_users', userId, {
      last_media_updated: new Date().toISOString()
    })
  );
}

module.exports = router;
