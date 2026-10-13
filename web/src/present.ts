// Presentation mode (M3): pick a layout silhouette, go full screen, fill each
// slot with a model, field, mode and region. Every slot shows the same valid
// time; the frame is drawn onto one canvas, so a capture or a PNG keeps its
// titles, color bars and credit.
import { config, gridCovers, productById, regionById, regionDepth, type RegionConfig } from "./config";
import {
  drawFrame, frameSize, layoutFrame, MAP_SCALE, SILHOUETTES, silhouetteById, slotCount,
  type FrameLayout, type Silhouette,
} from "./compose";
import { FPS_OPTIONS } from "./prefs";
import { MapView } from "./mapview";
import type { DisplayPrefs } from "./prefs";
import { loadSlot, runName, slotBar, slotRun, type SlotBar, type SlotFrame } from "./slot";
import { planFrame, hoursOf, type Product } from "./sources";
import { parseState, serializeState, type ViewState } from "./state";
import { addHours, fmtTime, fmtValid, parseRunId, runId, UTC_ZONE, zoneById, type Zone } from "./time";
import { axisOf, clip, coverage, daysWindow, hoursBetween, snap, type Axis, type Span } from "./timeaxis";
import { defaultOverlays, FIELD_ITEMS, fieldItem, viewById, type FieldItem } from "./views";
import { viewModeOf } from "./sources";
import { pairFor } from "./alignment";

export interface PresentHost {
  products: Map<string, Product>;
  display(): DisplayPrefs;
  /** The site's view when presentation opens: its state, compared model and valid time. */
  seed(): { state: ViewState; compare: string | null; valid: Date };
  /** Change the loop speed (remembered, shared with the site's). */
  setFps(fps: number): void;
  /** Presentation closed: the site redraws and rewrites its URL. */
  exit(): void;
}

const STORE = "rtr:presentation";
const LOOP_HOLD_MS = 1500;
/** MP4 exports run at a constant 30 fps, which every editor and platform takes. */
const MP4_FPS = 30;
const IDLE_MS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, Math.max(0, ms)));

/** A saved or linked layout: a silhouette and each slot in the site's link form (no time). */
export interface SavedLayout {
  silhouette: string;
  slots: string[];
}

/**
 * A slot as a link query, without its time or a pinned run: a link or saved
 * layout opens on the newest runs. (A past run picked in a slot's editor
 * lasts for the session.)
 */
export function slotQuery(s: ViewState, latest: string): string {
  const q = new URLSearchParams(serializeState({ ...s, run: null }, latest));
  q.delete("t");
  return q.toString().replace(/%2C/g, ",");
}

/** `?present=quad&t=…&s1=…`: the layout and time, for the address bar and links. */
export function presentSearch(layout: SavedLayout, valid: Date | null): string {
  const q = new URLSearchParams();
  q.set("present", layout.silhouette);
  if (valid) q.set("t", runId(valid));
  layout.slots.forEach((s, i) => q.set(`s${i + 1}`, s));
  return `?${q.toString()}`;
}

/** The layout a URL names, or null. */
export function parsePresent(search: string): (SavedLayout & { valid: string | null }) | null {
  const q = new URLSearchParams(search);
  const sil = silhouetteById(q.get("present"));
  if (!sil) return null;
  const slots: string[] = [];
  for (let i = 1; i <= slotCount(sil); i++) slots.push(q.get(`s${i}`) ?? "");
  const t = q.get("t");
  return { silhouette: sil.id, slots, valid: t && /^\d{10}$/.test(t) ? t : null };
}

/** An element with properties (className, textContent, type, …) and children. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e: HTMLElementTagNameMap[K] = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

export class Presentation {
  private root = el("div", { className: "present", id: "present", hidden: true });
  private stage = el("div", { className: "present-stage" });
  private canvas = el("canvas", { className: "present-canvas", id: "present-canvas" });
  private overlay = el("div", { className: "present-slots" });
  private picker = el("div", { className: "present-picker", id: "present-picker", hidden: true });
  private editor = el("div", { className: "present-editor", id: "present-editor", hidden: true });
  private controls = el("div", { className: "present-controls", id: "present-controls" });
  private sil: Silhouette | null = null;
  private slots: ViewState[] = [];
  private valid = new Date();
  private frames: (SlotFrame | null)[] = [];
  private maps: (MapView | null)[] = [];
  private memos: Map<string, unknown>[] = [];
  private layout: FrameLayout | null = null;
  private axis!: Axis;
  private loop: "all" | "week" = "all";
  private token = 0;
  private playing = false;
  private playGen = 0;
  private preloadGen = 0;
  private lastRender: Promise<void> = Promise.resolve();
  private editing: number | null = null;
  /** Bumped to stop the MP4 export running. */
  private exportGen = 0;
  /** The running export's generation, until it has fully stopped (no second one starts meanwhile). */
  private exporting: number | null = null;
  /** The frames are this layout's (false until its first render, so empty slots say "Loading…"). */
  private loaded = false;
  private guide = false;
  private idleTimer = 0;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private ro = new ResizeObserver(() => this.paint());

  constructor(private host: PresentHost) {
    this.stage.append(this.canvas, this.overlay);
    this.root.append(this.stage, this.controls, this.editor, this.picker);
    document.body.appendChild(this.root);
    this.buildControls();
    this.root.addEventListener("pointermove", () => this.wake());
    if (window.__wxtrend) {
      window.__wxtrend.presentFrame = async (k, outWidth) => {
        await this.lastRender;
        const c = this.renderOffscreen(k);
        if (!outWidth) return { width: c.width, height: c.height, png: c.toDataURL("image/png") };
        // A downscale, to check what a 480p viewer sees
        const small = document.createElement("canvas");
        small.width = outWidth;
        small.height = Math.round((c.height * outWidth) / c.width);
        const sctx = small.getContext("2d")!;
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(c, 0, 0, small.width, small.height);
        return { width: c.width, height: c.height, png: small.toDataURL("image/png") };
      };
    }
    document.addEventListener("fullscreenchange", () => {
      this.syncFullscreenButton();
      this.paint();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  // ---------------------------------------------------------------- open, close

  /** Show the silhouette picker. */
  openPicker(): void {
    this.showRoot();
    this.buildPicker();
    this.picker.hidden = false;
    this.picker.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Open a linked or saved layout (no full screen: that needs a click, or F). */
  restore(layout: SavedLayout, valid: string | null): void {
    const sil = silhouetteById(layout.silhouette);
    if (!sil) return;
    const seeds = this.seedSlots(slotCount(sil));
    this.slots = seeds.map((seed, i) => this.parseSlot(layout.slots[i], seed));
    this.showRoot();
    this.begin(sil, valid ? parseRunId(valid) : this.host.seed().valid);
  }

  private showRoot(): void {
    if (this.isOpen) return;
    this.root.hidden = false;
    document.documentElement.classList.add("presenting");
    window.addEventListener("keydown", this.keyHandler, true);
    this.ro.observe(this.stage);
    this.wake();
  }

  /** Start a layout: keep slots already filled, seed the rest from the site's view. */
  private begin(sil: Silhouette, valid: Date): void {
    this.closeEditor();
    this.sil = sil;
    const n = slotCount(sil);
    const seeds = this.seedSlots(n);
    this.slots = Array.from({ length: n }, (_, i) => this.slots[i] ?? seeds[i]);
    this.frames = new Array(n).fill(null);
    this.loaded = false;
    this.maps = this.maps.slice(0, n);
    this.memos = Array.from({ length: n }, (_, i) => this.memos[i] ?? new Map());
    this.picker.hidden = true;
    this.computeAxis();
    this.valid = this.onAxis(valid);
    this.syncControls();
    this.resetPreload();
    void this.checkMp4();
    this.update();
  }

  /**
   * Leave presentation mode. The layout is forgotten (the next one starts
   * from the site's view; "Resume last layout" brings this one back), and a
   * running preload or export stops.
   */
  close(): void {
    if (!this.isOpen) return;
    this.stopPlay();
    this.preloadGen++;
    this.preloadKey = "";
    this.exportGen++;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.closeEditor();
    this.root.hidden = true;
    this.picker.hidden = true;
    this.sil = null;
    this.slots = [];
    this.frames = [];
    this.layout = null;
    this.token++; // a render in flight is dropped
    document.documentElement.classList.remove("presenting");
    window.removeEventListener("keydown", this.keyHandler, true);
    this.ro.disconnect();
    this.host.exit();
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void this.root.requestFullscreen?.().catch(() => {});
  }

  // ---------------------------------------------------------------- slots

  /** Can this product show the item in the region? */
  private usable(id: string, item: FieldItem, region: RegionConfig): boolean {
    const p = this.host.products.get(id);
    return !!p && item.fields.every((f) => f in p.manifest.fields) && gridCovers(p.cfg.grid, region.box);
  }

  private usableModels(s: ViewState): string[] {
    const item = fieldItem(s.view, s.variable), region = regionById(s.region)!;
    return config.products.map((p) => p.id).filter((id) => this.usable(id, item, region));
  }

  /**
   * Slots for a new layout: the site's view first (side by side fills two
   * slots), then copies of it, each with the next model not yet shown, so a
   * roundup needs no picks at all.
   */
  private seedSlots(n: number): ViewState[] {
    const { state, compare } = this.host.seed();
    const base: ViewState = { ...state, valid: null };
    const out: ViewState[] = [];
    if (base.mode === "compare" && base.compareView === "side") {
      out.push({ ...base, mode: "fcst" });
      if (compare) out.push({ ...base, mode: "fcst", product: compare, run: null, compare: null });
    } else {
      out.push(base.mode === "compare" ? { ...base, compare } : base);
    }
    const first = out[0];
    const models = this.usableModels(first);
    while (out.length < n) {
      const used = new Set(out.map((s) => s.product));
      const next = models.find((m) => !used.has(m)) ?? first.product;
      out.push(this.withProduct({ ...first, mode: first.mode === "compare" ? "fcst" : first.mode, compare: null }, next));
    }
    return out.slice(0, n);
  }

  /** A slot from its link form; anything missing or unusable falls back to `seed`. */
  private parseSlot(q: string, seed: ViewState): ViewState {
    if (!q) return seed;
    const s = { ...parseState(`?${q}`), valid: null };
    if (!this.host.products.has(s.product) || !this.usable(s.product, fieldItem(s.view, s.variable), regionById(s.region)!)) return seed;
    if (s.mode === "compare" && !(s.compare && this.host.products.has(s.compare))) s.mode = "fcst";
    return s;
  }

  /**
   * Switch a slot's model, keeping what it can. Lag follows the model, and so
   * does 500 mb shading across the ensemble-mean line, as on the site before
   * a shading is picked: means on heights (their vorticity is nearly flat).
   */
  private withProduct(s: ViewState, id: string): ViewState {
    const p = this.host.products.get(id)!;
    const was = this.host.products.get(s.product)!;
    const next: ViewState = { ...s, product: id, run: null };
    if (!p.cfg.lags.includes(next.lag)) next.lag = p.cfg.defaultLag;
    const view = viewById(next.view);
    const mean = (x: Product) => x.cfg.group === "Ensemble mean";
    if (view.id === "h500" && mean(p) !== mean(was)) next.variable = mean(p) ? "hgt" : "vort";
    if (view.variables && !view.variables.some((v) => v.id === next.variable && v.field in p.manifest.fields)) {
      next.variable = view.variables.find((v) => v.field in p.manifest.fields)?.id ?? next.variable;
    }
    if (next.compare === id) next.compare = null;
    return next;
  }

  private saved(): SavedLayout {
    return {
      silhouette: this.sil!.id,
      slots: this.slots.map((s) => slotQuery(s, this.host.products.get(s.product)!.manifest.latest!)),
    };
  }

  private remember(): void {
    const layout = this.saved();
    history.replaceState(null, "", presentSearch(layout, this.valid));
    try {
      localStorage.setItem(STORE, JSON.stringify(layout));
    } catch {
      // Storage blocked: the layout lasts for this page
    }
  }

  private lastSaved(): SavedLayout | null {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) ?? "null");
      return v && silhouetteById(v.silhouette) && Array.isArray(v.slots) ? v : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- time

  /** The scrubber spans the slots' models: their latest runs, and any pinned run. */
  private computeAxis(): void {
    const spans: Span[] = [];
    const steps: number[] = [];
    for (const s of this.slots) {
      const p = this.host.products.get(s.product)!;
      spans.push(coverage(parseRunId(p.manifest.latest!), hoursOf(p)));
      spans.push(coverage(parseRunId(slotRun(s, p)), hoursOf(p)));
      steps.push(p.cfg.fhr.step);
    }
    this.axis = axisOf(spans, Math.min(...steps));
  }

  private onAxis(t: Date): Date {
    const a = this.axis;
    if (t < a.start) return a.start;
    if (t > a.end) return a.end;
    return snap(a, t, -1);
  }

  private get week(): Span | null {
    return daysWindow(this.axis, new Date(), zoneOf(this.host.display().zone), 7);
  }

  private loopSpan(): Span {
    return (this.loop === "week" && this.week) || this.axis;
  }

  private setValid(t: Date, fromPlay = false): void {
    if (!fromPlay) this.stopPlay();
    this.valid = this.onAxis(t);
    this.update(fromPlay);
  }

  private step(dir: number, hours = this.axis.step): void {
    this.setValid(addHours(this.valid, dir * hours));
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
      return;
    }
    this.playing = true;
    this.syncPlayButton();
    const loop = this.loopSpan();
    if (this.valid < loop.start || this.valid >= loop.end) this.setValid(loop.start, true);
    void this.runLoop(++this.playGen);
  }

  private async runLoop(gen: number): Promise<void> {
    try {
      let at = performance.now();
      await this.lastRender;
      while (gen === this.playGen) {
        const loop = this.loopSpan();
        const hold = this.valid >= loop.end ? LOOP_HOLD_MS : 0;
        await sleep(at + 1000 / this.host.display().fps + hold - performance.now());
        if (gen !== this.playGen) return;
        at = performance.now();
        const next = addHours(this.valid, this.axis.step);
        this.setValid(next > loop.end || this.valid < loop.start ? loop.start : next, true);
        await this.lastRender;
      }
    } finally {
      if (gen === this.playGen) this.stopPlay();
    }
  }

  private stopPlay(): void {
    if (!this.playing) return;
    this.playing = false;
    this.playGen++;
    this.syncPlayButton();
    this.remember();
  }

  // ---------------------------------------------------------------- render

  private update(fromPlay = false): void {
    if (!this.sil) return;
    this.syncTime();
    if (!fromPlay) this.remember();
    this.lastRender = this.render();
  }

  private async render(): Promise<void> {
    const token = ++this.token;
    this.root.dataset.state = "loading";
    const d = this.host.display();
    const ctxFor = (i: number) => ({ products: this.host.products, zone: zoneOf(d.zone), units: d.units, now: new Date(), memo: this.memos[i] });
    const frames = await Promise.all(this.slots.map((s, i) => loadSlot(s, this.valid, ctxFor(i)).catch(() => null)));
    if (token !== this.token) return;
    this.frames = frames;
    this.loaded = true;
    this.paint();
    this.root.dataset.state = "ready";
    this.root.dataset.slots = String(frames.length);
    this.root.dataset.drawn = String(frames.filter((f) => f?.scene).length);
  }

  /** The frame's canvas fitted to the window: canvas pixels per layout pixel. */
  private fit(): number {
    const sil = this.sil!;
    const { w, h } = frameSize(sil.frame);
    const box = this.stage.getBoundingClientRect();
    const scale = Math.max(0.05, Math.min(box.width / w, box.height / h));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = Math.floor(w * scale), cssH = Math.floor(h * scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const k = (cssW * dpr) / w;
    const pw = Math.round(w * k), ph = Math.round(h * k);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.overlay.style.width = `${cssW}px`;
    this.overlay.style.height = `${cssH}px`;
    return k;
  }

  /** Draw the frame from the loaded slots (also on resize and for the guide). */
  private paint(): void {
    if (!this.sil || !this.isOpen || this.picker.hidden === false) return;
    const k = this.fit();
    this.layout = layoutFrame(this.sil, this.bars(this.slots));
    const canvases = this.drawMaps(this.maps, k, this.layout, this.frames);
    const ctx = this.canvas.getContext("2d")!;
    drawFrame(ctx, k, this.layout, this.frames, canvases, this.frameText(this.valid), {
      guide: this.guide, selected: this.editing, empty: this.loaded ? "This slot couldn't be loaded" : "Loading…",
    });
    this.placeSlotButtons();
  }

  /** Each slot's color bar, from its view: what the layout reserves room for. */
  private bars(slots: ViewState[]): SlotBar[] {
    const units = this.host.display().units;
    return slots.map((s, i) => slotBar(s, this.host.products.get(s.product)!, units, i));
  }

  private frameText(valid: Date) {
    return { valid, zone: zoneOf(this.host.display().zone), now: new Date() };
  }

  /** Size and draw each slot's map at `k`, reusing (or making) `maps`; returns their canvases. */
  private drawMaps(maps: (MapView | null)[], k: number, layout: FrameLayout, frames: (SlotFrame | null)[]): (HTMLCanvasElement | null)[] {
    const labels = this.host.display().labels;
    return frames.map((f, i) => {
      if (!f) return null;
      const grid = f.product.manifest.grid;
      let map = maps[i];
      if (!map || map.gridId !== grid.id) {
        map = new MapView(null, document.createElement("canvas"), grid);
        maps[i] = map;
      }
      const region = regionById(f.spec.region)!;
      const m = layout.slots[i].map;
      map.configure(region.parent ? region.box : null, m.w / MAP_SCALE, m.h / MAP_SCALE, MAP_SCALE * k);
      map.setLabels(labels);
      map.draw(f.scene ?? { raster: null, layers: [] });
      return map.element;
    });
  }

  /** An "Edit" button over each slot's corner, where hovering shows it. */
  private placeSlotButtons(): void {
    const layout = this.layout!;
    const n = layout.slots.length;
    while (this.overlay.children.length > n) this.overlay.lastElementChild!.remove();
    while (this.overlay.children.length < n) {
      const i = this.overlay.children.length;
      const b = el("button", { type: "button", className: "slot-edit", textContent: `Edit ${i + 1}` });
      b.addEventListener("click", () => this.openEditor(i));
      this.overlay.appendChild(b);
    }
    layout.slots.forEach((box, i) => {
      const b = this.overlay.children[i] as HTMLElement;
      b.style.left = `${((box.map.x + box.map.w) / layout.w) * 100}%`;
      b.style.top = `${(box.map.y / layout.h) * 100}%`;
      b.setAttribute("aria-label", `Edit slot ${i + 1}`);
    });
  }

  // ---------------------------------------------------------------- export

  /** Render the whole frame offscreen at `k` (1: 1920 × 1080; 2: 4K). */
  renderOffscreen(k: number): HTMLCanvasElement {
    const { w, h } = frameSize(this.sil!.frame);
    const out = document.createElement("canvas");
    out.width = w * k;
    out.height = h * k;
    this.renderTo(out, k, this.sil!, this.slots, this.frames, new Array(this.frames.length).fill(null), this.valid);
    return out;
  }

  /** Draw `frames` of `slots` at `valid` onto `out` at `k`, with offscreen `maps` (reused between calls). */
  private renderTo(out: HTMLCanvasElement, k: number, sil: Silhouette, slots: ViewState[], frames: (SlotFrame | null)[], maps: (MapView | null)[], valid: Date): void {
    const layout = layoutFrame(sil, this.bars(slots));
    const canvases = this.drawMaps(maps, k, layout, frames);
    drawFrame(out.getContext("2d")!, k, layout, frames, canvases, this.frameText(valid), { empty: "This slot couldn't be loaded" });
  }

  private fileName(ext: string, frames = this.frames, valid = this.valid): string {
    const fields = [...new Set(frames.map((f) => f?.field ?? ""))].filter(Boolean);
    const what = (fields.length === 1 ? fields[0] : "models").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `runtorunwx-${what}-${runId(valid)}z.${ext}`;
  }

  /**
   * The loop as an MP4: each frame rendered offscreen at 1080p, then encoded
   * as H.264 at a constant 30 fps (each map held for its share of a second at
   * the loop's speed, the last one 1.5 s longer). Faster than real time, and
   * the same however slowly frames load. The layout, slots, loop and speed
   * are taken when it starts, so changes made meanwhile don't reach the file.
   * Pressing MP4 again (or leaving) stops it. The muxer loads only now.
   */
  private async exportMp4(): Promise<void> {
    const b = this.controls.querySelector<HTMLButtonElement>("#pc-mp4")!;
    if (this.exporting !== null) {
      this.exportGen++; // the export below sees it and stops
      b.textContent = "Stopping…";
      return;
    }
    const gen = ++this.exportGen;
    const live = () => gen === this.exportGen;
    this.stopPlay();
    this.exporting = gen;
    b.setAttribute("aria-pressed", "true");
    const sil = this.sil!, slots = this.slots.map((sl) => ({ ...sl })), axis = this.axis;
    const loop = clip(axis, this.loopSpan()) ?? axis;
    const d = this.host.display();
    let writer: Awaited<ReturnType<typeof import("./mp4").mp4Writer>> | null = null;
    try {
      const { mp4Writer } = await import("./mp4");
      const { w, h } = frameSize(sil.frame);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      writer = await mp4Writer(canvas, MP4_FPS);
      const times: Date[] = [];
      for (let t = loop.start; t <= loop.end; t = addHours(t, axis.step)) times.push(t);
      const maps: (MapView | null)[] = new Array(slots.length).fill(null);
      const memos = slots.map(() => new Map<string, unknown>());
      const ctx = (j: number) => ({ products: this.host.products, zone: zoneOf(d.zone), units: d.units, now: new Date(), memo: memos[j] });
      let out = 0; // output frames written
      let first: (SlotFrame | null)[] = [];
      for (let i = 0; i < times.length && live(); i++) {
        b.textContent = `MP4 ${i + 1}/${times.length} (stop)`;
        const frames = await Promise.all(slots.map((sl, j) => loadSlot(sl, times[i], ctx(j)).catch(() => null)));
        if (!live()) break;
        if (!i) first = frames;
        this.renderTo(canvas, 1, sil, slots, frames, maps, times[i]);
        const until = Math.round(((i + 1) * MP4_FPS) / d.fps) + (i === times.length - 1 ? Math.round((LOOP_HOLD_MS / 1000) * MP4_FPS) : 0);
        await writer.add(until - out);
        out = until;
      }
      if (!live()) {
        await writer.cancel();
        return;
      }
      download(await writer.finish(), this.fileName("mp4", first, loop.start));
      writer = null;
    } catch (err) {
      b.title = `MP4 export failed: ${err instanceof Error ? err.message : String(err)}`;
      await writer?.cancel().catch(() => {});
    } finally {
      this.exporting = null;
      b.textContent = "MP4";
      b.setAttribute("aria-pressed", "false");
    }
  }

  /** Hide the MP4 button where the browser can't encode H.264 at the frame's size (asked of WebCodecs, without loading the muxer). */
  private async checkMp4(): Promise<void> {
    const b = this.controls.querySelector<HTMLButtonElement>("#pc-mp4")!;
    b.hidden = true;
    if (typeof VideoEncoder === "undefined" || !this.sil) return;
    const { w, h } = frameSize(this.sil.frame);
    try {
      // H.264 High profile, level 4.2: enough for 1080 × 1920 at 30 fps
      const r = await VideoEncoder.isConfigSupported({ codec: "avc1.64002a", width: w, height: h, framerate: MP4_FPS });
      b.hidden = !r.supported;
    } catch {
      b.hidden = true;
    }
  }

  private async exportPng(scale: number): Promise<void> {
    await this.lastRender;
    const canvas = this.renderOffscreen(scale);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (blob) download(blob, this.fileName("png"));
  }

  // ---------------------------------------------------------------- picker

  private buildPicker(): void {
    const group = (frame: "16:9" | "9:16", title: string) => {
      const row = el("div", { className: "picker-row" });
      for (const s of SILHOUETTES.filter((x) => x.frame === frame)) {
        const shape = el("span", { className: `sil sil-${frame === "16:9" ? "wide" : "tall"}` });
        shape.style.gridTemplateColumns = `repeat(${s.cols}, 1fr)`;
        shape.style.gridTemplateRows = `repeat(${s.rows}, 1fr)`;
        for (let i = 0; i < slotCount(s); i++) shape.appendChild(el("span", { className: "sil-slot" }));
        const b = el("button", { type: "button", className: "picker-btn" }, shape, el("span", { className: "picker-label", textContent: s.label }));
        b.dataset.silhouette = s.id;
        b.addEventListener("click", () => {
          void this.root.requestFullscreen?.().catch(() => {});
          this.begin(s, this.sil ? this.valid : this.host.seed().valid);
        });
        row.appendChild(b);
      }
      return el("section", {}, el("h3", { textContent: title }), row);
    };
    const saved = this.lastSaved();
    const resume = saved && el("button", { type: "button", className: "text-btn picker-resume", textContent: `Resume last layout (${silhouetteById(saved.silhouette)!.label}, ${silhouetteById(saved.silhouette)!.frame})` });
    resume?.addEventListener("click", () => {
      void this.root.requestFullscreen?.().catch(() => {});
      this.restore(saved!, null);
    });
    const cancel = el("button", { type: "button", className: "text-btn", textContent: "Cancel" });
    cancel.addEventListener("click", () => (this.sil ? (this.picker.hidden = true, this.paint()) : this.close()));
    this.picker.replaceChildren(
      el("div", { className: "picker-card", role: "dialog", ariaLabel: "Choose a layout" },
        el("h2", { textContent: "Presentation mode: choose a layout" }),
        el("p", { className: "picker-hint", textContent: "Full screen, titles drawn on the frame, every map at the same time. Fill each slot after." }),
        group("16:9", "Landscape 16:9 (YouTube, streams)"),
        group("9:16", "Vertical 9:16 (Shorts, Reels, TikTok)"),
        el("div", { className: "picker-actions" }, ...(resume ? [resume] : []), cancel),
      ),
    );
  }

  // ---------------------------------------------------------------- slot editor

  private openEditor(i: number): void {
    this.editing = i;
    this.buildEditor();
    this.editor.hidden = false;
    this.root.classList.add("editing");
    this.paint();
    this.editor.querySelector<HTMLElement>("select")?.focus();
  }

  private closeEditor(): void {
    if (this.editing === null) return;
    this.editing = null;
    this.editor.hidden = true;
    this.root.classList.remove("editing");
    this.paint();
  }

  private setSlot(i: number, next: ViewState): void {
    if (i >= this.slots.length) return;
    this.slots[i] = this.withPartner(next);
    this.computeAxis();
    this.valid = this.onAxis(this.valid);
    this.syncControls();
    this.resetPreload();
    this.buildEditor();
    this.update();
  }

  /** Models a difference slot can subtract: usable for its field and region, on its grid. */
  private partners(s: ViewState): string[] {
    const grid = productById(s.product)!.grid;
    return this.usableModels(s).filter((m) => m !== s.product && productById(m)!.grid === grid);
  }

  /** A difference slot keeps a partner that can show its field, picking another if needed (as the site does). */
  private withPartner(s: ViewState): ViewState {
    if (s.mode !== "compare") return s;
    const ok = this.partners(s);
    if (s.compare && ok.includes(s.compare)) return s;
    return ok.length ? { ...s, compare: ok[0], compareRun: "latest" } : { ...s, mode: "fcst", compare: null };
  }

  private buildEditor(): void {
    const i = this.editing;
    if (i === null) return;
    const s = this.slots[i];
    const p = this.host.products.get(s.product)!;
    const view = viewById(s.view);
    const item = fieldItem(s.view, s.variable);
    const select = (label: string, options: { value: string; label: string; group?: string }[], value: string, onChange: (v: string) => void) => {
      const sel = el("select");
      let og: HTMLOptGroupElement | null = null;
      for (const o of options) {
        const opt = new Option(o.label, o.value);
        if (o.group) {
          if (!og || og.label !== o.group) sel.appendChild((og = el("optgroup", { label: o.group })));
          og.appendChild(opt);
        } else sel.appendChild(opt);
      }
      sel.value = value;
      sel.addEventListener("change", () => onChange(sel.value));
      return el("label", { className: "ed-field" }, el("span", { textContent: label }), sel);
    };

    const models = this.usableModels(s);
    const fields = FIELD_ITEMS.filter((it) => config.products.some((c) => this.usable(c.id, it, regionById(s.region)!)));
    const modes = [
      { value: "fcst", label: "Forecast" },
      ...(view.modes.includes("trend") ? [{ value: "trend", label: "Trend (vs an older run)" }] : []),
      ...(models.some((m) => m !== s.product && productById(m)!.grid === p.cfg.grid) ? [{ value: "compare", label: "Difference (minus another model)" }] : []),
    ];
    const regions = config.regions.map((r) => ({
      value: r.id,
      label: r.state ? r.label : `${"  ".repeat(Math.max(0, regionDepth(r) - 1))}${r.label}`,
      group: r.state ? "States" : "Regions",
    }));

    const parts: HTMLElement[] = [
      select("Model", models.map((id) => ({ value: id, label: productById(id)!.name })), s.product, (v) => this.setSlot(i, this.withProduct(s, v))),
      select("Field", fields.map((it) => ({ value: it.id, label: `${it.label} (${it.sub})` })), item.id, (v) => {
        const it = FIELD_ITEMS.find((x) => x.id === v)!;
        const nv = viewById(it.view);
        let next: ViewState = { ...s, view: it.view, variable: it.variable || nv.variables?.[0].id || "", overlays: defaultOverlays(nv) };
        if (next.mode === "trend" && !nv.modes.includes("trend")) next.mode = "fcst";
        if (!this.usable(next.product, it, regionById(next.region)!)) {
          const group = productById(next.product)!.group;
          const ok = this.usableModels(next);
          const fallback = ok.find((m) => productById(m)!.group === group) ?? ok[0];
          if (fallback) next = this.withProduct(next, fallback);
        }
        this.setSlot(i, next);
      }),
    ];
    // Trends and differences of 500 mb are of heights, whatever the shading
    const shadings = view.id === "h500" && s.mode === "fcst" ? (view.variables ?? []).filter((v) => v.field in p.manifest.fields) : [];
    if (shadings.length > 1) {
      parts.push(select("Shading", shadings.map((v) => ({ value: v.id, label: v.label })), s.variable, (v) => this.setSlot(i, { ...s, variable: v })));
    }
    parts.push(select("Mode", modes, s.mode, (v) => {
      this.setSlot(i, { ...s, mode: v as ViewState["mode"] });
    }));
    if (s.mode === "trend") {
      parts.push(select("Compared with the run from", p.cfg.lags.map((l) => ({ value: String(l), label: `${l} h earlier` })), String(s.lag), (v) => this.setSlot(i, { ...s, lag: Number(v) })));
    }
    if (s.mode === "compare") {
      parts.push(select("Minus", this.partners(s).map((id) => ({ value: id, label: productById(id)!.name })), s.compare ?? "", (v) => {
        // A picked run belongs to the old partner; "latest" and "same" carry over
        this.setSlot(i, { ...s, compare: v, compareRun: ["latest", "same"].includes(s.compareRun) ? s.compareRun : "latest" });
      }));
      const other = s.compare ? this.host.products.get(s.compare) : null;
      parts.push(select("Its run", [
        { value: "latest", label: "Newest that reaches this time" },
        { value: "same", label: `Same cycle as ${p.cfg.name}` },
        ...(other?.manifest.runs ?? []).map((r) => ({ value: r.id, label: fmtTime(parseRunId(r.id)) })),
      ], s.compareRun, (v) => this.setSlot(i, { ...s, compareRun: v })));
    }
    parts.push(select("Run", [
      { value: "", label: `Newest (${fmtTime(parseRunId(p.manifest.latest!))})` },
      ...p.manifest.runs.slice(1).map((r) => ({ value: r.id, label: fmtTime(parseRunId(r.id)) })),
    ], s.run ?? "", (v) => this.setSlot(i, { ...s, run: v || null })));
    parts.push(select("Region", regions, s.region, (v) => {
      let next: ViewState = { ...s, region: v };
      if (!this.usable(next.product, item, regionById(v)!)) next = this.withProduct(next, this.usableModels(next)[0] ?? next.product);
      this.setSlot(i, next);
    }));
    parts.push(...this.viewOptions(i, s));

    const all = el("button", { type: "button", className: "text-btn", textContent: "Same field and region in every slot" });
    all.addEventListener("click", () => {
      this.slots = this.slots.map((o, j) => {
        if (j === i) return o;
        let next: ViewState = { ...o, view: s.view, variable: s.variable, overlays: [...s.overlays], region: s.region, mode: o.mode === "compare" ? "fcst" : o.mode };
        if (next.mode === "trend" && !view.modes.includes("trend")) next.mode = "fcst";
        if (!this.usable(next.product, item, regionById(s.region)!)) next = this.withProduct(next, this.usableModels(next)[0] ?? next.product);
        return this.withProduct(next, next.product);
      });
      this.setSlot(i, s);
    });
    const done = el("button", { type: "button", className: "text-btn ed-done", textContent: "Done" });
    done.addEventListener("click", () => this.closeEditor());
    const head = el("div", { className: "ed-head" }, el("strong", { textContent: `Slot ${i + 1}` }), el("span", { className: "ed-run", textContent: `${p.cfg.name} ${runName(slotRun(s, p))} run` }));
    this.editor.replaceChildren(head, ...parts, el("div", { className: "ed-actions" }, all, done));
  }

  /** The view's own options for a slot: overlays, jet isotachs, and the trend or difference scale. */
  private viewOptions(i: number, s: ViewState): HTMLElement[] {
    const view = viewById(s.view);
    const vm = viewModeOf({ ...s, compareView: "diff" });
    const out: HTMLElement[] = [];
    const group = (label: string, kids: HTMLElement[]) => el("div", { className: "ed-field" }, el("span", { textContent: label }), el("div", { className: "ed-checks" }, ...kids));
    const check = (label: string, on: boolean, toggle: (on: boolean) => void) => {
      const input = el("input", { type: "checkbox", checked: on });
      input.addEventListener("change", () => toggle(input.checked));
      return el("label", { className: "check" }, input, label);
    };
    const overlays = view.overlays.filter((o) => !o.modes || o.modes.includes(vm));
    if (overlays.length) {
      out.push(group("Overlays", overlays.map((o) => check(o.label, s.overlays.includes(o.id), (on) => {
        const cur = new Set(s.overlays);
        if (on) cur.add(o.id);
        else cur.delete(o.id);
        this.setSlot(i, { ...s, overlays: view.overlays.map((x) => x.id).filter((id) => cur.has(id)) });
      }))));
    }
    if (view.id === "jet") {
      out.push(group("Isotachs (kt)", config.isotachOptions.map((v) => check(String(v), s.isotachs.includes(v), (on) => {
        const cur = new Set(s.isotachs);
        if (on) cur.add(v);
        else cur.delete(v);
        this.setSlot(i, { ...s, isotachs: [...cur].sort((a, b) => a - b) });
      }))));
    }
    if (vm === "trend") {
      const sel = el("select");
      sel.append(new Option("Fixed (same every frame)", "fixed"), new Option("Auto (fits each frame)", "auto"));
      sel.value = s.limitMode;
      sel.addEventListener("change", () => this.setSlot(i, { ...s, limitMode: sel.value as ViewState["limitMode"] }));
      out.push(el("label", { className: "ed-field" }, el("span", { textContent: "Color scale" }), sel));
    }
    return out;
  }

  // ---------------------------------------------------------------- controls

  private buildControls(): void {
    const btn = (id: string, text: string, title: string, onClick: () => void) => {
      const b = el("button", { type: "button", className: "pc-btn", id, textContent: text, title });
      b.addEventListener("click", onClick);
      return b;
    };
    const scrub = el("input", { type: "range", id: "pc-scrub", className: "pc-scrub" });
    scrub.setAttribute("aria-label", "Valid time");
    scrub.addEventListener("input", () => this.setValid(addHours(this.axis.start, Number(scrub.value))));
    const loop = el("select", { id: "pc-loop", className: "pc-select" });
    loop.append(new Option("Loop: all", "all"), new Option("Loop: next 7 days", "week"));
    loop.addEventListener("change", () => {
      this.loop = loop.value as "all" | "week";
      this.resetPreload();
    });
    const fps = el("select", { id: "pc-fps", className: "pc-select", title: "Loop speed (also the MP4's)" });
    fps.append(...FPS_OPTIONS.map((n) => new Option(`${n} fps`, String(n))));
    fps.addEventListener("change", () => this.host.setFps(Number(fps.value)));
    const scaleSel = el("select", { id: "pc-png-scale", className: "pc-select" });
    scaleSel.append(new Option("1080p", "1"), new Option("4K", "2"));
    scaleSel.title = "PNG size";
    // A select keeps focus after a pick, and would take a clicker's keys: hand focus back
    for (const sel of [loop, fps, scaleSel]) sel.addEventListener("change", () => sel.blur());
    this.controls.append(
      btn("pc-layout", "Layout", "Choose another layout", () => this.openPicker()),
      btn("pc-prev", "◀", "Back 6 h (Shift: a day)", () => this.step(-1)),
      btn("pc-play", "Play", "Play the loop (Space)", () => this.togglePlay()),
      btn("pc-next", "▶", "Forward 6 h (Shift: a day)", () => this.step(1)),
      scrub,
      el("span", { className: "pc-time", id: "pc-time" }),
      loop,
      fps,
      btn("pc-preload", "Preload loop", "Fetch every frame the loop needs", () => void this.preloadLoop()),
      btn("pc-png", "PNG", "Save this frame as a PNG", () => void this.exportPng(Number(scaleSel.value))),
      scaleSel,
      btn("pc-mp4", "MP4", "Save the loop as an MP4 video (1080p, at the loop's speed)", () => void this.exportMp4()),
      btn("pc-guide", "Shorts guide", "Outline where Shorts draws its buttons (G)", () => {
        this.guide = !this.guide;
        this.syncControls();
        this.paint();
      }),
      btn("pc-full", "Full screen", "Full screen (F)", () => this.toggleFullscreen()),
      btn("pc-exit", "Exit", "Leave presentation mode (Esc)", () => this.close()),
    );
  }

  private syncControls(): void {
    if (!this.sil) return;
    const guide = this.controls.querySelector<HTMLButtonElement>("#pc-guide")!;
    guide.hidden = this.sil.frame !== "9:16";
    guide.setAttribute("aria-pressed", String(this.guide));
    this.controls.querySelector<HTMLSelectElement>("#pc-fps")!.value = String(this.host.display().fps);
    this.syncFullscreenButton();
    this.syncTime();
  }

  private syncFullscreenButton(): void {
    this.controls.querySelector("#pc-full")?.setAttribute("aria-pressed", String(!!document.fullscreenElement));
  }

  private syncPlayButton(): void {
    const b = this.controls.querySelector<HTMLButtonElement>("#pc-play")!;
    b.textContent = this.playing ? "Pause" : "Play";
    b.setAttribute("aria-pressed", String(this.playing));
  }

  private syncTime(): void {
    if (!this.axis) return;
    const scrub = this.controls.querySelector<HTMLInputElement>("#pc-scrub")!;
    scrub.min = "0";
    scrub.max = String(hoursBetween(this.axis.start, this.axis.end));
    scrub.step = String(this.axis.step);
    scrub.value = String(hoursBetween(this.axis.start, this.valid));
    const zone = zoneOf(this.host.display().zone);
    this.controls.querySelector("#pc-time")!.textContent = fmtValid(this.valid, zone);
    scrub.setAttribute("aria-valuetext", fmtValid(this.valid, zone));
  }

  /** Every frame the loop needs, for every slot. */
  private loopJobs() {
    const jobs = new Map<string, () => Promise<unknown>>();
    const loop = clip(this.axis, this.loopSpan()) ?? this.axis;
    for (let t = loop.start; t <= loop.end; t = addHours(t, this.axis.step)) {
      for (const s of this.slots) {
        const p = this.host.products.get(s.product)!;
        const other = s.mode === "compare" && s.compare ? this.host.products.get(s.compare) ?? null : null;
        const init = parseRunId(slotRun(s, p));
        const f = hoursBetween(init, t);
        if (f < 0) continue;
        const plan = planFrame({ ...s, compareView: "diff" }, p, other, pairFor(init, f, s.lag));
        for (const [src, ids] of [[plan.cur, plan.needsCur], [plan.older, plan.needsOld]] as const) {
          if (!src) continue;
          for (const field of ids) {
            if (src.product.frames.missingReason(src.run, field, src.fhr)) continue;
            jobs.set(`${src.product.cfg.id}/${src.run}/${field}/${src.fhr}`, () => src.product.frames.get(src.run, field, src.fhr));
          }
        }
      }
    }
    return [...jobs.values()];
  }

  /** What the running or finished preload covers; a change of slots or loop resets it. */
  private preloadKey = "";

  private get preloadWanted(): string {
    return `${JSON.stringify(this.slots)}|${this.loop}`;
  }

  /** Reset "Preload loop" when the slots or loop range change (not when the time does). */
  private resetPreload(): void {
    if (this.preloadKey === this.preloadWanted) return;
    this.preloadKey = "";
    this.preloadGen++;
    const b = this.controls.querySelector<HTMLButtonElement>("#pc-preload");
    if (b) {
      b.textContent = "Preload loop";
      b.disabled = false;
      delete b.dataset.state;
    }
  }

  private async preloadLoop(): Promise<void> {
    const gen = ++this.preloadGen;
    this.preloadKey = this.preloadWanted;
    const b = this.controls.querySelector<HTMLButtonElement>("#pc-preload")!;
    const jobs = this.loopJobs();
    let done = 0;
    b.disabled = true;
    b.dataset.state = "loading";
    b.textContent = `Preloading 0/${jobs.length}`;
    const queue = [...jobs];
    const worker = async () => {
      while (queue.length && gen === this.preloadGen) {
        await queue.shift()!().catch(() => {});
        done++;
        if (gen === this.preloadGen) b.textContent = `Preloading ${done}/${jobs.length}`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (gen !== this.preloadGen) return;
    b.textContent = `Loop preloaded (${jobs.length})`;
    b.disabled = false;
    b.dataset.state = "done";
  }

  // ---------------------------------------------------------------- input

  /** Controls and Edit buttons show while the mouse moves, and hide (with the cursor) 2 s after. */
  private wake(): void {
    this.root.classList.remove("idle");
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      // A clicked button keeps focus; only keyboard focus (focus-visible) keeps the controls up
      if (this.editing === null && this.picker.hidden && !this.controls.matches(":hover") && !this.controls.querySelector(":focus-visible")) {
        this.root.classList.add("idle");
      }
    }, IDLE_MS);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    // The site underneath never sees keys while presenting
    e.stopPropagation();
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      if (this.editing !== null) this.closeEditor();
      else if (!this.picker.hidden && this.sil) {
        this.picker.hidden = true;
        this.paint();
      } else this.close();
      e.preventDefault();
      return;
    }
    if (!this.picker.hidden || !this.sil) return;
    const day = 24;
    // A presentation clicker's Back and Next step a day wherever focus is (M5's rundowns take these later)
    if (e.key === "PageUp" || e.key === "PageDown") {
      this.step(e.key === "PageUp" ? -1 : 1, day);
      e.preventDefault();
      return;
    }
    if (["SELECT", "TEXTAREA"].includes(target.tagName) || (target.tagName === "INPUT" && target.id !== "pc-scrub")) return;
    switch (e.key) {
      case "ArrowLeft":
        if (target.id === "pc-scrub" && !e.shiftKey) return;
        this.step(-1, e.shiftKey ? day : undefined);
        break;
      case "ArrowRight":
        if (target.id === "pc-scrub" && !e.shiftKey) return;
        this.step(1, e.shiftKey ? day : undefined);
        break;
      case "Home":
        this.setValid(this.loopSpan().start);
        break;
      case "End":
        this.setValid(this.loopSpan().end);
        break;
      case " ":
        if (target.tagName === "BUTTON") return;
        this.togglePlay();
        break;
      case "g":
      case "G":
        if (this.sil.frame !== "9:16") return;
        this.guide = !this.guide;
        this.syncControls();
        this.paint();
        break;
      case "f":
      case "F":
        this.toggleFullscreen();
        break;
      case "p":
      case "P":
        this.close();
        break;
      default: {
        const n = Number(e.key);
        if (n >= 1 && n <= this.slots.length) this.openEditor(n - 1);
        else return;
      }
    }
    e.preventDefault();
  }
}

function zoneOf(id: string): Zone {
  return zoneById(id) ?? UTC_ZONE;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
