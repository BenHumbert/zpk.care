/**
 * Runs a line's whiteboard actions (lib/claim-script.mjs `board: [...]`) while the line plays: the narrator calls
 * runner.during(line) as its during() hook, so the strokes start at their cue and the turn ends only when both the
 * clip and the last stroke are done. Used by director.mjs and whiteboard-preview.mjs alike.
 *
 * Cues ("when"): 'start' (default), a fraction of the clip (0.45), { word: 'group' } (the word's start, from the
 * word times py/check_asr.py saved next to the clip; a rehearsal without them falls back to { at } or 0), or 'end'.
 * A write without ms gets 80% of the clip from its cue (62% when more strokes follow it in the same line).
 */
import { eq } from './equations.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** { card: '2b', find: 'f5' } -> { eq: 'eq-2b', find: 'f5' }; other targets pass through. */
export function boardTarget(t) {
  if (t == null || typeof t === 'string') return t;
  if (t.card != null) {
    const { card, ...rest } = t;
    eq(card); // fails early on an unknown card
    return { eq: `eq-${card}`, ...rest };
  }
  return t;
}

/** Throws on a board action the board cannot run (unknown verb or card); the director checks the script before T0. */
export function checkBoardAction(a) {
  const verbs = ['clear', 'title', 'write', 'annotate', 'value', 'circle', 'underline', 'box', 'arrow', 'check', 'erase', 'pen'];
  if (!verbs.includes(a.do)) throw new Error(`unknown board action "${a.do}"`);
  if (a.do === 'write') eq(a.card);
  for (const k of ['target', 'near', 'from', 'to']) if (a[k] && typeof a[k] === 'object' && a[k].card != null) eq(a[k].card);
}

export function makeBoardRunner({ board, log = () => {} }) {
  function cueAt(when, clip) {
    if (when == null || when === 'start') return 0;
    if (when === 'end') return clip.ms;
    if (typeof when === 'number') return Math.round(clip.ms * Math.max(0, Math.min(1, when)));
    if (typeof when === 'object' && when.word) {
      const w = (clip.words || []).find((x) => norm(x.word) === norm(when.word));
      if (w) return Math.max(0, Math.round(w.startMs));
      return typeof when.at === 'number' ? Math.round(clip.ms * when.at) : 0;
    }
    return 0;
  }

  async function act(a, ms) {
    switch (a.do) {
      case 'clear': return board.start('clear', { ghost: a.ghost ?? 0.06, ms: a.ms });
      case 'title': return board.start('setTitle', a.text, { ms: a.ms, color: a.color });
      case 'write': {
        const card = eq(a.card);
        return board.start('writeEquation', card.latex, { id: a.id || `eq-${a.card}`, durationMs: ms, size: a.size, color: a.color, at: a.at, align: a.align, order: a.order });
      }
      case 'annotate': return board.start('annotate', { text: a.text, near: boardTarget(a.near ?? a.target), side: a.side, at: a.at, color: a.color, size: a.size, rotate: a.rotate, ms: a.ms, id: a.id });
      case 'value': return board.start('value', { target: boardTarget(a.target), text: a.text, side: a.side, color: a.color, size: a.size, ms: a.ms, id: a.id });
      case 'circle':
      case 'underline':
      case 'box':
      case 'check': return board.start(a.do, { target: boardTarget(a.target), color: a.color, pad: a.pad, ms: a.ms, label: a.label, width: a.width, id: a.id });
      case 'arrow': return board.start('arrow', { from: boardTarget(a.from), to: boardTarget(a.to), bend: a.bend, color: a.color, ms: a.ms, id: a.id });
      case 'erase': return board.start('erase', { ids: a.ids, ms: a.ms });
      case 'pen': return board.start('pen', a.visible !== false);
      default: log(`board: unknown action ${a.do}`);
    }
  }

  /** Runs `actions` against a clip { ms, words }: each queued on the board's one pen at its cue; resolves when idle. */
  async function run(actions, clip) {
    if (!actions || !actions.length) return;
    const plan = actions.map((a, i) => ({ a, i, at: cueAt(a.when, clip) })).sort((x, y) => x.at - y.at || x.i - y.i);
    const t0 = Date.now();
    for (let k = 0; k < plan.length; k++) {
      const { a, at } = plan[k];
      const wait = at - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      let ms = a.ms;
      if (a.do === 'write' && ms == null) {
        const more = plan.slice(k + 1).some((p) => p.a.do !== 'write');
        ms = Math.max(1500, Math.round((more ? 0.62 : 0.8) * Math.max(0, clip.ms - at)));
      }
      await act(a, ms);
    }
    await board.idle();
  }

  return {
    run,
    /** The narrator's during() hook for one line. */
    during: (line) => (line.board && line.board.length ? (clip) => run(line.board, clip) : undefined)
  };
}
