const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const config = require('./config');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');

app.use('/api/v1', apiRouter);
app.use('/admin', adminRouter);

app.get('/', (req, res) => {
  res.redirect('/admin/login');
});

app.listen(config.PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Auto Fill Master Admin Server Running on Port ${config.PORT}`);
  console.log(`  Admin Panel URL : http://localhost:${config.PORT}/admin`);
  console.log(`  Default Admin   : admin / adminpassword123`);
  console.log(`=======================================================`);
});

