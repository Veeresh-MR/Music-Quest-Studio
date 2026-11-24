// Popup menus and a small text prompt.
import { h, modal } from '../util.js';

let open = null;

export function closeMenu() {
  if (!open) return;
  open.el.remove();
  open.onClose?.();
  open = null;
}

document.addEventListener('pointerdown', (e) => { if (open && !open.el.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

// items: [{label, kbd, run, danger, disabled} | {sep: true}]
export function showMenu(x, y, items, onClose) {
  closeMenu();
  const el = h('div', { class: 'menu-pop', role: 'menu' }, items.map((it) => (it.sep
    ? h('div', { class: 'menu-sep' })
    : h('button', {
      class: 'menu-item', role: 'menuitem', disabled: !!it.disabled,
      style: it.danger ? { color: 'var(--bad)' } : null,
      onclick: () => { closeMenu(); it.run?.(); },
    }, h('span', {}, it.label), it.kbd ? h('kbd', {}, it.kbd) : null))));
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  el.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  open = { el, onClose };
  el.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
}

export function contextMenu(e, items) {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, items);
}

export function promptText(title, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, style: { width: '100%' } });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({
      title,
      body: input,
      actions: [{ label: 'Cancel', run: () => finish(null) }, { label: 'OK', primary: true, run: () => finish(input.value.trim() || null) }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value.trim() || null); m.close(); } });
    const observer = new MutationObserver(() => { if (!document.body.contains(m.box)) { finish(null); observer.disconnect(); } });
    observer.observe(document.body, { childList: true });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
