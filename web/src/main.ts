import "./styles.css";
import { config } from "./config";
import { loadManifest } from "./manifest";
import { FrameCache, FrameUnavailable } from "./frames";
import { pairFor, type FramePair } from "./alignment";
import { MapView } from "./mapview";
import { renderColorbar } from "./colorbar";
import { parseState, serializeState, viewDefaults, type ViewPrefs, type ViewState } from "./state";
import { fhrLabel, fmtShort, fmtStamp, fmtTime, parseRunId } from "./time";
import { fmtLatLon } from "./views/util";
import { VIEWS, viewById } from "./views";
import type { Row, Scene, ViewDef, ViewId, ViewInputs } from "./views/types";
import type { Bands, Manifest } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

declare global {
  interface Window {
    __wxtrend?: { renders: number; last?: Record<string, unknown> };
  }
}

interface Notice {
  text: string;
  /** "run": stays until the run changes; "any": cleared by the next change. */
  clearOn: "run" | "any";
  action?: { label: string; onClick: () => void };
}

interface Rendered {
  view: ViewDef;
  pair: FramePair;
  cur: Record<string, Bands | null>;
  old: Record<string, Bands | null>;
  primary: string;
  frame: "delta" | "forecast" | "no-comparison" | "no-frame";
}

class App {
  private state: ViewState;
  private prefs = new Map<ViewId, ViewPrefs>();
  private frames: FrameCache;
  private map: MapView;
  private memo = new Map<string, unknown>();
  private token = 0;
  private rendered: Rendered | null = null;
  private scene: Scene | null = null;
  private notice: Notice | null = null;
  private pointer: { clientX: number; clientY: number } | null = null;

  constructor(private manifest: Manifest, dataBase: string) {
    this.frames = new FrameCache(manifest, dataBase);
    this.state = parseState(location.search);
    if (this.state.run === manifest.latest) {
      this.state.run = null;
    } else if (this.state.run && !manifest.runs.some((r) => r.id === this.state.run)) {
      this.notice = {
        text: `The ${fmtTime(parseRunId(this.state.run))} run from this link is no longer retained; showing the latest run.`,
        clearOn: "any",
      };
      this.state.run = null;
    } else if (this.state.run) {
      // A shared link pins its run; say so when something newer exists.
      this.notice = {
        text: `This link shows the ${fmtTime(parseRunId(this.state.run))} run. A newer run, ${fmtTime(parseRunId(manifest.latest!))}, is available.`,
        clearOn: "run",
        action: { label: "Show latest", onClick: () => this.set({ run: null }) },
      };
    }
    this.map = new MapView($("map-wrap"), $("map") as HTMLCanvasElement, manifest.grid);
    window.__wxtrend = { renders: 0 };
    this.buildStaticControls();
    this.bindEvents();
    new ResizeObserver(() => {
      if (this.map.resize()) this.redraw();
    }).observe($("map-wrap"));
    this.map.resize();
    this.update();
  }

  private get run(): string {
    return this.state.run ?? this.manifest.latest!;
  }

  private get view(): ViewDef {
    return viewById(this.state.view);
  }

  // ---------------------------------------------------------------- controls

  private buildStaticControls(): void {
    const tabs = $("tabs");
    tabs.replaceChildren(
      ...VIEWS.map((v, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tab";
        b.setAttribute("role", "tab");
        b.dataset.view = v.id;
        b.title = `${v.tab} (${i + 1})`;
        b.innerHTML = `<span class="tab-name">${v.tab}</span><span class="tab-sub">${v.tabSub}</span>`;
        return b;
      }),
    );

    $<HTMLSelectElement>("run").replaceChildren(
      ...this.manifest.runs.map((r, i) => {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = `${fmtTime(parseRunId(r.id))}${i === 0 ? "  (latest)" : ""}${r.complete ? "" : "  (partial)"}`;
        return o;
      }),
    );
    segmented($("lag"), config.lags.map((l) => ({ value: String(l), label: `${l} h` })));
    segmented($("mode"), [
      { value: "fcst", label: "Forecast" },
      { value: "trend", label: "Trend" },
    ]);

    $("iso").replaceChildren(
      ...config.isotachOptions.map((v) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = String(v);
        b.dataset.value = String(v);
        b.setAttribute("aria-pressed", "false");
        return b;
      }),
    );

    const slider = $<HTMLInputElement>("fhr");
    slider.min = String(config.fhr.min);
    slider.max = String(config.fhr.max);
    slider.step = String(config.fhr.step);
    const ticks = $("ticks");
    for (let f = config.fhr.min; f <= config.fhr.max; f += 24) {
      const t = document.createElement("span");
      t.textContent = String(f);
      t.style.left = `${((f - config.fhr.min) / (config.fhr.max - config.fhr.min)) * 100}%`;
      ticks.appendChild(t);
    }
  }

  /** Controls whose options depend on the view (variables, overlays, scale units). */
  private buildViewControls(): void {
    const v = this.view;
    const s = this.state;
    $("var-field").hidden = !v.variables;
    if (v.variables) segmented($("var"), v.variables.map((x) => ({ value: x.id, label: x.label })));
    $("mode-field").hidden = v.modes.length < 2;
    $("iso-field").hidden = v.id !== "jet";
    $("lag-field").hidden = s.mode !== "trend";
    $("lim-field").hidden = s.mode !== "trend";
    const vc = config.views[v.id];
    segmented($("lim"), [
      { value: "fixed", label: `±${vc.trendLimit} ${v.trendUnit}` },
      { value: "auto", label: "Auto" },
    ]);
    const overlays = v.overlays.filter((o) => !o.modes || o.modes.includes(s.mode));
    $("overlays-field").hidden = overlays.length === 0;
    $("overlays").replaceChildren(
      ...overlays.map((o) => {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = o.id;
        input.checked = s.overlays.includes(o.id);
        label.append(input, document.createTextNode(o.label));
        return label;
      }),
    );
    $("explain-view").innerHTML = v.explain(s.mode, s.variable);
  }

  private bindEvents(): void {
    $("tabs").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (b) this.switchView(b.dataset.view as ViewId);
    });
    $<HTMLSelectElement>("run").addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.set({ run: v === this.manifest.latest ? null : v });
    });
    const radio = (id: string, apply: (value: string) => void) =>
      $(id).addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (b) apply(b.dataset.value!);
      });
    radio("lag", (v) => this.set({ lag: Number(v) }));
    radio("lim", (v) => this.set({ limitMode: v as ViewState["limitMode"] }));
    radio("mode", (v) => this.set({ mode: v as ViewState["mode"] }));
    radio("var", (v) => this.set({ variable: v }));
    $("iso").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const v = Number(b.dataset.value);
      const cur = new Set(this.state.isotachs);
      if (cur.has(v)) cur.delete(v);
      else cur.add(v);
      this.set({ isotachs: [...cur].sort((a, b) => a - b) });
    });
    $("overlays").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const cur = new Set(this.state.overlays);
      if (input.checked) cur.add(input.value);
      else cur.delete(input.value);
      this.set({ overlays: this.view.overlays.map((o) => o.id).filter((id) => cur.has(id)) });
    });
    $<HTMLInputElement>("fhr").addEventListener("input", (e) => {
      this.set({ fhr: Number((e.target as HTMLInputElement).value) });
    });
    $("prev").addEventListener("click", () => this.step(-1));
    $("next").addEventListener("click", () => this.step(1));

    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // Form controls (including the slider) handle their own arrow keys.
      if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= VIEWS.length) this.switchView(VIEWS[n - 1].id);
      else if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else if (e.key === "Home") this.set({ fhr: config.fhr.min });
      else if (e.key === "End") this.set({ fhr: config.fhr.max });
      else return;
      e.preventDefault();
    });

    const wrap = $("map-wrap");
    wrap.addEventListener("pointermove", (e) => this.hover(e));
    wrap.addEventListener("pointerdown", (e) => this.hover(e));
    wrap.addEventListener("pointerleave", () => {
      this.pointer = null;
      $("tooltip").hidden = true;
    });
  }

  private switchView(id: ViewId): void {
    if (id === this.state.view) return;
    const s = this.state;
    this.prefs.set(s.view, { mode: s.mode, variable: s.variable, overlays: s.overlays });
    this.set({ view: id, ...(this.prefs.get(id) ?? viewDefaults(id)) });
  }

  private step(dir: number): void {
    const f = this.state.fhr + dir * config.fhr.step;
    if (f >= config.fhr.min && f <= config.fhr.max) this.set({ fhr: f });
  }

  private set(patch: Partial<ViewState>): void {
    if (this.notice && (this.notice.clearOn === "any" || "run" in patch)) this.notice = null;
    this.state = { ...this.state, ...patch };
    this.update();
  }

  /** Sync controls and URL to state, then render. */
  private update(): void {
    const s = this.state;
    const v = this.view;
    for (const b of $("tabs").querySelectorAll<HTMLButtonElement>("button")) {
      const on = b.dataset.view === s.view;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.buildViewControls();
    $<HTMLSelectElement>("run").value = this.run;
    setPressed($("lag"), String(s.lag));
    setPressed($("lim"), s.limitMode);
    setPressed($("mode"), s.mode);
    setPressed($("var"), s.variable);
    for (const b of $("iso").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(s.isotachs.includes(Number(b.dataset.value))));
    }
    $<HTMLInputElement>("fhr").value = String(s.fhr);
    $<HTMLButtonElement>("prev").disabled = s.fhr <= config.fhr.min;
    $<HTMLButtonElement>("next").disabled = s.fhr >= config.fhr.max;

    const pair = pairFor(parseRunId(this.run), s.fhr, s.lag);
    $("title").textContent = v.title(s.mode, s.variable, {
      model: config.modelName,
      init: fmtTime(pair.currentInit),
      older: fmtTime(pair.olderInit),
      valid: fmtTime(pair.valid),
      fhr: fhrLabel(s.fhr),
    });
    $("fhr-readout").innerHTML = `<strong>${fhrLabel(s.fhr)}</strong><span>${fmtShort(pair.valid)}</span>`;
    $("lag-hint").textContent = `${fmtTime(pair.olderInit)} at ${fhrLabel(pair.olderFhr)}`;
    document.title = `${v.tab} · GFS Trend Viewer`;

    const url = serializeState({ ...s, run: this.run });
    if (url !== location.search) history.replaceState(null, "", url);
    void this.render(pair);
  }

  // ---------------------------------------------------------------- render

  private async render(pair: FramePair): Promise<void> {
    const token = ++this.token;
    const s = this.state;
    const view = this.view;
    const needs = view.fields(s.mode, s.variable, new Set(s.overlays));
    const spinner = $("spinner");
    const spinTimer = window.setTimeout(() => (spinner.hidden = false), 120);
    const load = (run: string, fhr: number, ids: string[]) =>
      Promise.allSettled(ids.map((f) => this.frames.get(run, f, fhr)));
    const [curRes, oldRes] = await Promise.all([
      load(pair.currentRun, pair.currentFhr, needs.current),
      load(pair.olderRun, pair.olderFhr, needs.older),
    ]);
    window.clearTimeout(spinTimer);
    if (token !== this.token) return;
    spinner.hidden = true;

    const settle = (ids: string[], res: PromiseSettledResult<Bands>[]) =>
      Object.fromEntries(ids.map((f, i) => [f, res[i].status === "fulfilled" ? res[i].value : null]));
    const cur = settle(needs.current, curRes);
    const old = settle(needs.older, oldRes);
    const curFail = curRes[needs.current.indexOf(needs.primary)];
    const oldFail = s.mode === "trend" ? oldRes[needs.older.indexOf(needs.primary)] : undefined;

    let frame: Rendered["frame"] = s.mode === "trend" ? "delta" : "forecast";
    let banner: Notice | null = this.notice;
    if (!cur[needs.primary]) {
      frame = "no-frame";
      banner = {
        text: `Frame unavailable: ${fmtTime(pair.currentInit)} ${fhrLabel(pair.currentFhr)} (${reason(curFail)}).`,
        clearOn: "any",
      };
    } else if (s.mode === "trend" && !old[needs.primary]) {
      frame = "no-comparison";
      banner = {
        text:
          `Comparison unavailable: needs the ${fmtTime(pair.olderInit)} run at ${fhrLabel(pair.olderFhr)} ` +
          `(${reason(oldFail)}).`,
        clearOn: "any",
      };
    }
    this.rendered = { view, pair, cur, old, primary: needs.primary, frame };
    this.drawScene();
    showBanner(banner, frame === "delta" || frame === "forecast");
    if (this.pointer) this.hover(this.pointer);
    this.preload(pair, needs);

    const appEl = $("app");
    appEl.dataset.state = "ready";
    appEl.dataset.frame = frame;
    appEl.dataset.view = view.id;
    window.__wxtrend!.renders++;
  }

  private redraw(): void {
    if (this.rendered) this.drawScene();
  }

  private drawScene(): void {
    const r = this.rendered!;
    const s = this.state;
    const prefix = `${r.view.id}|${r.pair.currentRun}/${r.pair.currentFhr}|${r.pair.olderRun}/${r.pair.olderFhr}|`;
    const inputs: ViewInputs = {
      grid: this.manifest.grid,
      mode: s.mode,
      variable: s.variable,
      overlays: new Set(s.overlays),
      isotachs: s.isotachs,
      limitMode: s.limitMode,
      pair: r.pair,
      cur: r.cur,
      old: r.old,
      memo: <T,>(key: string, make: () => T): T => {
        const k = prefix + key;
        if (this.memo.has(k)) return this.memo.get(k) as T;
        const v = make();
        this.memo.set(k, v);
        if (this.memo.size > 300) this.memo.delete(this.memo.keys().next().value!);
        return v;
      },
    };
    if (r.frame === "no-frame") {
      this.scene = null;
      this.map.draw({ raster: null, layers: [] });
      $("colorbar").replaceChildren();
      $("cb-caption").textContent = "";
      $("stats").innerHTML = "";
    } else {
      const scene = r.view.scene(inputs);
      this.scene = scene;
      this.map.draw(scene);
      renderColorbar($("colorbar"), scene.colorbar);
      $("cb-caption").textContent = scene.caption;
      $("stats").innerHTML = scene.stats.map(statHtml).join("");
    }
    window.__wxtrend!.last = {
      view: r.view.id, mode: s.mode, variable: s.variable, run: r.pair.currentRun, fhr: r.pair.currentFhr,
      lag: s.lag, frame: r.frame, layers: this.scene?.layers.map((l) => l.kind) ?? [],
      colorbar: this.scene?.colorbar.kind ?? null,
    };
  }

  /** Warm the cache for neighbouring hours of both runs so stepping is instant. */
  private preload(pair: FramePair, needs: { current: string[]; older: string[] }): void {
    for (const d of [1, -1, 2, -2]) {
      const f = pair.currentFhr + d * config.fhr.step;
      if (f < config.fhr.min || f > config.fhr.max) continue;
      for (const id of needs.current) this.frames.preload(pair.currentRun, id, f);
      for (const id of needs.older) this.frames.preload(pair.olderRun, id, f + this.state.lag);
    }
  }

  // ---------------------------------------------------------------- hover

  private hover(e: { clientX: number; clientY: number }): void {
    this.pointer = { clientX: e.clientX, clientY: e.clientY };
    const tip = $("tooltip");
    const box = $("map-wrap").getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const at = this.scene ? this.map.sampleAt(x, y) : null;
    if (!at || !this.scene) {
      tip.hidden = true;
      return;
    }
    const g = this.manifest.grid;
    const gi = at.k % g.nx, gj = Math.floor(at.k / g.nx);
    const rows: Row[] = this.scene.readout(at.k);
    tip.innerHTML =
      `<div class="tt-head">${fmtLatLon(at.lat, at.lon, 2)}</div>` +
      rows.map((r) => `<div><span>${r.label}</span><b class="${r.cls ?? ""}">${r.value}</b></div>`).join("") +
      `<div class="tt-foot">grid point ${fmtLatLon(g.lat0 + gj * g.dlat, g.lon0 + gi * g.dlon, 2)}</div>`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = x + 16 + tw > box.width ? x - 16 - tw : x + 16;
    const top = y + 16 + th > box.height ? y - 16 - th : y + 16;
    tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }
}

// ------------------------------------------------------------------ helpers

function statHtml(r: Row): string {
  return `<div><span>${r.label}</span><b class="${r.cls ?? ""}">${r.value}</b>${r.sub ? `<em>${r.sub}</em>` : ""}</div>`;
}

function showBanner(notice: Notice | null, info: boolean): void {
  const b = $("banner");
  b.hidden = !notice;
  b.classList.toggle("info", !!notice && info);
  if (!notice) {
    b.replaceChildren();
    return;
  }
  const text = document.createElement("span");
  text.textContent = notice.text;
  b.replaceChildren(text);
  if (notice.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = notice.action.label;
    btn.addEventListener("click", notice.action.onClick);
    b.appendChild(btn);
  }
}

function reason(r: PromiseSettledResult<unknown> | undefined): string {
  if (!r || r.status === "fulfilled") return "not loaded";
  const e = r.reason;
  if (e instanceof FrameUnavailable) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function segmented(host: HTMLElement, options: { value: string; label: string }[]): void {
  host.replaceChildren(
    ...options.map((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.value = o.value;
      b.textContent = o.label;
      return b;
    }),
  );
}

function setPressed(host: HTMLElement, value: string): void {
  for (const b of host.querySelectorAll<HTMLButtonElement>("button")) {
    const on = b.dataset.value === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

async function main(): Promise<void> {
  const dataBase = new URL("data/", document.baseURI).toString();
  try {
    const manifest = await loadManifest(dataBase);
    if (!manifest.latest || manifest.runs.length === 0) {
      throw new Error("No processed runs yet. Run the pipeline (make data) and reload.");
    }
    $("updated").textContent = `Data updated ${fmtStamp(new Date(manifest.generated_at))}`;
    new App(manifest, dataBase);
  } catch (err) {
    const app = $("app");
    app.dataset.state = "error";
    $("title").textContent = "Could not load data";
    const b = $("banner");
    b.hidden = false;
    b.textContent = err instanceof Error ? err.message : String(err);
  }
}

void main();
