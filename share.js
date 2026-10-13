/* Sharing helpers: canonical links + Web Share API with a clipboard fallback.
   Links are built only from public identifiers (a username or a quest id). They never contain tokens or private data. */
export const siteUrl = () => `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
export const profileUrl = (username) => `${siteUrl()}#/u/${encodeURIComponent(username)}`;
export const questUrl = (id) => `${siteUrl()}#/quest/${encodeURIComponent(id)}`;

async function copy(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {                                         // older browsers / non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Returns 'shared' | 'copied' | 'cancelled' | 'failed' */
export async function shareLink({ title, text, url }) {
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
    /* any other share error: fall through to copying the link */
  }
  return (await copy(url)) ? 'copied' : 'failed';
}

export const shareMessage = (r) =>
  ({ shared: 'Shared.', copied: 'Link copied.', cancelled: '', failed: 'Couldn’t share or copy. Long-press the link instead.' })[r];
