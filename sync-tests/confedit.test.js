// SPDX-License-Identifier: GPL-3.0-or-later
// sync/confedit.js on config.xml fixtures. The fixtures are real files of the spike (Syncthing 2.1.6, M-W10 logs 160-163) with the
// API key replaced by a recognisable fake one: no output of a failing run may contain it (S-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    ConfigEditError, OWN_LISTEN_ADDRESSES, PORTS_DEFAULT, PORTS_OWN, REASONS, editConfig, verifyConfig,
} from '../sync/confedit.js';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const GENERATED = fx('config-generated.xml');
const MEASURED = fx('config-ded-measured.xml');          // what John's instance looked like after the same edit (log 160, `ded`)
const FAKE_KEY = 'FAKEKEY-do-not-leak-0123456789';
const SOCK = '/home/a/w7da-ded/gui.sock';
const OWN = {socketPath: SOCK, ports: PORTS_OWN};
const DEF = {socketPath: SOCK, ports: PORTS_DEFAULT};

const count = (s, sub) => s.split(sub).length - 1;
const throwsConf = (fn, reason, field) => {
    let err;
    try {
        fn();
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof ConfigEditError, `expected a ConfigEditError, got ${err}`);
    if (reason)
        assert.equal(err.reason, reason);
    if (field)
        assert.equal(err.field, field);
    return err;
};

test('mode own: the edit of a generated file equals the measured file (only the device ID and startBrowser differ: startBrowser is a serve flag)', () => {
    const r = editConfig(GENERATED, OWN);
    assert.equal(r.changed, true);
    const normalised = r.xml
        .replaceAll('IQNQ7G7-ESEZ2AP-PCAFYD2-3NAV7BS-XDKY5PP-XPMGTDY-XNSKDYJ-BS4IGAL', 'F7FHFMI-RTTHC57-6GFA242-TE5CJBJ-FELSODE-D4A5DCE-E5PNOPG-LUEJJQJ')
        .replace('name="75dfa6e2bb14"', 'name="39d20ed11f21"')
        .replace('<startBrowser>true</startBrowser>', '<startBrowser>false</startBrowser>');
    assert.equal(normalised, MEASURED);
});

test('mode own: the eight fields and nothing else', () => {
    const {xml} = editConfig(GENERATED, OWN);
    assert.equal(count(xml, `<address>${SOCK}</address>`), 1);
    assert.equal(count(xml, '<unixSocketPermissions>0600</unixSocketPermissions>'), 1);
    assert.equal(count(xml, '<crashReportingEnabled>false</crashReportingEnabled>'), 1);
    assert.equal(count(xml, '<urAccepted>-1</urAccepted>'), 1);
    assert.equal(count(xml, '<autoUpgradeIntervalH>0</autoUpgradeIntervalH>'), 1);
    assert.equal(count(xml, '<localAnnouncePort>21127</localAnnouncePort>'), 1);
    assert.equal(count(xml, '<localAnnounceMCAddr>[ff12::8384]:21127</localAnnounceMCAddr>'), 1);
    assert.equal(count(xml, '<listenAddress>'), 3);
    assert.equal(count(xml, '<listenAddress>default</listenAddress>'), 0);
    assert.equal(count(xml, '<relaysEnabled>true</relaysEnabled>'), 1);                 // relays stay ON (A8)
    assert.ok(xml.indexOf('<listenAddress>tcp://0.0.0.0:22100') < xml.indexOf('<listenAddress>quic://0.0.0.0:22100'));
    assert.ok(xml.indexOf('<listenAddress>quic://0.0.0.0:22100') < xml.indexOf('<listenAddress>dynamic+https://'));
    // the lines it has no business with are untouched
    for (const keep of ['<globalAnnounceEnabled>true</globalAnnounceEnabled>', '<localAnnounceEnabled>true</localAnnounceEnabled>', '<natEnabled>true</natEnabled>'])
        assert.equal(count(xml, keep), 1, keep);
    assert.equal(count(xml, `<apikey>${FAKE_KEY}</apikey>`), 1);
});

test('mode own: idempotent, a second run is byte-identical and says unchanged; the measured file is already converged', () => {
    const once = editConfig(GENERATED, OWN);
    const twice = editConfig(once.xml, OWN);
    assert.equal(twice.xml, once.xml);
    assert.equal(twice.changed, false);
    const m = editConfig(MEASURED, {socketPath: '/home/a/w7da-ded/gui.sock', ports: PORTS_OWN});
    assert.equal(m.changed, false);
    assert.equal(m.xml, MEASURED);
});

test('mode default: the five fields only; listenAddress and the announce fields keep the stock values', () => {
    const {xml} = editConfig(GENERATED, DEF);
    assert.equal(count(xml, '<listenAddress>default</listenAddress>'), 1);
    assert.equal(count(xml, '<listenAddress>'), 1);
    assert.equal(count(xml, '<localAnnouncePort>21027</localAnnouncePort>'), 1);
    assert.equal(count(xml, '<localAnnounceMCAddr>[ff12::8384]:21027</localAnnounceMCAddr>'), 1);
    assert.equal(count(xml, `<address>${SOCK}</address>`), 1);
    assert.equal(count(xml, '<unixSocketPermissions>0600</unixSocketPermissions>'), 1);
    assert.equal(editConfig(xml, DEF).xml, xml);
    assert.deepEqual(verifyConfig(xml, DEF), []);
});

test('T12 a stock `default` entry becomes the three entries; extra and foreign entries converge to the three', () => {
    const extra = GENERATED.replace('<listenAddress>default</listenAddress>',
        '<listenAddress>default</listenAddress>\n        <listenAddress>tcp://10.9.9.9:1</listenAddress>\n        <listenAddress>default</listenAddress>');
    const r = editConfig(extra, OWN);
    assert.equal(count(r.xml, '<listenAddress>'), 3);
    assert.equal(r.xml, editConfig(GENERATED, OWN).xml);
    // the three present but in another order, or one missing, or one too many
    const reordered = MEASURED.replace(/(\s*<listenAddress>[^<]*<\/listenAddress>){3}/, [OWN_LISTEN_ADDRESSES[2], OWN_LISTEN_ADDRESSES[0], OWN_LISTEN_ADDRESSES[1]]
        .map(v => `\n        <listenAddress>${v}</listenAddress>`).join(''));
    assert.notEqual(reordered, MEASURED);
    assert.equal(editConfig(reordered, OWN).xml, MEASURED);
    const dropped = MEASURED.replace(/\n\s*<listenAddress>dynamic\+https[^<]*<\/listenAddress>/, '');
    assert.equal(count(dropped, '<listenAddress>'), 2);
    assert.equal(editConfig(dropped, OWN).xml, MEASURED);
    const withDefaultToken = MEASURED.replace('<listenAddress>quic://0.0.0.0:22100</listenAddress>', '<listenAddress>default</listenAddress>');
    assert.equal(editConfig(withDefaultToken, OWN).xml, MEASURED);
});

test('T12 listenAddress with no element at all is created; one outside <options> fails closed', () => {
    const none = GENERATED.replace(/\n\s*<listenAddress>default<\/listenAddress>/, '');
    assert.equal(count(none, 'listenAddress'), 0);
    assert.equal(editConfig(none, OWN).xml.includes('<listenAddress>tcp://0.0.0.0:22100</listenAddress>'), true);
    assert.deepEqual(verifyConfig(editConfig(none, OWN).xml, OWN), []);
    const outside = GENERATED.replace('<paused>false</paused>', '<paused>false</paused>\n        <listenAddress>tcp://1.2.3.4:5</listenAddress>');
    throwsConf(() => editConfig(outside, OWN), REASONS.WRONG_PARENT, 'options/listenAddress');
});

test('the one-element rule stays for every other field: a duplicate or a wrong parent fails closed (no relaxing)', () => {
    const dup = (xml, tag) => xml.replace(new RegExp(`(\\s*)(<${tag}>[^<]*</${tag}>)`), '$1$2$1$2');
    for (const tag of ['crashReportingEnabled', 'urAccepted', 'autoUpgradeIntervalH', 'localAnnouncePort', 'localAnnounceMCAddr'])
        throwsConf(() => editConfig(dup(GENERATED, tag), OWN), REASONS.DUPLICATE, `options/${tag}`);
    throwsConf(() => editConfig(dup(MEASURED, 'unixSocketPermissions'), OWN), REASONS.DUPLICATE, 'gui/unixSocketPermissions');
    throwsConf(() => editConfig(GENERATED.replace('<address>127.0.0.1:8384</address>', '<address>127.0.0.1:8384</address>\n        <address>127.0.0.1:8385</address>'), OWN),
        REASONS.DUPLICATE, 'gui/address');
    const moved = GENERATED.replace('<paused>false</paused>', '<paused>false</paused>\n        <urAccepted>-1</urAccepted>');
    throwsConf(() => editConfig(moved, OWN), REASONS.WRONG_PARENT, 'options/urAccepted');
    // the device addresses ("dynamic") are not a second gui/address
    assert.doesNotThrow(() => editConfig(GENERATED, OWN));
});

test('two <gui> or two <options> sections, or a missing one, fail closed', () => {
    throwsConf(() => editConfig(GENERATED.replace('</gui>', '</gui>\n    <gui enabled="true"><address>x</address></gui>'), OWN), REASONS.DUPLICATE, 'gui');
    throwsConf(() => editConfig(GENERATED.replace('</options>', '</options>\n    <options></options>'), OWN), REASONS.DUPLICATE, 'options');
    throwsConf(() => editConfig(GENERATED.replace(/<gui[\s\S]*?<\/gui>/, ''), OWN), REASONS.MISSING, 'gui');
    throwsConf(() => editConfig(GENERATED.replace('<options>', '<defaults><options>').replace('</options>', '</options></defaults>'), OWN), REASONS.WRONG_PARENT, 'options');
});

test('a field that is absent fails closed (only unixSocketPermissions is created)', () => {
    throwsConf(() => editConfig(GENERATED.replace(/\n\s*<crashReportingEnabled>[^<]*<\/crashReportingEnabled>/, ''), OWN), REASONS.MISSING, 'options/crashReportingEnabled');
    throwsConf(() => editConfig(GENERATED.replace(/\n\s*<localAnnouncePort>[^<]*<\/localAnnouncePort>/, ''), OWN), REASONS.MISSING, 'options/localAnnouncePort');
    // in mode default the announce fields are not asked for
    assert.doesNotThrow(() => editConfig(GENERATED.replace(/\n\s*<localAnnouncePort>[^<]*<\/localAnnouncePort>/, ''), DEF));
    throwsConf(() => editConfig(GENERATED.replace(/<address>127\.0\.0\.1:8384<\/address>/, ''), OWN), REASONS.MISSING, 'gui/address');
});

test('unixSocketPermissions is created right after gui/address, with the same indentation; a wrong mode is corrected', () => {
    const r = editConfig(GENERATED, OWN).xml;
    assert.ok(r.includes(`        <address>${SOCK}</address>\n        <unixSocketPermissions>0600</unixSocketPermissions>\n`));
    const wrong = MEASURED.replace('<unixSocketPermissions>0600<', '<unixSocketPermissions>0755<');
    assert.deepEqual(verifyConfig(wrong, OWN).map(p => [p.field, p.reason]), [['gui/unixSocketPermissions', REASONS.WRONG_VALUE]]);
    assert.equal(editConfig(wrong, OWN).xml, MEASURED);
});

test('a self-closing field element and an entity form of the wanted value are normalised', () => {
    const selfClosed = GENERATED.replace('<crashReportingEnabled>true</crashReportingEnabled>', '<crashReportingEnabled/>');
    const r = editConfig(selfClosed, OWN);
    assert.equal(count(r.xml, '<crashReportingEnabled>false</crashReportingEnabled>'), 1);
    const entity = MEASURED.replace('<urAccepted>-1</urAccepted>', '<urAccepted>&#45;1</urAccepted>');
    throwsConf(() => editConfig(entity, OWN), REASONS.NOT_TEXT, 'options/urAccepted');       // an entity this module does not know is refused
});

test('the socket path is escaped and read back; a bad path or mode argument is refused', () => {
    const odd = '/home/a & b/<x>/gui.sock';
    const r = editConfig(GENERATED, {socketPath: odd, ports: PORTS_OWN});
    assert.ok(r.xml.includes('<address>/home/a &amp; b/&lt;x&gt;/gui.sock</address>'));
    assert.deepEqual(verifyConfig(r.xml, {socketPath: odd, ports: PORTS_OWN}), []);
    assert.equal(editConfig(r.xml, {socketPath: odd, ports: PORTS_OWN}).changed, false);
    for (const bad of ['relative/gui.sock', '', '/a\nb', '/a\0b', '/a//b', null, 5])
        throwsConf(() => editConfig(GENERATED, {socketPath: bad, ports: PORTS_OWN}), REASONS.BAD_ARGUMENT);
    throwsConf(() => editConfig(GENERATED, {socketPath: SOCK, ports: 'elsewhere'}), REASONS.BAD_ARGUMENT);
    throwsConf(() => editConfig(GENERATED, {}), REASONS.BAD_ARGUMENT);
});

test('a layout it does not understand fails closed: DOCTYPE, CDATA, processing instruction, unbalanced, junk, two roots, huge input', () => {
    const broken = {
        doctype: GENERATED.replace('<configuration', '<!DOCTYPE x [<!ENTITY a "b">]>\n<configuration'),
        cdata: GENERATED.replace('<theme>default</theme>', '<theme><![CDATA[default]]></theme>'),
        pi: GENERATED.replace('<theme>', '<?x y?><theme>'),
        unbalanced: GENERATED.replace('</gui>', ''),
        mismatched: GENERATED.replace('</gui>', '</guix>'),
        trailingRoot: `${GENERATED}\n<configuration/>`,
        junkAttr: GENERATED.replace('<gui enabled="true"', '<gui enabled=true'),
        lt: GENERATED.replace('<gui enabled="true"', '<gui enabled="a<b"'),
        dupAttr: GENERATED.replace('<gui enabled="true"', '<gui enabled="true" enabled="false"'),
        empty: '',
        text: 'hello',
        truncated: GENERATED.slice(0, 400),
        deep: `<configuration>${'<a>'.repeat(40)}${'</a>'.repeat(40)}</configuration>`,
        huge: `<configuration>${' '.repeat(4 * 1024 * 1024 + 1)}</configuration>`,
        notXmlRoot: GENERATED.replace(/<configuration/g, '<config').replace('</configuration>', '</config>'),
    };
    for (const [name, xml] of Object.entries(broken))
        throwsConf(() => editConfig(xml, OWN), undefined, undefined);
    for (const [name, xml] of Object.entries(broken)) {
        const problems = verifyConfig(xml, OWN);
        assert.ok(problems.length > 0, name);
    }
    throwsConf(() => editConfig(null, OWN), REASONS.NOT_UNDERSTOOD, 'file');
});

test('S-3: no error, field or line of a failing run carries any text of the file (the fake key sits in every broken variant)', () => {
    const variants = [
        GENERATED.replace('</gui>', ''),                                                                   // unbalanced after the key
        GENERATED.replace(`<apikey>${FAKE_KEY}</apikey>`, `<apikey>${FAKE_KEY}`),                       // broken exactly at the key
        GENERATED.replace(`<apikey>${FAKE_KEY}</apikey>`, `<apikey a="${FAKE_KEY}>x</apikey>`),          // the key in an attribute
        GENERATED.replace('<gui enabled="true"', `<gui enabled="${FAKE_KEY}" enabled="${FAKE_KEY}"`),
        GENERATED.replace('<theme>default</theme>', `<theme>${FAKE_KEY}</theme>\n        <theme>${FAKE_KEY}</theme>`),
        GENERATED.replace('<crashReportingEnabled>true</crashReportingEnabled>', `<crashReportingEnabled>${FAKE_KEY}<x/></crashReportingEnabled>`),
        GENERATED.replace('<urAccepted>0</urAccepted>', `<urAccepted>${FAKE_KEY}</urAccepted><urAccepted>${FAKE_KEY}</urAccepted>`),
        GENERATED.replace('<address>127.0.0.1:8384</address>', `<address>${FAKE_KEY}</address><address>${FAKE_KEY}</address>`),
        GENERATED.replace('<listenAddress>default</listenAddress>', `<listenAddress>${FAKE_KEY}<b/></listenAddress>`),
        GENERATED.replace('<?xml', '<?xml').replace('<configuration version="52">', `<configuration version="52" k="${FAKE_KEY}"<`),
    ];
    let seen = 0;
    for (const xml of variants) {
        let thrown = null;
        try {
            editConfig(xml, OWN);
        } catch (e) {
            thrown = e;
        }
        const outputs = [];
        if (thrown) {
            seen++;
            outputs.push(thrown.message, thrown.reason, thrown.field, String(thrown.line), thrown.stack.split('\n')[0], JSON.stringify(thrown), String(thrown));
        }
        for (const p of verifyConfig(xml, OWN))
            outputs.push(JSON.stringify(p));
        for (const o of outputs) {
            assert.equal(String(o).includes(FAKE_KEY), false, `key in: ${o}`);
            assert.equal(String(o).includes('FAKEKEY'), false);
        }
    }
    assert.ok(seen >= 8, `the battery must really fail (${seen} of ${variants.length} threw)`);
});

test('verifyConfig: reports field, reason and line only; empty for a converged file; never the value', () => {
    assert.deepEqual(verifyConfig(MEASURED, OWN), []);
    const tampered = MEASURED.replace('<urAccepted>-1</urAccepted>', '<urAccepted>0</urAccepted>');
    const p = verifyConfig(tampered, OWN);
    assert.equal(p.length, 1);
    assert.deepEqual(Object.keys(p[0]).sort(), ['field', 'line', 'reason']);
    assert.equal(p[0].field, 'options/urAccepted');
    assert.equal(p[0].line, tampered.slice(0, tampered.indexOf('<urAccepted>')).split('\n').length);
    // the stock file is not converged
    assert.ok(verifyConfig(GENERATED, OWN).length >= 6);
    // a GUI address back on TCP is a problem (the first start must never open it)
    assert.deepEqual(verifyConfig(MEASURED.replace(`<address>${SOCK}</address>`, '<address>127.0.0.1:8384</address>'), OWN).map(x => x.field), ['gui/address']);
    // the socket path of another home is a problem
    assert.deepEqual(verifyConfig(MEASURED, {socketPath: '/home/b/gui.sock', ports: PORTS_OWN}).map(x => x.field), ['gui/address']);
});

test('the module has no import and names no process, file or network API', () => {
    const text = readFileSync(new URL('../sync/confedit.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\.exec\(/g, '.match(');       // RegExp#exec is not a process
    assert.equal(/^\s*import\s/m.test(text), false);
    assert.equal(/\b(Gio|GLib|Subprocess|spawn|exec|child_process|readFile|writeFile|fetch|XMLHttpRequest|eval)\b/.test(text), false);
});
