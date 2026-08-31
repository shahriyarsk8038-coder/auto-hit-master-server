module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'autohitmaster_secret_jwt_key_2026_safe',
  SESSION_SECRET: process.env.SESSION_SECRET || 'autohitmaster_admin_session_key_2026',
  DB_PATH: process.env.DB_PATH || './db/autohitmaster.db',
  DEFAULT_ADMIN: {
    username: 'admin',
    password: 'adminpassword123'
  }
};
