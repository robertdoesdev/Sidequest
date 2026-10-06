/* =====================================================================
   SideQuest V2 — collectible Clear Card (canvas) + download + share
   One renderer is used for the on-screen preview AND the PNG, so what
   people see is exactly what they save.
   ===================================================================== */
import { typeColor } from './data.js';

export const CARD_W = 1080;
export const CARD_H = 1350;
const INK = '#13211a';
const CREAM = '#fffdee';
const FONT = "'Poppins', 'Helvetica Neue', Arial, sans-serif";

export const cardSummary = (q, entry) => {
  if (entry?.learned) return `“${entry.learned}”`;
  if (entry?.surprise) return `“${entry.surprise}”`;
  const again = { yes: 'Would absolutely do it again.', maybe: 'Might do it again.', no: 'Once was enough.' }[entry?.again];
  if (again) return again;
  return q.detail?.mission || q.description;
};

const fmtDate = (t) =>
  new Date(t || Date.now()).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

function wrap(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (ctx.measureText(last + '…').width > maxW && last.length) last = last.slice(0, -1);
    kept[maxLines - 1] = last.replace(/[\s,.;:]+$/, '') + '…';
    return kept;
  }
  return lines;
}

const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/** data: { quest, entry, number, typeInfo } */
export async function drawClearCard(canvas, { quest: q, entry, number = 1, icon = '✦' }) {
  try {
    if (document.fonts?.load) {
      await Promise.race([
        Promise.all([document.fonts.load(`900 40px Poppins`), document.fonts.load(`600 30px Poppins`)]),
        new Promise((r) => setTimeout(r, 1500))
      ]);
    }
  } catch {}

  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  const accent = typeColor(q.type);
  ctx.textBaseline = 'alphabetic';

  /* Base + accent block */
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const m = 54;
  ctx.fillStyle = accent;
  roundRect(ctx, m, m, CARD_W - m * 2, CARD_H - m * 2, 28);
  ctx.fill();

  /* Foil-style diagonal stripes, subtle collectible texture */
  ctx.save();
  roundRect(ctx, m, m, CARD_W - m * 2, CARD_H - m * 2, 28);
  ctx.clip();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = '#ffffff';
  for (let x = -CARD_H; x < CARD_W + CARD_H; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 26, 0);
    ctx.lineTo(x + 26 - CARD_H, CARD_H);
    ctx.lineTo(x - CARD_H, CARD_H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(CARD_W - 120, CARD_H - 330, 420, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /* Hard offset border (SideQuest’s sticker look) */
  ctx.lineWidth = 10;
  ctx.strokeStyle = INK;
  roundRect(ctx, m, m, CARD_W - m * 2, CARD_H - m * 2, 28);
  ctx.stroke();

  const px = m + 56;
  const inner = CARD_W - px * 2;

  /* Header strip */
  ctx.fillStyle = INK;
  ctx.font = `900 30px ${FONT}`;
  ctx.fillText('✳ SIDEQUEST COMPLETE', px, m + 110);
  ctx.textAlign = 'right';
  ctx.font = `800 26px ${FONT}`;
  ctx.fillText(`CLEAR No. ${String(number).padStart(3, '0')}`, CARD_W - px, m + 110);
  ctx.textAlign = 'left';
  ctx.fillRect(px, m + 134, inner, 6);

  /* Icon sticker */
  ctx.save();
  ctx.translate(CARD_W / 2, 400);
  ctx.rotate(-0.07);
  ctx.fillStyle = CREAM;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 8;
  ctx.shadowColor = INK;
  ctx.shadowOffsetX = 14;
  ctx.shadowOffsetY = 14;
  ctx.shadowBlur = 0;
  roundRect(ctx, -135, -135, 270, 270, 40);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.stroke();
  ctx.font = `160px ${FONT}, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.fillText(icon, 0, 10);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  /* Title */
  ctx.fillStyle = INK;
  let size = 84;
  let lines;
  for (; size >= 52; size -= 4) {
    ctx.font = `900 ${size}px ${FONT}`;
    lines = wrap(ctx, q.title.toUpperCase(), inner, 3);
    if (lines.length <= 3 && !lines[lines.length - 1].endsWith('…')) break;
  }
  const ty = 655;
  lines.forEach((l, i) => ctx.fillText(l, px, ty + i * (size * 1.02)));
  const afterTitle = ty + lines.length * size * 1.02;

  /* Chips */
  const chips = [q.type.toUpperCase(), `${q.minutes} MIN`, q.difficulty.toUpperCase()];
  ctx.font = `800 26px ${FONT}`;
  let cx = px;
  const cy = afterTitle + 6;
  chips.forEach((t) => {
    const w = ctx.measureText(t).width + 44;
    ctx.fillStyle = INK;
    roundRect(ctx, cx, cy, w, 54, 27);
    ctx.fill();
    ctx.fillStyle = CREAM;
    ctx.fillText(t, cx + 22, cy + 37);
    cx += w + 14;
  });

  /* Reflection / summary */
  const fy = CARD_H - m - 64;
  const sy = cy + 100;
  ctx.fillStyle = INK;
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText(entry?.learned || entry?.surprise ? 'IN THEIR WORDS' : 'THE MISSION', px, sy);
  ctx.font = `600 34px ${FONT}`;
  const textTop = sy + 50;
  const room = Math.max(1, Math.floor((fy - 100 - textTop) / 46) + 1);
  wrap(ctx, cardSummary(q, entry), inner, Math.min(3, room)).forEach((l, i) => ctx.fillText(l, px, textTop + i * 46));

  /* Footer */
  ctx.fillRect(px, fy - 70, inner, 6);
  ctx.font = `900 40px ${FONT}`;
  ctx.fillText('sidequest.', px, fy);
  ctx.textAlign = 'right';
  ctx.font = `800 26px ${FONT}`;
  ctx.fillText(fmtDate(entry?.date), CARD_W - px, fy - 4);
  ctx.textAlign = 'left';

  return canvas;
}

export const cardFileName = (q) =>
  `sidequest-clear-${q.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.png`;

const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, 'image/png'));

export async function downloadCard(canvas, q) {
  const blob = await toBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = cardFileName(q);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const shareText = (q, entry) =>
  `✳ SIDEQUEST COMPLETE\n${q.title}\n${q.type} · ${q.minutes} min · ${q.difficulty}` +
  (entry?.learned || entry?.surprise ? `\n“${entry.learned || entry.surprise}”` : '') +
  `\n#SideQuest`;

/** Returns 'shared' | 'copied' | 'cancelled' | 'failed' */
export async function shareCard(canvas, q, entry) {
  const text = shareText(q, entry);
  const url = location.origin && location.origin !== 'null' ? location.origin + location.pathname : undefined;

  try {
    if (navigator.canShare && navigator.share) {
      const blob = await toBlob(canvas);
      const file = new File([blob], cardFileName(q), { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title: 'SideQuest complete' });
        return 'shared';
      }
    }
    if (navigator.share) {
      await navigator.share({ text, title: 'SideQuest complete', url });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }

  try {
    await navigator.clipboard.writeText(url ? `${text}\n${url}` : text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export const canNativeShare = () => typeof navigator !== 'undefined' && !!navigator.share;
