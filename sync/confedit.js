// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: the one edit of the dedicated Syncthing instance's config.xml between `generate` and the first `serve`
// (PLAN-ADDENDUM-pairing-v2 4.4, PLAN-WIZARD 0H.7 and S-3). A string in, a string out; no Gio, no file, no process.
//
// The file holds the GUI API key, so this module NEVER quotes it: no value, no snippet and no parser text is carried by an error. A
// failure is a closed `reason` word, a field name from the list below and a line number, nothing else (S-3).
//
// Rules: the XML is parsed (no blind text substitution); every field is exactly ONE element in its expected parent; the edit is
// idempotent and convergent (a second run is byte-identical); a layout it does not understand fails closed. The single exception to
// "one element per field" is `options/listenAddress`, treated as ONE ordered list that is replaced as a whole (mode `own` only).

export const PORTS_OWN = 'own';
export const PORTS_DEFAULT = 'default';

// Mode `own` (0H.7 (2), measured in M-W10): fixed constants, no probing, nothing from the user or the network.
export const OWN_LISTEN_ADDRESSES = Object.freeze([
    'tcp://0.0.0.0:22100',
    'quic://0.0.0.0:22100',
    'dynamic+https://relays.syncthing.net/endpoint',          // the relay pool stays ON (A8)
]);
export const OWN_LOCAL_ANNOUNCE_PORT = '21127';
export const OWN_LOCAL_ANNOUNCE_MC_ADDR = '[ff12::8384]:21127';  // the IPv6 multicast address carries its own port

export const SOCKET_MODE = '0600';

// The closed vocabulary of a failure. Nothing of the file ever goes into one.
export const REASONS = Object.freeze({
    NOT_UNDERSTOOD: 'not-understood',       // the text is not XML this module reads (also: too large, too deep, a construct it refuses)
    MISSING: 'missing',
    DUPLICATE: 'duplicate',
    WRONG_PARENT: 'wrong-parent',
    NOT_TEXT: 'not-text',                   // the element has children or a value this module cannot read as plain text
    WRONG_VALUE: 'wrong-value',             // read-back only
    BAD_ARGUMENT: 'bad-argument',
});

export class ConfigEditError extends Error {
    constructor(reason, field, line) {
        super(`config.xml: ${reason} (${field}${line ? `, line ${line}` : ''})`);
        this.name = 'ConfigEditError';
        this.reason = reason;
        this.field = field;
        this.line = line ?? null;
    }
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ATTR_WS_RE = /[ \t\r\n]+/y;

function lineOf(xml, offset) {
    let n = 1;
    for (let i = 0; i < offset && i < xml.length; i++) {
        if (xml.charCodeAt(i) === 10)
            n++;
    }
    return n;
}

// A strict, small XML reader. It returns the element tree with source offsets and nothing else: no attribute values, no text
// is kept except through textOf(). A DOCTYPE, a CDATA section, a processing instruction after the declaration, a second root and
// anything unbalanced are refused.
function parse(xml) {
    if (typeof xml !== 'string' || xml.length > MAX_BYTES)
        throw new ConfigEditError(REASONS.NOT_UNDERSTOOD, 'file', null);
    const fail = at => { throw new ConfigEditError(REASONS.NOT_UNDERSTOOD, 'file', lineOf(xml, at)); };
    let i = 0;
    if (xml.startsWith('﻿'))
        i = 1;
    if (xml.startsWith('<?xml', i)) {
        const end = xml.indexOf('?>', i);
        if (end < 0)
            fail(i);
        i = end + 2;
    }
    const root = {name: '#document', children: [], parent: null, start: 0, openEnd: i, closeStart: xml.length, end: xml.length, selfClosing: false};
    let cur = root;
    let depth = 0;
    let rootSeen = false;
    while (i < xml.length) {
        const lt = xml.indexOf('<', i);
        if (lt < 0) {
            if (cur !== root || xml.slice(i).trim() !== '')
                fail(i);
            break;
        }
        if (cur === root && xml.slice(i, lt).trim() !== '')
            fail(i);
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt + 4);
            if (end < 0)
                fail(lt);
            i = end + 3;
            continue;
        }
        if (xml.startsWith('<!', lt) || xml.startsWith('<?', lt))
            fail(lt);
        if (xml.startsWith('</', lt)) {
            NAME_RE.lastIndex = lt + 2;
            const m = NAME_RE.exec(xml);
            if (!m || cur === root || m[0] !== cur.name)
                fail(lt);
            let p = NAME_RE.lastIndex;
            while (xml[p] === ' ' || xml[p] === '\t' || xml[p] === '\r' || xml[p] === '\n')
                p++;
            if (xml[p] !== '>')
                fail(lt);
            cur.closeStart = lt;
            cur.end = p + 1;
            cur = cur.parent;
            depth--;
            i = p + 1;
            continue;
        }
        // a start tag
        NAME_RE.lastIndex = lt + 1;
        const nm = NAME_RE.exec(xml);
        if (!nm)
            fail(lt);
        let p = NAME_RE.lastIndex;
        const attrs = {};
        let selfClosing = false;
        for (;;) {
            ATTR_WS_RE.lastIndex = p;
            const ws = ATTR_WS_RE.exec(xml);
            const hadWs = ws !== null;
            if (hadWs)
                p = ATTR_WS_RE.lastIndex;
            if (xml[p] === '>')
                break;
            if (xml[p] === '/' && xml[p + 1] === '>') {
                selfClosing = true;
                break;
            }
            if (!hadWs)
                fail(p);
            NAME_RE.lastIndex = p;
            const an = NAME_RE.exec(xml);
            if (!an)
                fail(p);
            p = NAME_RE.lastIndex;
            if (xml[p] !== '=')
                fail(p);
            p++;
            const q = xml[p];
            if (q !== '"' && q !== "'")
                fail(p);
            const close = xml.indexOf(q, p + 1);
            if (close < 0)
                fail(p);
            const value = xml.slice(p + 1, close);
            if (value.includes('<') || an[0] in attrs)
                fail(p);
            attrs[an[0]] = value;
            p = close + 1;
        }
        const openEnd = selfClosing ? p + 2 : p + 1;
        if (cur === root) {
            if (rootSeen)
                fail(lt);
            rootSeen = true;
        }
        const node = {name: nm[0], attrs, children: [], parent: cur, start: lt, openEnd, closeStart: openEnd, end: openEnd, selfClosing};
        cur.children.push(node);
        i = openEnd;
        if (!selfClosing) {
            depth++;
            if (depth > MAX_DEPTH)
                fail(lt);
            cur = node;
        }
    }
    if (cur !== root || !rootSeen)
        fail(xml.length);
    return {xml, root: root.children[0], line: at => lineOf(xml, at)};
}

function walk(node, fn) {
    fn(node);
    for (const c of node.children)
        walk(c, fn);
}

const pathOf = node => {
    const parts = [];
    for (let n = node; n && n.name !== '#document'; n = n.parent)
        parts.unshift(n.name);
    return parts.join('/');
};

const ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"};
const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The decoded text of a leaf element, or null if it has children, a CDATA-like construct or an entity this module does not know.
function textOf(doc, node) {
    if (node.children.length > 0)
        return null;
    if (node.selfClosing)
        return '';
    const raw = doc.xml.slice(node.openEnd, node.closeStart);
    if (raw.includes('<'))
        return null;
    let bad = false;
    const out = raw.replace(/&[^;\s]*;?/g, e => {
        if (e in ENTITIES)
            return ENTITIES[e];
        bad = true;
        return e;
    });
    return bad ? null : out;
}

// The fields. `parent` is the exact path; `one` fields must exist once. Every element of that name anywhere else is an unexpected
// parent (fail closed), except `address`, which is a legitimate child of every <device> and is only counted inside <gui>.
const F = Object.freeze({
    guiAddress: {name: 'address', parent: 'configuration/gui', label: 'gui/address', anywhereElse: false},
    guiSocketMode: {name: 'unixSocketPermissions', parent: 'configuration/gui', label: 'gui/unixSocketPermissions', anywhereElse: true},
    crashReporting: {name: 'crashReportingEnabled', parent: 'configuration/options', label: 'options/crashReportingEnabled', anywhereElse: true},
    usageReporting: {name: 'urAccepted', parent: 'configuration/options', label: 'options/urAccepted', anywhereElse: true},
    autoUpgrade: {name: 'autoUpgradeIntervalH', parent: 'configuration/options', label: 'options/autoUpgradeIntervalH', anywhereElse: true},
    announcePort: {name: 'localAnnouncePort', parent: 'configuration/options', label: 'options/localAnnouncePort', anywhereElse: true},
    announceMC: {name: 'localAnnounceMCAddr', parent: 'configuration/options', label: 'options/localAnnounceMCAddr', anywhereElse: true},
});
const LISTEN = {name: 'listenAddress', parent: 'configuration/options', label: 'options/listenAddress'};

function checkSections(doc) {
    if (doc.root.name !== 'configuration')
        throw new ConfigEditError(REASONS.NOT_UNDERSTOOD, 'configuration', doc.line(doc.root.start));
    for (const name of ['gui', 'options']) {
        const found = [];
        walk(doc.root, n => { if (n.name === name) found.push(n); });
        const label = name;
        if (found.length === 0)
            throw new ConfigEditError(REASONS.MISSING, label, null);
        if (found.length > 1)
            throw new ConfigEditError(REASONS.DUPLICATE, label, doc.line(found[1].start));
        if (pathOf(found[0]) !== `configuration/${name}`)
            throw new ConfigEditError(REASONS.WRONG_PARENT, label, doc.line(found[0].start));
    }
}

// The one element of a field: null if absent, the node if exactly one in the right parent; throws on a duplicate, on a wrong parent.
function single(doc, f) {
    const found = [];
    walk(doc.root, n => { if (n.name === f.name && (f.anywhereElse || pathOf(n).startsWith('configuration/gui/'))) found.push(n); });
    const right = found.filter(n => pathOf(n) === `${f.parent}/${f.name}`);
    if (found.length !== right.length)
        throw new ConfigEditError(REASONS.WRONG_PARENT, f.label, doc.line(found.find(n => !right.includes(n)).start));
    if (right.length > 1)
        throw new ConfigEditError(REASONS.DUPLICATE, f.label, doc.line(right[1].start));
    return right[0] ?? null;
}

function listenNodes(doc) {
    const found = [];
    walk(doc.root, n => { if (n.name === LISTEN.name) found.push(n); });
    const right = found.filter(n => pathOf(n) === `${LISTEN.parent}/${LISTEN.name}`);
    if (found.length !== right.length)
        throw new ConfigEditError(REASONS.WRONG_PARENT, LISTEN.label, doc.line(found.find(n => !right.includes(n)).start));
    return right;
}

function indentBefore(xml, offset) {
    const ls = xml.lastIndexOf('\n', offset - 1) + 1;
    const lead = xml.slice(ls, offset);
    return /^[ \t]*$/.test(lead) ? {indent: lead, lineStart: ls, ownLine: true} : {indent: '        ', lineStart: offset, ownLine: false};
}

function normaliseArgs({socketPath, ports = PORTS_OWN} = {}) {
    if (typeof socketPath !== 'string' || !/^\/[^\0-\x1f\x7f]+$/.test(socketPath) || socketPath.includes('//'))
        throw new ConfigEditError(REASONS.BAD_ARGUMENT, 'socketPath', null);
    if (ports !== PORTS_OWN && ports !== PORTS_DEFAULT)
        throw new ConfigEditError(REASONS.BAD_ARGUMENT, 'ports', null);
    return {socketPath, ports};
}

// The wanted value of every single-element field for a mode.
function wantedFields({socketPath, ports}) {
    const w = [
        [F.guiAddress, socketPath, true],
        [F.guiSocketMode, SOCKET_MODE, true],
        [F.crashReporting, 'false', true],
        [F.usageReporting, '-1', true],
        [F.autoUpgrade, '0', true],
    ];
    if (ports === PORTS_OWN) {
        w.push([F.announcePort, OWN_LOCAL_ANNOUNCE_PORT, true]);
        w.push([F.announceMC, OWN_LOCAL_ANNOUNCE_MC_ADDR, true]);
    }
    return w;
}

// The edit. Returns {xml, changed}. Throws ConfigEditError; the message and the fields of an error carry no file text.
export function editConfig(xml, args) {
    const a = normaliseArgs(args);
    const doc = parse(xml);
    checkSections(doc);
    const edits = [];                           // {start, end, text}, non-overlapping
    const options = doc.root.children.find(n => n.name === 'options');
    for (const [f, value] of wantedFields(a)) {
        const node = single(doc, f);
        const wanted = escapeText(value);
        if (node === null) {
            if (f !== F.guiSocketMode)
                throw new ConfigEditError(REASONS.MISSING, f.label, null);
            const addr = single(doc, F.guiAddress);
            if (addr === null)
                throw new ConfigEditError(REASONS.MISSING, F.guiAddress.label, null);
            const {indent} = indentBefore(doc.xml, addr.start);
            edits.push({start: addr.end, end: addr.end, text: `\n${indent}<${f.name}>${wanted}</${f.name}>`});
            continue;
        }
        if (textOf(doc, node) === null)
            throw new ConfigEditError(REASONS.NOT_TEXT, f.label, doc.line(node.start));
        if (node.selfClosing)
            edits.push({start: node.start, end: node.end, text: `${doc.xml.slice(node.start, node.openEnd - 2).replace(/[ \t]+$/, '')}>${wanted}</${node.name}>`});
        else if (doc.xml.slice(node.openEnd, node.closeStart) !== wanted)
            edits.push({start: node.openEnd, end: node.closeStart, text: wanted});
    }
    if (a.ports === PORTS_OWN) {
        const nodes = listenNodes(doc);
        const same = nodes.length === OWN_LISTEN_ADDRESSES.length &&
            nodes.every((n, k) => !n.selfClosing && n.children.length === 0 && doc.xml.slice(n.openEnd, n.closeStart) === escapeText(OWN_LISTEN_ADDRESSES[k]));
        if (!same) {
            for (const n of nodes) {
                if (n.children.length > 0 || textOf(doc, n) === null)
                    throw new ConfigEditError(REASONS.NOT_TEXT, LISTEN.label, doc.line(n.start));
            }
            const lines = OWN_LISTEN_ADDRESSES.map(v => `<${LISTEN.name}>${escapeText(v)}</${LISTEN.name}>`);
            if (nodes.length === 0) {
                const first = options.children[0];
                if (!first)
                    throw new ConfigEditError(REASONS.NOT_UNDERSTOOD, LISTEN.label, doc.line(options.start));
                const {indent} = indentBefore(doc.xml, first.start);
                edits.push({start: first.start, end: first.start, text: `${lines.join(`\n${indent}`)}\n${indent}`});
            } else {
                nodes.forEach((n, k) => {
                    const where = indentBefore(doc.xml, n.start);
                    const from = where.ownLine ? where.lineStart - 1 : n.start;        // the newline before its own line goes with it
                    const first = indentBefore(doc.xml, nodes[0].start);
                    const text = k > 0 ? '' : lines.map(l => (first.ownLine ? `\n${first.indent}` : '') + l).join('');
                    edits.push({start: from, end: n.end, text});
                });
            }
        }
    }
    edits.sort((x, y) => y.start - x.start);
    for (let k = 1; k < edits.length; k++) {
        if (edits[k].end > edits[k - 1].start)
            throw new ConfigEditError(REASONS.NOT_UNDERSTOOD, 'file', doc.line(edits[k].start));
    }
    let out = doc.xml;
    for (const e of edits)
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    // The read-back: what is in the text now, not what was sent. A failure here is a bug of this module or a layout it mishandled.
    const problems = verifyConfig(out, a);
    if (problems.length > 0)
        throw new ConfigEditError(problems[0].reason, problems[0].field, problems[0].line);
    return {xml: out, changed: out !== xml};
}

// The read-back, also run before every start (H2). Returns a list of {field, reason, line}; empty = every field is as wanted. Never
// throws for the content of the file (a parse failure is one problem); a bad argument throws.
export function verifyConfig(xml, args) {
    const a = normaliseArgs(args);
    let doc;
    try {
        doc = parse(xml);
        checkSections(doc);
    } catch (e) {
        if (e instanceof ConfigEditError)
            return [{field: e.field, reason: e.reason, line: e.line}];
        throw e;
    }
    const problems = [];
    const add = (field, reason, node) => problems.push({field, reason, line: node ? doc.line(node.start) : null});
    for (const [f, value] of wantedFields(a)) {
        let node;
        try {
            node = single(doc, f);
        } catch (e) {
            if (!(e instanceof ConfigEditError))
                throw e;
            problems.push({field: e.field, reason: e.reason, line: e.line});
            continue;
        }
        if (node === null) {
            add(f.label, REASONS.MISSING, null);
            continue;
        }
        const text = textOf(doc, node);
        if (text === null)
            add(f.label, REASONS.NOT_TEXT, node);
        else if (text !== value || doc.xml.slice(node.openEnd, node.closeStart) !== escapeText(value))
            add(f.label, REASONS.WRONG_VALUE, node);
    }
    if (a.ports === PORTS_OWN) {
        let nodes = [];
        try {
            nodes = listenNodes(doc);
        } catch (e) {
            if (!(e instanceof ConfigEditError))
                throw e;
            problems.push({field: e.field, reason: e.reason, line: e.line});
        }
        const texts = nodes.map(n => textOf(doc, n));
        if (nodes.length !== OWN_LISTEN_ADDRESSES.length || texts.some((t, k) => t !== OWN_LISTEN_ADDRESSES[k]))
            add(LISTEN.label, nodes.length === 0 ? REASONS.MISSING : REASONS.WRONG_VALUE, nodes[0]);
    }
    return problems;
}
