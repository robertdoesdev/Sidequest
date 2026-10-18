-- 002: widen the allowed avatar set (6 -> 24). Additive and safe to run on live data:
-- every existing value stays valid. Run this BEFORE deploying the matching front end.
alter table users drop constraint if exists users_avatar_check;
alter table users add constraint users_avatar_check check (avatar in ('', 'sun', 'bolt', 'leaf', 'wave', 'star', 'moon', 'fox', 'owl', 'cat', 'frog', 'crab', 'ghost', 'rocket', 'cactus', 'pizza', 'comet', 'mushroom', 'robot', 'ufo', 'gem', 'flame', 'cloud', 'dino', 'bee'));
