const app = require('./app');
const { migrate } = require('./db/migrate');

const PORT = process.env.PORT || 3000;

// The schema is idempotent, so applying it on boot means a fresh deployment
// needs no separate migration step.
migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Google Multi-Account Connector listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    process.exit(1);
  });
