type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined | null>;
type Child = Node | string | number | null | undefined | false | Child[];

/** Minimal hyperscript helper. `on*` attrs become listeners. */
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

export const fmt = {
  kg(kg: number) {
    if (Math.abs(kg) >= 1000) return `${(kg / 1000).toFixed(Math.abs(kg) >= 100000 ? 0 : Math.abs(kg) >= 10000 ? 1 : 2)} t`;
    return `${Math.round(kg)} kg`;
  },
  n(n: number) {
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)} MN`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)} kN`;
    return `${Math.round(n)} N`;
  },
  m(m: number, d = 2) {
    return `${m.toFixed(d)} m`;
  },
  pct(f: number) {
    return `${Math.round(f * 100)}%`;
  },
};

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function num(label: string, value: number, onChange: (v: number) => void, opts: { step?: number; min?: number; max?: number; unit?: string } = {}) {
  const input = h('input', {
    type: 'number', value: +value.toFixed(4), step: opts.step ?? 0.05, min: opts.min, max: opts.max,
    onchange: (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) onChange(v);
    },
  });
  return h('label', { class: 'field' }, h('span', {}, label), input, opts.unit ? h('em', {}, opts.unit) : null);
}
