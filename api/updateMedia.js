const express = require('express');
const { createDirectus, rest, authentication, readItems, updateItem, createItem } = require("@directus/sdk");
const axios = require("axios");
const dotenv = require("dotenv");
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

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

async function core() {
  console.log('core: start');
  
  let userCount = 0;
  let updateCount = 0;

  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Directus admin credentials are not set in environment variables');
  }
  const token = await directus.login(email, password);

  try {
    const tiktokUsers = await directus.request(
      readItems('tiktok_users', {
        limit: -1,
      })
    );

    console.log('got the tiktok_users');    
    for (const user of tiktokUsers) {
      userCount++;
      const shouldUpdate = await checkIfShouldUpdate(user);
      if (shouldUpdate) {
        await updateUserVideos(user);
        updateCount++;
      }
    }

    console.log('Total users, updates processed:', userCount, updateCount);
  } catch (error) {
    console.error("An error occurred while updating TikTok videos:", error);
  }
}

async function checkIfShouldUpdate(user) {
  if (user.last_media_updated === null) return true;

  const now = new Date()
  const lastUpdated = new Date(user.last_media_updated)
  const mediaInterval = user.media_interval * 60 * 60 * 1000; // Convert hours to miliseconds

  const diff = now.getTime() - lastUpdated.getTime() > mediaInterval;
  console.log(`checkIfShouldUpdate: ${diff}. ${now.getTime() - lastUpdated.getTime()} | now - lastUpdated: ${now.toISOString()} - ${lastUpdated.toISOString()} | mediaInterval: ${user.media_interval} hours`);
  return diff;
}

async function updateUserVideos(user) {
  const isFirstUpdate = user.last_media_updated === null;
  let nextPageId = null;

  do {
    const tiktokVideoData = await fetchTikTokVideos(user.unique_id, nextPageId);
    await saveTikTokVideos(tiktokVideoData.response, user.id);
    // @TODO better logic for whether to paginate or not. Task: https://t0ggles.com/chase-saddy/dcjfvjkmcxzup42psnlu
    nextPageId = isFirstUpdate ? tiktokVideoData.next_page_id : null;
  } while (nextPageId);

  console.log('updateMedia: saved TikTok user data + updated last_updated for user', user.id, user.unique_id);
  await updateLastUpdated(user.id);
}

async function fetchTikTokVideos(username, pageId = null) {
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
    console.error('Error uploading to B2:', error);
    return null;
  }
}

async function saveTikTokVideos(videoData, authorId) {
  const itemList = videoData.itemList || videoData.items || [];

  if (!Array.isArray(itemList)) {
    console.error('itemList is not an array:', itemList);
    return false;
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

  for (const [index, item] of itemList.entries()) {
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
    
    
    const videoTimestamp = new Date(item.createTime * 1000).toISOString();
    
    // Set newLastVideoActivity only for the first video
    if (index === 0) {
      newLastVideoActivity = videoTimestamp;
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

  return true;
}

async function updateLastUpdated(userId) {
  await directus.request(
    updateItem('tiktok_users', userId, {
      last_media_updated: new Date().toISOString()
    })
  );
}

module.exports = router;
