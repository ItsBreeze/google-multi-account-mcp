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

/**
 * Trust exactly one proxy hop.
 *
 * Every managed host — Railway included — terminates TLS at a load balancer and
 * forwards the caller's address in X-Forwarded-For. Left at the default, Express
 * reports the balancer's address as req.ip, so the rate limiters below bucket
 * every caller in the world together: one person hammering sign-in throttles
 * everybody. `true` would be worse than the default, since it trusts the whole
 * chain and lets a caller spoof their own address by sending the header; `1`
 * trusts only the hop we actually have.
 */
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));

// Tool traffic gets a generous budget: a single Claude conversation fans out
// across every linked account and must never throttle itself.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// Sign-in and authorization are the unauthenticated surface on a public URL,
// so they get a far tighter budget than the tool traffic around them. There is
// no longer a password to guess here, but the sign-in redirect still starts an
// OAuth round-trip against Google, and that is worth not letting anyone spray.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
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

app.post('/mcp/oauth/authorize', authLimiter);
app.get('/gmail/signin',         authLimiter);

app.use('/mcp',   mcpLimiter, requireConfigured, mcpRoutes);
app.use('/gmail', requireConfigured, gmailLinkRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use(errorHandler);

module.exports = app;
