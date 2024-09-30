Serverless functions but only working with regular node for some reason. Only failed at working on Vercel so far as ExpressJS or NextJS api routes

For now used with [HasanAbiTV.com](https://hasanabitv.com) like the [HasTok](https://tiktok.hasanabitv.com) page.

### Dev
cd /path/to/express-api
node/nodemon api/index.js


### Production
Using pm2 for production. Not exposing to the internet. Only localhost.

cd /path/to/express-api
pm2 start api/index.js --name express-api
<!-- This step ensures that PM2 restarts your app after a system reboot -->
pm2 save

<!-- or the config file -->
pm2 start ecosystem.config.js

<!-- Restarting or stopping the app -->
pm2 restart express-api
pm2 stop express-api


### Issues
aws-sdk has to be updated to v3 by Sept 2025