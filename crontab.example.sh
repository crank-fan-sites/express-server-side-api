#!/bin/bash
   
curl -X GET http://localhost:3002/api/tiktok/user
echo "TikTok user update executed at $(date)" >> ~/www/tiktok_update.log

curl -X GET http://localhost:3002/api/tiktok/media
echo "TikTok media update executed at $(date)" >> ~/www/tiktok_update.log