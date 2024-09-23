   #!/bin/bash
   
   # Make request to update TikTok user
   curl -X GET http://localhost/api/tiktok/user
   
   # Make request to update TikTok media
   curl -X GET http://localhost/api/tiktok/media
   
   # Optional: Log the time of execution
   echo "TikTok update executed at $(date)" >> ~/tiktok_update.log