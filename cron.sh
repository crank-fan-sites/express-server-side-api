# Run every 5 minutes from 6:00 AM to 11:55 PM
*/5 6-23 * * * /bin/bash /home/your_username/www/tiktok_update.sh

# Run every 5 minutes from 12:00 PM to 11:55 PM (to cover the full day)
*/5 0-5 * * * [ $(date +\%H) -ge 6 ] && /bin/bash /home/your_username/www/tiktok_update.sh