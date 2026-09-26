/**
 * The whole MCP tool surface, assembled from one module per Google product.
 *
 * Each module exports a flat array of { name, description, inputSchema,
 * handler }. Order here is the order Claude sees them in tools/list, so the
 * products lead with the ones a request is most likely to mean.
 */

const shared = require('../shared');

const MODULES = {
  gmail:    require('./gmail'),
  calendar: require('./calendar'),
  drive:    require('./drive'),
  contacts: require('./contacts'),
  tasks:    require('./tasks'),
};

const TOOLS = Object.values(MODULES).flat();

// A duplicate name would silently shadow a tool — callTool takes the first
// match — so fail loudly at load instead.
const seen = new Set();
for (const tool of TOOLS) {
  if (seen.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
  seen.add(tool.name);
}

/**
 * Behaviour hints for clients (MCP tool annotations). Claude uses them to
 * decide what to confirm with the user before running, so a send or a trash
 * must never be listed as harmless. Every tool is named in exactly one list —
 * a new tool that is missing fails at load rather than defaulting to a guess.
 */
const READ_ONLY = [
  'list_accounts', 'search_messages', 'search_threads', 'get_message', 'get_thread', 'get_attachment',
  'list_drafts', 'get_draft', 'list_labels',
  'list_calendars', 'list_events', 'search_events', 'get_event', 'suggest_time',
  'search_files', 'list_recent_files', 'list_shared_drives', 'get_file_metadata', 'read_file_content',
  'download_file_content', 'get_file_permissions',
  'search_contacts', 'list_contacts',
  'list_task_lists', 'list_tasks',
];
// Irreversible, outward-facing, or removes/overwrites something.
const DESTRUCTIVE = [
  'send_message', 'reply_to_message', 'forward_message', 'send_draft', 'delete_draft',
  'delete_label', 'trash_message', 'mark_spam',
  'delete_event',
  'update_file', 'share_file', 'trash_file',
  'delete_task',
];
// Writes that add or change something recoverably.
const ADDITIVE = [
  'create_draft', 'update_draft', 'modify_labels', 'create_label', 'update_label', 'untrash_message',
  'create_event', 'update_event', 'respond_to_event',
  'create_file', 'copy_file', 'comment_on_file', 'unshare_file', 'untrash_file',
  'create_task', 'update_task',
];

const titleFor = (name) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');

const ANNOTATIONS = {};
for (const [list, hints] of [
  [READ_ONLY,   { readOnlyHint: true }],
  [DESTRUCTIVE, { readOnlyHint: false, destructiveHint: true }],
  [ADDITIVE,    { readOnlyHint: false, destructiveHint: false }],
]) {
  for (const name of list) {
    if (ANNOTATIONS[name]) throw new Error(`Tool ${name} is annotated twice`);
    ANNOTATIONS[name] = { title: titleFor(name), ...hints, openWorldHint: true };
  }
}
for (const tool of TOOLS) {
  if (!ANNOTATIONS[tool.name]) throw new Error(`Tool ${tool.name} has no annotations — add it to READ_ONLY, DESTRUCTIVE or ADDITIVE`);
}
for (const name of Object.keys(ANNOTATIONS)) {
  if (!seen.has(name)) throw new Error(`Annotation for unknown tool: ${name}`);
}

const descriptors = () => TOOLS.map(({ name, description, inputSchema }) => ({
  name, title: ANNOTATIONS[name].title, description, inputSchema, annotations: ANNOTATIONS[name],
}));

async function callTool(name, args, ownerKey) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler({ ownerKey, args: args || {} });
}

module.exports = {
  descriptors,
  callTool,
  _internal: {
    TOOLS,
    MODULES,
    resolveAccount: shared.resolveAccount,
    oneTarget:      shared.oneTarget,
    fanOut:         shared.fanOut,
    mergeSearch:    shared.mergeSearch,
  },
};
