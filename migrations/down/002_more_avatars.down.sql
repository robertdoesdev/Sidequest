-- Manual rollback for 002. NOT run automatically (migrate() only reads top-level *.sql files).
-- Anyone using a new avatar falls back to the initial-letter avatar; nothing else is touched.
update users set avatar = '' where avatar not in ('', 'sun', 'bolt', 'leaf', 'wave', 'star', 'moon');
alter table users drop constraint if exists users_avatar_check;
alter table users add constraint users_avatar_check check (avatar in ('', 'sun', 'bolt', 'leaf', 'wave', 'star', 'moon'));
delete from schema_migrations where version = '002_more_avatars.sql';
