import test from 'node:test';
import assert from 'node:assert/strict';

const setEnv = ({ share, clipboard, exec } = {}) => {
  globalThis.location = { origin: 'https://sidequest.example', pathname: '/index.html' };
  Object.defineProperty(globalThis, 'navigator', { value: { share, clipboard }, configurable: true, writable: true });
  globalThis.document = {
    body: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {} }),
    execCommand: () => !!exec
  };
};
const { shareLink, profileUrl, questUrl, shareMessage } = await import('../share.js');

test('canonical links contain only public identifiers', () => {
  setEnv();
  assert.equal(profileUrl('anna_1'), 'https://sidequest.example/#/u/anna_1');
  assert.equal(questUrl('6'), 'https://sidequest.example/#/quest/6');
  assert.ok(!/token|auth|password/i.test(profileUrl('x_y')));
});

test('uses the native share sheet when available', async () => {
  let got;
  setEnv({ share: async (d) => { got = d; } });
  assert.equal(await shareLink({ title: 't', text: 'x', url: 'https://u' }), 'shared');
  assert.equal(got.url, 'https://u');
});

test('a dismissed share sheet is reported as cancelled, not an error', async () => {
  setEnv({ share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  assert.equal(await shareLink({ url: 'https://u' }), 'cancelled');
  assert.equal(shareMessage('cancelled'), '');
});

test('falls back to the clipboard when sharing is unsupported or fails', async () => {
  let copied;
  setEnv({ clipboard: { writeText: async (t) => { copied = t; } } });
  assert.equal(await shareLink({ url: 'https://u/1' }), 'copied');
  assert.equal(copied, 'https://u/1');
  setEnv({ share: async () => { throw new Error('boom'); }, clipboard: { writeText: async (t) => { copied = t; } } });
  assert.equal(await shareLink({ url: 'https://u/2' }), 'copied');
  assert.equal(copied, 'https://u/2');
});

test('reports failure honestly when nothing works', async () => {
  setEnv({ clipboard: { writeText: async () => { throw new Error('denied'); } }, exec: false });
  assert.equal(await shareLink({ url: 'https://u' }), 'failed');
  assert.match(shareMessage('failed'), /Couldn’t/);
});
