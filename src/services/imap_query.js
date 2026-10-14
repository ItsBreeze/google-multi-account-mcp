/**
 * Gmail search syntax → IMAP SEARCH criteria.
 *
 * The search tools take one query for every linked mailbox, so an AOL mailbox
 * has to answer the same `from:ann is:unread newer_than:7d` a Gmail one does.
 * This compiles that syntax into imapflow's SearchObject.
 *
 * Anything IMAP cannot answer faithfully is refused by name rather than
 * dropped. Dropping `category:promotions` from a query would return every
 * message instead of a subset — results that look like an answer and are not.
 *
 * Folder selection (`in:`, `label:`) and `has:attachment` are not IMAP search
 * keys: the first picks which folders are searched, the second is checked
 * against each candidate's body structure afterwards. Both therefore have to
 * apply to the whole query, and are refused inside OR or parentheses.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Gmail operators with no IMAP equivalent here. Named so the refusal can say
// which part of the query was the problem, instead of searching it as text.
const UNSUPPORTED_OPS = new Set(['category', 'filename', 'around']);

const FOLDER_ALIASES = {
  inbox:    { special: '\\Inbox' },
  sent:     { special: '\\Sent' },
  draft:    { special: '\\Drafts' },
  drafts:   { special: '\\Drafts' },
  trash:    { special: '\\Trash' },
  spam:     { special: '\\Junk' },
  junk:     { special: '\\Junk' },
  archive:  { special: '\\Archive' },
  anywhere: 'anywhere',
};

// ─── Tokenizer ──────────────────────────────────────────────────────────────

function tokenize(query) {
  const s      = String(query || '');
  const tokens = [];
  let i = 0;

  const readValue = () => {
    let value  = '';
    let quoted = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        const end = s.indexOf('"', i + 1);
        if (end === -1) throw new Error('The search query has an unclosed quote.');
        value += s.slice(i + 1, end);
        quoted = true;
        i = end + 1;
        continue;
      }
      if (/\s/.test(c) || c === ')' || (c === '(' && value === '' && !quoted)) break;
      value += c;
      i++;
    }
    return { value, quoted };
  };

  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ kind: c }); i++; continue; }

    let negate = false;
    if (c === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      i++;
      if (s[i] === '(') { tokens.push({ kind: 'not' }); continue; }
      negate = true;
    }

    // An operator is letters then a colon, before any quote: `subject:"a b"`
    // is an operator, `"re: invoice"` is a phrase.
    const op = /^([A-Za-z_]+):/.exec(s.slice(i));
    if (op) {
      i += op[0].length;
      if (s[i] === '(') {
        throw new Error(`Grouped values like ${op[1]}:(…) are not supported for this mailbox — write ${op[1]}:a OR ${op[1]}:b instead.`);
      }
      const { value } = readValue();
      tokens.push({ kind: 'term', op: op[1].toLowerCase(), value, negate, raw: `${op[1]}:${value}` });
      continue;
    }

    const { value, quoted } = readValue();
    if (!quoted && !negate && value === 'OR') { tokens.push({ kind: 'or' }); continue; }
    if (!quoted && !negate && value === 'AND') continue;
    if (value === '' && !quoted) { i++; continue; }
    tokens.push({ kind: 'term', op: null, value, negate, raw: value });
  }

  return tokens;
}

// ─── Parser: implicit AND, OR binds tighter, `-` and parentheses ────────────

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];

  function unary() {
    const tok = tokens[pos++];
    if (!tok) throw new Error('The search query ends where a term was expected.');
    if (tok.kind === '(') return { type: 'group', item: expr(true) };
    if (tok.kind === 'not') return { type: 'not', item: { type: 'group', item: expr(true) } };
    if (tok.kind === 'term') {
      const term = { type: 'term', op: tok.op, value: tok.value, raw: tok.raw };
      return tok.negate ? { type: 'not', item: term } : term;
    }
    throw new Error(`Unexpected "${tok.kind === 'or' ? 'OR' : tok.kind}" in the search query.`);
  }

  function orChain() {
    const items = [unary()];
    while (peek()?.kind === 'or') { pos++; items.push(unary()); }
    return items.length === 1 ? items[0] : { type: 'or', items };
  }

  function expr(inParens) {
    const items = [];
    while (pos < tokens.length) {
      if (peek().kind === ')') {
        if (!inParens) throw new Error('The search query has an unmatched ")".');
        pos++;
        return { type: 'and', items };
      }
      items.push(orChain());
    }
    if (inParens) throw new Error('The search query has an unclosed "(".');
    return { type: 'and', items };
  }

  return expr(false);
}

// ─── Values ─────────────────────────────────────────────────────────────────

function relativeDate(value, now) {
  const m = /^(\d+)([dmy])$/i.exec(value);
  if (!m) throw new Error(`"${value}" is not a relative age — use forms like 7d, 3m or 1y.`);
  const n = Number(m[1]);
  const d = new Date(now);
  if (m[2].toLowerCase() === 'd') return new Date(d.getTime() - n * DAY_MS);
  if (m[2].toLowerCase() === 'm') { d.setUTCMonth(d.getUTCMonth() - n); return d; }
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

function absoluteDate(value) {
  if (/^\d{9,11}$/.test(value)) return new Date(Number(value) * 1000);
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!m) throw new Error(`"${value}" is not a date — use YYYY/MM/DD.`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function byteSize(value) {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(value);
  if (!m) throw new Error(`"${value}" is not a size — use forms like 500K or 10M.`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

// ─── Compiler ───────────────────────────────────────────────────────────────

/**
 * AND several criteria objects into one.
 *
 * A SearchObject is a map, so two `from:` terms collide on one key. IMAP's NOT
 * takes a parenthesised list, and NOT NOT (x) is x, so an overflowing term
 * hides behind a double negation under the otherwise-unused `not` key.
 */
function andAll(objects) {
  const merged   = {};
  const overflow = [];
  for (const obj of objects) {
    const clash = Object.keys(obj).some(k => k in merged);
    if (clash) overflow.push(obj);
    else Object.assign(merged, obj);
  }
  if (!overflow.length) return merged;
  if (merged.not) { overflow.unshift({ not: merged.not }); delete merged.not; }
  merged.not = { not: andAll(overflow) };
  return merged;
}

function compileTerm(node, now) {
  const { op, value } = node;

  if (op === null) {
    if (!value) throw new Error('The search query has an empty term.');
    return { text: value };
  }

  switch (op) {
    case 'from': case 'to': case 'cc': case 'bcc': case 'subject':
      if (!value) throw new Error(`${op}: needs a value.`);
      return { [op]: value };

    case 'is':
      if (value === 'unread')  return { seen: false };
      if (value === 'read')    return { seen: true };
      if (value === 'starred') return { flagged: true };
      throw new Error(`is:${value} is not supported for this mailbox — is:unread, is:read and is:starred are.`);

    case 'newer_than': return { since: relativeDate(value, now) };
    case 'older_than': return { before: relativeDate(value, now) };
    case 'after': case 'newer':  return { since: absoluteDate(value) };
    case 'before': case 'older': return { before: absoluteDate(value) };

    case 'larger': case 'size': return { larger: byteSize(value) };
    case 'smaller':             return { smaller: byteSize(value) };

    case 'rfc822msgid': return { header: { 'message-id': value } };
    case 'list':        return { header: { 'list-id': value } };
    case 'deliveredto': return { header: { 'delivered-to': value } };

    case 'in': case 'label':
      throw new Error(`${op}: must apply to the whole query for this mailbox — it selects which folders are searched, so it cannot sit inside OR or parentheses.`);

    case 'has':
      if (value === 'attachment') {
        throw new Error('has:attachment must apply to the whole query for this mailbox, not sit inside OR or parentheses.');
      }
      throw new Error(`has:${value} is not supported for this mailbox — has:attachment is.`);

    default:
      if (UNSUPPORTED_OPS.has(op)) throw new Error(`${op}: is not supported for this mailbox.`);
      // Not a Gmail operator at all ("http://…", "re:"): it is text.
      return { text: node.raw };
  }
}

function compileNode(node, now) {
  switch (node.type) {
    case 'term':  return compileTerm(node, now);
    case 'group': return compileNode(node.item, now);
    case 'not':   return { not: compileNode(node.item, now) };
    case 'or':    return { or: node.items.map(n => compileNode(n, now)) };
    case 'and':
      if (!node.items.length) return { all: true };
      return andAll(node.items.map(n => compileNode(n, now)));
    default:      throw new Error(`Unknown query node ${node.type}`);
  }
}

function folderSelector(value) {
  const alias = FOLDER_ALIASES[value.toLowerCase()];
  return alias || { name: value };
}

/**
 * Compile a Gmail-syntax query.
 *
 * Returns { criteria, folders: { include, exclude }, hasAttachment } where
 * include/exclude hold folder selectors ({ special } | { name } | 'anywhere')
 * and hasAttachment is true, false, or undefined for "either".
 */
function compile(query, { now = Date.now() } = {}) {
  const tree = parse(tokenize(query));

  const include = [];
  const exclude = [];
  let hasAttachment;
  const rest = [];

  // Whole-query modifiers are the top-level terms, plain or negated.
  for (const item of tree.items) {
    const negated = item.type === 'not' && item.item.type === 'term';
    const term    = negated ? item.item : item;

    if (term.type === 'term' && (term.op === 'in' || term.op === 'label')) {
      if (!term.value) throw new Error(`${term.op}: needs a folder name.`);
      (negated ? exclude : include).push(folderSelector(term.value));
      continue;
    }
    if (term.type === 'term' && term.op === 'has' && term.value === 'attachment') {
      hasAttachment = !negated;
      continue;
    }
    rest.push(item);
  }

  return {
    criteria: compileNode({ type: 'and', items: rest }, now),
    folders:  { include, exclude },
    hasAttachment,
  };
}

module.exports = { compile, _internal: { tokenize, parse, andAll, relativeDate, absoluteDate, byteSize } };
