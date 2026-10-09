import "./styles.css";
import { config } from "./config";
import { loadManifest } from "./manifest";
import { FrameCache, FrameUnavailable } from "./frames";
import { pairFor, type FramePair } from "./alignment";
import { autoLimit, computeDelta } from "./delta";
import { isotachLines, smoothForContours, type IsoLine } from "./isotachs";
import { MapView, type Scene } from "./mapview";
import { renderColorbar, fmtSigned } from "./colorbar";
import { parseState, serializeState, type ViewState } from "./state";
import { fhrLabel, fmtShort, fmtStamp, fmtTime, parseRunId } from "./time";
import { nearestGridPoint } from "./projection";
import type { Frame, Manifest } from "./types";

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
  pair: FramePair;
  current: Frame | null;
  older: Frame | null;
  delta: Int16Array | null;
}

class App {
  private state: ViewState;
  private frames: FrameCache;
  private map: MapView;
  private isoCache = new Map<string, IsoLine[]>();
  private smoothCache = new WeakMap<Frame, Float32Array>();
  private token = 0;
  private rendered: Rendered | null = null;
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
    this.buildControls();
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

  // ---------------------------------------------------------------- controls

  private buildControls(): void {
    const runSel = $<HTMLSelectElement>("run");
    runSel.replaceChildren(
      ...this.manifest.runs.map((r, i) => {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = `${fmtTime(parseRunId(r.id))}${i === 0 ? "  (latest)" : ""}${r.complete ? "" : "  (partial)"}`;
        return o;
      }),
    );

    segmented($("lag"), config.lags.map((l) => ({ value: String(l), label: `${l} h` })));
    segmented($("lim"), [
      { value: "fixed", label: `±${config.colorbar.defaultLimit} kt` },
      { value: "auto", label: "Auto" },
    ]);

    const iso = $("iso");
    iso.replaceChildren(
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

  private bindEvents(): void {
    $<HTMLSelectElement>("run").addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.set({ run: v === this.manifest.latest ? null : v });
    });
    $("lag").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) this.set({ lag: Number(b.dataset.value) });
    });
    $("lim").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) this.set({ limitMode: b.dataset.value as ViewState["limitMode"] });
    });
    $("iso").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const v = Number(b.dataset.value);
      const cur = new Set(this.state.isotachs);
      if (cur.has(v)) cur.delete(v);
      else cur.add(v);
      this.set({ isotachs: [...cur].sort((a, b) => a - b) });
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
      if (e.key === "ArrowLeft") this.step(-1);
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
    $<HTMLSelectElement>("run").value = this.run;
    setPressed($("lag"), String(s.lag));
    setPressed($("lim"), s.limitMode);
    for (const b of $("iso").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(s.isotachs.includes(Number(b.dataset.value))));
    }
    $<HTMLInputElement>("fhr").value = String(s.fhr);
    $<HTMLButtonElement>("prev").disabled = s.fhr <= config.fhr.min;
    $<HTMLButtonElement>("next").disabled = s.fhr >= config.fhr.max;

    const pair = pairFor(parseRunId(this.run), s.fhr, s.lag);
    $("title").textContent =
      `${config.modelName} ${config.levelLabel} |V| trend: init ${fmtTime(pair.currentInit)} vs ` +
      `${fmtTime(pair.olderInit)} | valid ${fmtTime(pair.valid)} | ${fhrLabel(s.fhr)}`;
    $("fhr-readout").innerHTML =
      `<strong>${fhrLabel(s.fhr)}</strong><span>${fmtShort(pair.valid)}</span>`;
    $("lag-hint").textContent = `${fmtTime(pair.olderInit)} at ${fhrLabel(pair.olderFhr)}`;

    const url = serializeState({ ...s, run: this.run });
    if (url !== location.search) history.replaceState(null, "", url);
    void this.render(pair);
  }

  // ---------------------------------------------------------------- render

  private async render(pair: FramePair): Promise<void> {
    const token = ++this.token;
    const spinner = $("spinner");
    const spinTimer = window.setTimeout(() => (spinner.hidden = false), 120);
    const [cur, old] = await Promise.allSettled([
      this.frames.get(pair.currentRun, pair.currentFhr),
      this.frames.get(pair.olderRun, pair.olderFhr),
    ]);
    window.clearTimeout(spinTimer);
    if (token !== this.token) return;
    spinner.hidden = true;

    const current = cur.status === "fulfilled" ? cur.value : null;
    const older = old.status === "fulfilled" ? old.value : null;
    const delta = current && older ? computeDelta(current, older) : null;
    this.rendered = { pair, current, older, delta };

    let banner: Notice | null = this.notice;
    if (!current) {
      banner = {
        text: `Frame unavailable: ${fmtTime(pair.currentInit)} ${fhrLabel(pair.currentFhr)} (${reason(cur)}).`,
        clearOn: "any",
      };
    } else if (!older) {
      banner = {
        text:
          `Comparison unavailable: needs the ${fmtTime(pair.olderInit)} run at ${fhrLabel(pair.olderFhr)} ` +
          `(${reason(old)}).`,
        clearOn: "any",
      };
    }
    this.drawScene();
    showBanner(banner, !!delta);
    if (this.pointer) this.hover(this.pointer);
    this.preload(pair);

    const appEl = $("app");
    appEl.dataset.state = "ready";
    appEl.dataset.frame = delta ? "delta" : current ? "no-comparison" : "no-frame";
    window.__wxtrend!.renders++;
  }

  private redraw(): void {
    if (this.rendered) this.drawScene();
  }

  private drawScene(): void {
    const r = this.rendered!;
    const s = this.state;
    const limit = r.delta && s.limitMode === "auto"
      ? autoLimit(r.delta, config.colorbar.autoRound)
      : config.colorbar.defaultLimit;
    const isotachs = r.current ? this.isotachsFor(r.pair.currentRun, r.pair.currentFhr, r.current) : [];
    const scene: Scene = { delta: r.delta, limit, isotachs };
    this.map.draw(scene);

    renderColorbar($("colorbar"), limit, { auto: s.limitMode === "auto", disabled: !r.delta });
    $("cb-caption").innerHTML = r.delta
      ? `Δ|V| (kt) · ${fmtTime(r.pair.currentInit)} minus ${fmtTime(r.pair.olderInit)} · ` +
        `${s.limitMode === "auto" ? "auto scale" : "fixed scale"}, values beyond ±${limit} kt clipped`
      : "Δ|V| (kt) · no comparison for this frame";
    this.renderStats(r);
    window.__wxtrend!.last = {
      run: r.pair.currentRun, fhr: r.pair.currentFhr, lag: s.lag, limit,
      hasDelta: !!r.delta, isotachLines: isotachs.length,
    };
  }

  private isotachsFor(run: string, fhr: number, frame: Frame): IsoLine[] {
    const out: IsoLine[] = [];
    for (const t of this.state.isotachs) {
      const key = `${run}/${fhr}/${t}`;
      let lines = this.isoCache.get(key);
      if (!lines) {
        let smooth = this.smoothCache.get(frame);
        if (!smooth) {
          smooth = smoothForContours(frame, this.manifest.grid.nx, this.manifest.grid.ny);
          this.smoothCache.set(frame, smooth);
        }
        lines = isotachLines(smooth, this.manifest.grid, [t]);
        this.isoCache.set(key, lines);
        if (this.isoCache.size > 400) this.isoCache.delete(this.isoCache.keys().next().value!);
      }
      out.push(...lines);
    }
    return out;
  }

  private renderStats(r: Rendered): void {
    const el = $("stats");
    if (!r.current) {
      el.innerHTML = "";
      return;
    }
    const g = this.manifest.grid;
    const maxAt = (arr: ArrayLike<number>, sign: 1 | -1) => {
      let best = -Infinity, at = 0;
      for (let i = 0; i < arr.length; i++) if (sign * arr[i] > best) { best = sign * arr[i]; at = i; }
      return { v: sign * best, lat: g.lat0 + Math.floor(at / g.nx) * g.dlat, lon: g.lon0 + (at % g.nx) * g.dlon };
    };
    const vmax = maxAt(r.current, 1);
    const rows = [`<div><span>Max |V|</span><b>${vmax.v} kt</b><em>${fmtLatLon(vmax.lat, vmax.lon)}</em></div>`];
    if (r.delta) {
      const up = maxAt(r.delta, 1), down = maxAt(r.delta, -1);
      rows.push(`<div><span>Largest gain</span><b class="pos">${fmtSigned(up.v)} kt</b><em>${fmtLatLon(up.lat, up.lon)}</em></div>`);
      rows.push(`<div><span>Largest loss</span><b class="neg">${fmtSigned(down.v)} kt</b><em>${fmtLatLon(down.lat, down.lon)}</em></div>`);
    }
    el.innerHTML = rows.join("");
  }

  /** Warm the cache for neighbouring hours of both runs so stepping is instant. */
  private preload(pair: FramePair): void {
    for (const d of [1, -1, 2, -2]) {
      const f = pair.currentFhr + d * config.fhr.step;
      if (f < config.fhr.min || f > config.fhr.max) continue;
      this.frames.preload(pair.currentRun, f);
      this.frames.preload(pair.olderRun, f + this.state.lag);
    }
  }

  // ---------------------------------------------------------------- hover

  private hover(e: { clientX: number; clientY: number }): void {
    this.pointer = { clientX: e.clientX, clientY: e.clientY };
    const tip = $("tooltip");
    const r = this.rendered;
    const wrap = $("map-wrap");
    const box = wrap.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const ll = r?.current ? this.map.invert(x, y) : null;
    const gp = ll ? nearestGridPoint(this.manifest.grid, ll[0], ll[1]) : null;
    if (!r || !ll || !gp || !this.map.inDomain(x, y)) {
      tip.hidden = true;
      return;
    }
    const k = gp.j * this.manifest.grid.nx + gp.i;
    const cur = r.current![k];
    const old = r.older ? r.older[k] : null;
    const d = r.delta ? r.delta[k] : null;
    tip.innerHTML =
      `<div class="tt-head">${fmtLatLon(ll[1], ll[0], 2)}</div>` +
      `<div><span>Current |V|</span><b>${cur} kt</b></div>` +
      `<div><span>Older |V|</span><b>${old ?? "—"}${old === null ? "" : " kt"}</b></div>` +
      `<div><span>Δ</span><b class="${d === null ? "" : d > 0 ? "pos" : d < 0 ? "neg" : ""}">${d === null ? "n/a" : fmtSigned(d) + " kt"}</b></div>` +
      `<div class="tt-foot">grid point ${fmtLatLon(gp.lat, gp.lon, 2)}</div>`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = x + 16 + tw > box.width ? x - 16 - tw : x + 16;
    const top = y + 16 + th > box.height ? y - 16 - th : y + 16;
    tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }
}

// ------------------------------------------------------------------ helpers

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

function reason(r: PromiseSettledResult<unknown>): string {
  if (r.status === "fulfilled") return "";
  const e = r.reason;
  if (e instanceof FrameUnavailable) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function fmtLatLon(lat: number, lon: number, digits = 1): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(digits)}°${ns} ${Math.abs(lon).toFixed(digits)}°${ew}`;
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
