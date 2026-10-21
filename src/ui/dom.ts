type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined | null>;
export type Child = Node | string | number | null | undefined | false | Child[];

/** Minimal hyperscript helper. `on*` attributes become listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = !!v;
    else if (k === 'selected' && 'selected' in el) (el as HTMLOptionElement).selected = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.split(':')[1].split(';')[0] });
}

/** A labelled number input. Commits on change (Enter or blur), not on every keystroke. */
export function numField(label: string, value: number, onChange: (v: number) => void, opts: { step?: number; min?: number; max?: number; unit?: string; title?: string } = {}) {
  return h('label', { class: 'field', title: opts.title },
    h('span', {}, label),
    h('input', {
      type: 'number', value: +value.toFixed(4), step: opts.step ?? 'any', min: opts.min, max: opts.max,
      onchange: (e) => { const x = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(x)) onChange(x); },
    }),
    opts.unit ? h('em', {}, opts.unit) : null);
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vehicle';
}

export function storageGet<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}

export function storageSet(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* blocked */ }
}
