const express = require("express");
const updateUserRouter = require('./updateUser');
const updateMediaRouter = require('./updateMedia');

const app = express();
const port = process.env.PORT || 3002;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/tiktok/user', updateUserRouter);
app.use('/api/tiktok/media', updateMediaRouter);

app.get('/', (req, res) => {
  res.send('Hello, Express.js!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app;
