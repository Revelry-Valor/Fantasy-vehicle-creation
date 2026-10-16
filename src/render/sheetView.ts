import type { Analysis } from '../core/analysis';
import type { Store } from '../core/store';
import { PALETTES_DESK, PAPER_H, PAPER_W, renderSheet, sheetSettings } from './sheet';

/**
 * Shows the drafting sheet on screen: drag to pan, wheel to zoom, double-click
 * (or F) to fit. The sheet re-inks itself a moment after the design changes.
 */
export class SheetView {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sheet: HTMLCanvasElement | null = null;
  private dirty = true;
  private timer = 0;
  private cam = { x: 0, y: 0, scale: 1 };
  private fitted = false;
  visible = false;
  analysis: Analysis | null = null;
  /** Pixels per paper millimetre for the on-screen sheet. */
  detail = 6;
  onRendered?: (ms: number) => void;

  constructor(private container: HTMLElement, private store: Store) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sheet-view';
    this.canvas.hidden = true;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(container);
    this.bind();
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.canvas.hidden = !v;
    if (v) {
      this.resize();
      if (this.dirty || !this.sheet) this.rerender(0);
      else this.draw();
    }
  }

  invalidate() {
    this.dirty = true;
    if (this.visible) this.rerender(350);
  }

  private rerender(delay: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const t0 = performance.now();
      this.sheet = renderSheet(this.store.design, this.analysis, this.detail).canvas;
      this.dirty = false;
      if (!this.fitted) this.fit();
      this.draw();
      this.onRendered?.(performance.now() - t0);
    }, delay);
  }

  /** A full-resolution PNG of the sheet. */
  exportPNG(pxPerMm = 12): Promise<Blob | null> {
    const c = renderSheet(this.store.design, this.analysis, pxPerMm).canvas;
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
  }

  fit() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const s = Math.min((w - 40) / PAPER_W, (h - 40) / PAPER_H);
    this.cam = { scale: s, x: (w - PAPER_W * s) / 2, y: (h - PAPER_H * s) / 2 };
    this.fitted = true;
    this.draw();
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (!this.fitted) this.fit();
    this.draw();
  }

  private draw() {
    if (!this.visible) return;
    const g = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = sheetSettings(this.store.design).style;
    g.fillStyle = PALETTES_DESK[style];
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const { x, y, scale } = this.cam;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = 18;
    g.fillStyle = '#fff';
    g.fillRect(x, y, PAPER_W * scale, PAPER_H * scale);
    g.restore();
    if (this.sheet) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.sheet, x, y, PAPER_W * scale, PAPER_H * scale);
    }
    if (this.dirty && this.sheet) {
      g.fillStyle = 'rgba(20,24,30,0.7)';
      g.fillRect(10, 10, 92, 22);
      g.fillStyle = '#dfe6ee';
      g.font = '12px system-ui, sans-serif';
      g.fillText('Re-inking…', 20, 25);
    }
  }

  private bind() {
    let drag: { x: number; y: number; cx: number; cy: number } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.cam.x = drag.cx + e.clientX - drag.x;
      this.cam.y = drag.cy + e.clientY - drag.y;
      this.draw();
    });
    const end = () => { drag = null; this.canvas.style.cursor = ''; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('dblclick', () => this.fit());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const s = Math.min(40, Math.max(0.3, this.cam.scale * f));
      const k = s / this.cam.scale;
      this.cam.x = mx - (mx - this.cam.x) * k;
      this.cam.y = my - (my - this.cam.y) * k;
      this.cam.scale = s;
      this.draw();
    }, { passive: false });
  }

  zoomBy(f: number) {
    const w = this.canvas.clientWidth / 2, h = this.canvas.clientHeight / 2;
    const s = Math.min(40, Math.max(0.3, this.cam.scale * f));
    const k = s / this.cam.scale;
    this.cam.x = w - (w - this.cam.x) * k;
    this.cam.y = h - (h - this.cam.y) * k;
    this.cam.scale = s;
    this.draw();
  }
}
