/**
 * Mail providers reached over IMAP and SMTP rather than through an API.
 *
 * Hosts live here, in code, and never in a request or a database row. A user
 * supplies an address and an app password and nothing else, so linking a
 * mailbox can never be turned into "make the server open a connection to a
 * host of my choosing".
 *
 * Adding a provider is a preset here plus a link page — the tools need nothing.
 */

const PROVIDERS = {
  aol: {
    name: 'AOL',
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    // AOL has no OAuth for third-party mail clients outside an approved
    // partner list, so an app password is the only door: one generated for
    // this server alone, and deletable without touching the real password.
    appPasswordUrl: 'https://login.aol.com/account/security',
  },
};

function preset(provider) {
  const found = PROVIDERS[provider];
  if (!found) throw new Error(`Unknown mail provider: ${provider}`);
  return found;
}

module.exports = { PROVIDERS, preset };
