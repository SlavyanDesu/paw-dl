import { expect, test } from 'bun:test';
import { parseCreator, parsePost, parsePostList } from './schemas.ts';

// Shapes recorded from live API 2026-09-11. IDs kept, bodies trimmed.
const LIVE_PROFILE = {
  id: '126855042',
  name: 'HONKIBOOTY',
  service: 'patreon',
  indexed: '2026-06-10T20:00:00',
  updated: '2026-09-11T17:00:00',
  public_id: null,
  relation_id: null,
  ever_imported: true,
  kemono_favorited: 13428,
};

const LIVE_POST = {
  id: '169158637',
  user: '2648863',
  service: 'patreon',
  title: 'Dj Owari ',
  content: '<p></p>',
  embed: {},
  shared_file: false,
  added: '2026-09-11T01:00:00',
  published: '2026-09-10T15:51:40',
  edited: '2026-09-10T15:51:40',
  file: {
    name: 'djowai.jpg',
    path: '/6c/0b/6c0b44f12b2f7fb2d995dffadd61f330ed5588a2d56d9212acbd4fae5586b47f.jpg',
  },
  attachments: [
    { name: 'djowai2.jpg', path: '/1e/bd/1ebd9ae5d85378f5e92bb50910ec50bdfec5ca32252a164bde6244d244e1568e.jpg' },
    { name: 'Djowari.clip', path: '/39/42/39422b24b46aacdbb0df7f058613df7a8935ccbf594955594b616fcce17f16cb.clip' },
    { name: 'Djowari.psd', path: '/c0/89/c089d749316d7591be039192e8b528e5376520d752738ca0c1dc32767b55b2d2.psd' },
  ],
  poll: null,
  captions: null,
  tags: null,
  origin: 'import',
  preview_state: 'scraped',
  has_full: true,
  detail_fetched: true,
  next: '168173523',
  prev: null,
};

test('live profile parses, extra fields ignored', () => {
  expect(parseCreator(LIVE_PROFILE)).toEqual({ name: 'HONKIBOOTY' });
});

test('live post parses with non-media attachments kept', () => {
  const post = parsePost(LIVE_POST);

  expect(post.id).toBe('169158637');
  expect(post.title).toBe('Dj Owari ');
  expect(post.published).toBe('2026-09-10T15:51:40');
  expect(post.file).toEqual({
    name: 'djowai.jpg',
    path: '/6c/0b/6c0b44f12b2f7fb2d995dffadd61f330ed5588a2d56d9212acbd4fae5586b47f.jpg',
    deferred: false,
  });
  expect(post.attachments.map((file) => file.name)).toEqual(['djowai2.jpg', 'Djowari.clip', 'Djowari.psd']);
});

test('wrapped post and list forms parse', () => {
  expect(parsePost({ post: LIVE_POST }).id).toBe('169158637');
  expect(parsePostList([{ id: '1' }, { id: '2' }]).map((post) => post.id)).toEqual(['1', '2']);
  expect(parsePostList({ posts: [{ id: '3' }] }).map((post) => post.id)).toEqual(['3']);
});

test('empty file forms collapse to null and filter out', () => {
  const post = parsePost({
    ...LIVE_POST,
    file: null,
    attachments: [null, undefined, {}, { name: 'x', path: '' }, { name: 'ok.jpg', path: '/ok.jpg' }],
  });

  expect(post.file).toBeNull();
  expect(post.attachments).toEqual([{ name: 'ok.jpg', path: '/ok.jpg', deferred: false }]);
});

test('missing name and deferred default', () => {
  const post = parsePost({ ...LIVE_POST, file: { path: '/a.jpg' }, attachments: [] });

  expect(post.file).toEqual({ name: '', path: '/a.jpg', deferred: false });
});

test('empty ids and names reject', () => {
  expect(() => parseCreator({ name: '  ' })).toThrow();
  expect(() => parsePost({ ...LIVE_POST, id: ' ' })).toThrow();
  expect(() => parsePostList([{ id: '' }])).toThrow();
});
