/**
 * The connector as a standalone Express app.
 *
 * Everything here is the connector and nothing else, so it can also be mounted
 * inside an existing app: require the two routers and copy the rate limits and
 * the discovery routes below.
 */

require('dotenv').config();
const express   = require('express');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/error');
const gmailLinkRoutes  = require('./routes/gmail_link');
const { router: mcpRoutes, requireConfigured } = require('./routes/mcp');
const mcpOauth = require('./services/mcp_oauth');

const app = express();

app.use(express.json({ limit: '1mb' }));

// Tool traffic gets a generous budget: a single Claude conversation fans out
// across every linked account and must never throttle itself.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// The endpoints that check MCP_ADMIN_PASSWORD are the only brute-forceable
// surface on a public URL, so they get a far tighter budget than the tool
// traffic around them. Successful requests do not count against it.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// RFC 9728 / RFC 8414 discovery. Clients probe both the bare path and the
// resource-path-suffixed form, so serve both.
const oauthMetadata = (build) => [requireConfigured, (req, res, next) => {
  try { res.json(build()); } catch (err) { next(err); }
}];

app.get('/.well-known/oauth-protected-resource',
  oauthMetadata(() => mcpOauth.protectedResourceMetadata()));
app.get('/.well-known/oauth-protected-resource/mcp',
  oauthMetadata(() => mcpOauth.protectedResourceMetadata()));
app.get('/.well-known/oauth-authorization-server',
  oauthMetadata(() => mcpOauth.authorizationServerMetadata()));
app.get('/.well-known/oauth-authorization-server/mcp',
  oauthMetadata(() => mcpOauth.authorizationServerMetadata()));

app.post('/mcp/oauth/authorize', passwordLimiter);
app.post('/gmail/connect',       passwordLimiter);
app.post('/gmail/check',         passwordLimiter);
app.post('/gmail/unlink',        passwordLimiter);
app.post('/gmail/accounts',      passwordLimiter);

app.use('/mcp',   mcpLimiter, requireConfigured, mcpRoutes);
app.use('/gmail', requireConfigured, gmailLinkRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use(errorHandler);

module.exports = app;
