const { Pool } = require('pg');
require('dotenv').config();

const url = process.env.DATABASE_URL || '';

/**
 * SSL is decided by where the database is, not by NODE_ENV.
 *
 * A private address — localhost, or a platform's internal network — speaks
 * plain Postgres and refuses an SSL handshake; a public endpoint requires one.
 * Keying this off NODE_ENV instead made a correct DATABASE_URL fail whenever
 * the host set NODE_ENV=production for its own reasons, which Railway does.
 */
const isPrivate = /@(localhost|127\.0\.0\.1|\[?::1\]?|[a-z0-9-]+\.(railway\.internal|internal|local))(:|\/)/i.test(url);

const pool = new Pool({
  connectionString: url || undefined,
  ssl: isPrivate ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err);
});

module.exports = pool;
