const app = require('./app');
const { migrate } = require('./db/migrate');

const PORT = process.env.PORT || 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Apply the schema, retrying while the database refuses to answer.
 *
 * A container often starts before its platform's private network is routable,
 * so the first connection fails on a deployment that is otherwise correct.
 * Retrying turns that from a crash loop into a few seconds of waiting.
 */
async function prepare(attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(`Database not ready (attempt ${attempt}/${attempts}): ${describe(err)} — retrying in 3s`);
      await sleep(3000);
    }
  }
}

/**
 * Everything known about a failure.
 *
 * `err.message` alone is not enough: a DNS or connect failure can carry an
 * empty message and put the cause in `code` or in a nested `errors` array, so
 * printing only the message produces a log line that says nothing at all.
 */
function describe(err) {
  if (!err) return 'unknown error';
  const parts = [err.message, err.code, err.address && `${err.address}:${err.port ?? ''}`]
    .filter(Boolean);
  for (const nested of err.errors || []) parts.push(describe(nested));
  return parts.length ? parts.join(' · ') : String(err);
}

prepare()
  .then(() => {
    app.listen(PORT, () => console.log(`Google Multi-Account Connector listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('Could not prepare the database:', describe(err));
    console.error(err);
    if (!process.env.DATABASE_URL) console.error('DATABASE_URL is not set.');
    process.exit(1);
  });
