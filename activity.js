/* Activity highlights, derived ONLY from data the app already has:
   completed quests (with dates), the daily streak, showcase posts and challenges the server returned.
   Nothing is invented and no number is shown unless it is counted from real records. */

const DAY = 86400000;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function buildActivity({ completed = [], questById, streak = 0, challenges = null, friends = null, now = Date.now() }) {
  const events = [];
  for (const c of completed) {
    const q = questById(c.id);
    if (!q || !c.date) continue;
    events.push({ kind: 'quest', at: c.date, title: q.title, icon: q.icon, href: `#/quest/${c.id}/card`, text: `Finished “${q.title}”`, shared: !!c.public });
  }
  for (const c of challenges || []) {
    const q = questById(c.questId);
    const other = c.mine === 'sender' ? c.to : c.from;
    if (!q || !other) continue;
    if (c.status === 'completed') events.push({ kind: 'challenge', at: Math.max(c.youDoneAt || 0, c.theyDoneAt || 0, c.updated || 0), icon: '🤝', href: '#/challenges', text: `You and @${other.username} both finished “${q.title}”` });
    else if (c.status === 'accepted' && c.youDone) events.push({ kind: 'challenge', at: c.youDoneAt || c.updated || 0, icon: '⏳', href: '#/challenges', text: `You finished “${q.title}”. Waiting on @${other.username}` });
    else if (c.status === 'pending' && c.mine === 'recipient') events.push({ kind: 'challenge', at: c.created || 0, icon: '📨', href: '#/challenges', text: `@${other.username} challenged you to “${q.title}”` });
  }
  events.sort((a, b) => b.at - a.at);

  const done = completed.filter((c) => c.date && questById(c.id));
  const weekAgo = now - 7 * DAY;
  const thisWeek = done.filter((c) => c.date >= weekAgo).length;
  const todayCount = done.filter((c) => sameDay(c.date, now)).length;
  const types = {};
  for (const c of done) { const t = questById(c.id).type; types[t] = (types[t] || 0) + 1; }
  const topType = Object.entries(types).sort((a, b) => b[1] - a[1])[0] || null;
  const weirdest = done.map((c) => questById(c.id)).sort((a, b) => (b.weirdness - a.weirdness) || (b.confidence - a.confidence))[0] || null;
  const bothDone = (challenges || []).filter((c) => c.status === 'completed').length;

  const highlights = [];
  if (streak >= 2) highlights.push({ icon: '🔥', title: `${streak}-day streak`, text: 'Daily quests finished on consecutive days.' });
  if (thisWeek) highlights.push({ icon: '📅', title: `${thisWeek} quest${thisWeek === 1 ? '' : 's'} this week`, text: todayCount ? `${todayCount} of them today.` : 'In the last 7 days.' });
  if (topType && done.length >= 3) highlights.push({ icon: '🎭', title: `Your vibe: ${topType[0]}`, text: `${topType[1]} of your ${done.length} finished quests.` });
  if (weirdest && weirdest.weirdness >= 2) highlights.push({ icon: '👁️', title: 'Weirdest thing you’ve done', text: weirdest.title });
  if (bothDone) highlights.push({ icon: '🤝', title: `${bothDone} challenge${bothDone === 1 ? '' : 's'} won together`, text: 'Quests you and a friend both finished.' });
  return { events, highlights, totals: { quests: done.length, friends: friends ? friends.length : null } };
}
