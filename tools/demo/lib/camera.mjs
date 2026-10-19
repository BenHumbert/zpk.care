/**
 * The cut list. Every person's page stays open on its real dashboard and records itself the whole time; the camera
 * decides which one the film shows. cut(key) waits until nobody is speaking, brings that page to the front and logs
 * the moment. speedWhile(fn) marks a stretch of silent waiting (a proof, a poll, a batch timer) to be sped up in the
 * film; it starts only while the talking stick is idle, and the next spoken line ends it (the narrator calls
 * endSpeedUp() when a turn starts), so nobody's voice is ever sped up. lib/post.mjs builds the film from this log.
 *
 *   const camera = new Camera({ narrator, log });
 *   narrator.onTurnStart = (at) => camera.endSpeedUp(at);
 *   camera.register('insurer', { page, videoStartedAt, label: 'Insurer dashboard' });
 *   camera.scene('plan', { act: 1, title: 'The insurer publishes a plan' });
 *   await camera.cut('insurer');
 *   await camera.speedWhile(() => waitForProof(), { factor: 6 });
 */
export class Camera {
  constructor({ narrator = null, log = () => {}, minSpeedUpMs = 1500 } = {}) {
    this.narrator = narrator;
    this.log = log;
    this.minSpeedUpMs = minSpeedUpMs;
    this.shots = new Map();     // key -> { key, page, videoStartedAt, label, video }
    this.cuts = [];             // { at, key, act, scene }
    this.speedups = [];         // { from, to, factor, scene, key, label }
    this.scenes = [];           // { key, act, title, at }
    this.currentKey = null;
    this.open = null;
    this.act = null;
    this.sceneKey = null;
  }

  /** A page the camera may show. videoStartedAt is Date.now() taken right after the page was created. */
  register(key, { page, videoStartedAt, label = key }) {
    if (!page) throw new Error(`camera: no page for ${key}`);
    page.__shotKey = key;
    this.shots.set(key, { key, page, videoStartedAt, label, video: null });
    return this.shots.get(key);
  }

  has(key) { return this.shots.has(key); }

  /** Marks the start of a scene (for chapters, scenes.json and the player). */
  scene(key, { act, title } = {}) {
    this.sceneKey = key;
    if (act != null) this.act = act;
    this.scenes.push({ key, act: this.act, title: title || key, at: Date.now() });
  }

  get current() { return this.currentKey; }

  /** The page on camera now (captions go there). */
  page() {
    return this.currentKey ? this.shots.get(this.currentKey)?.page || null : null;
  }

  async cut(key, { wait = true } = {}) {
    const shot = this.shots.get(key);
    if (!shot) throw new Error(`camera: unknown shot "${key}" (known: ${[...this.shots.keys()].join(', ')})`);
    if (wait && this.narrator) await this.narrator.quiet();
    await shot.page.bringToFront().catch(() => {});
    const at = Date.now();
    if (this.open) this.endSpeedUp(at);
    if (this.currentKey !== key) {
      this.cuts.push({ at, key, act: this.act, scene: this.sceneKey });
      this.currentKey = key;
      this.log(`camera: ${shot.label}`);
    }
    return at;
  }

  /** Runs fn while the film plays this stretch at `factor`x. Starts only once nobody is speaking. */
  async speedWhile(fn, { factor = 4, label = '' } = {}) {
    if (this.narrator) await this.narrator.quiet();
    const w = { from: Date.now(), to: null, factor, scene: this.sceneKey, key: this.currentKey, label };
    this.speedups.push(w);
    this.open = w;
    try {
      return await fn();
    } finally {
      if (this.open === w) this.endSpeedUp();
    }
  }

  /** Closes an open speed-up (the narrator calls this when a line starts). */
  endSpeedUp(at = Date.now()) {
    if (!this.open) return;
    this.open.to = at;
    if (this.open.to - this.open.from < this.minSpeedUpMs) this.open.dropped = true;
    this.open = null;
  }

  /** What post needs, without the pages. */
  toJSON() {
    return {
      shots: Object.fromEntries([...this.shots.values()].map((s) => [s.key, { label: s.label, videoStartedAt: s.videoStartedAt, video: s.video }])),
      cuts: this.cuts,
      speedups: this.speedups.filter((w) => w.to && !w.dropped),
      scenes: this.scenes
    };
  }
}
