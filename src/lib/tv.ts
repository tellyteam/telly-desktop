/**
 * Remote-control support for LG TVs: the arrow keys move focus to the nearest thing in that
 * direction, OK presses it, and the remote's Back, channel and media keys become the keys the
 * rest of telly already understands (Escape, PageUp/PageDown, space…).
 */

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** webOS remote key codes, as the keys the app already handles. */
const KEYS: Record<number, string> = {
  461: "Escape", // Back
  33: "PageUp", // Channel up
  34: "PageDown", // Channel down
  415: " ", // Play
  19: " ", // Pause
  412: "ArrowLeft", // Rewind
  417: "ArrowRight", // Fast forward
};

type Dir = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && !el.closest("[inert], [aria-hidden=true]");
}

/** The nearest focusable in [dir] from [from], preferring things in line with it. */
export function nearest(from: DOMRect, dir: Dir, candidates: HTMLElement[]): HTMLElement | undefined {
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best: HTMLElement | undefined, bestScore = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    let along: number, across: number;
    switch (dir) {
      case "ArrowRight": along = r.left - from.right; across = Math.abs(y - cy); if (x <= cx + 1) continue; break;
      case "ArrowLeft": along = from.left - r.right; across = Math.abs(y - cy); if (x >= cx - 1) continue; break;
      case "ArrowDown": along = r.top - from.bottom; across = Math.abs(x - cx); if (y <= cy + 1) continue; break;
      case "ArrowUp": along = from.top - r.bottom; across = Math.abs(x - cx); if (y >= cy - 1) continue; break;
    }
    // Overlapping in the cross direction (same row or column) counts as perfectly in line.
    const overlaps = dir === "ArrowLeft" || dir === "ArrowRight"
      ? r.bottom > from.top && r.top < from.bottom
      : r.right > from.left && r.left < from.right;
    const score = Math.max(0, along) + (overlaps ? 0 : across * 3) + (overlaps ? 0 : 1000);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/**
 * Everything the remote can land on. Buttons inside a card (the ♥) aren't separate stops on a TV:
 * the card is one stop, and My List is on its page.
 */
function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => el.classList.contains("card") || !el.closest(".card"))
    .filter(visible);
}

function focus(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

/** Puts focus on the first thing in [root] when nothing has it (a new screen opened). */
export function focusFirst(root: ParentNode = document) {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && visible(active) && document.contains(active)) return;
  const main = (root as Document).querySelector?.("main") ?? root;
  // A page's main action first (Play on a film), then the first thing in it.
  const primary = [...main.querySelectorAll<HTMLElement>("[data-autofocus], .btn.primary:not([disabled])")].find(visible);
  const first = primary ?? focusables(main)[0] ?? focusables(root)[0];
  if (first) first.focus({ preventScroll: true });
}

/**
 * Starts remote-control handling. [suspended] says when something else (the player) handles the
 * arrow keys itself.
 */
export function startTv(suspendedBase: () => boolean) {
  // The player handles its own keys, except while the remote is in its control bar or a menu.
  const suspended = () => suspendedBase() && !(document.activeElement as HTMLElement | null)?.closest?.(".ctrls, .menu, .back");
  document.documentElement.classList.add("tv");

  window.addEventListener("keydown", (e) => {
    const mapped = KEYS[e.keyCode];
    if (mapped && e.key !== mapped) {
      // Re-send as the key telly understands; the original stops here.
      e.preventDefault();
      e.stopImmediatePropagation();
      (e.target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: mapped, bubbles: true, cancelable: true }));
      return;
    }
    if (suspended()) return;
    const dir = e.key as Dir;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(dir)) {
      // OK on something that only reacts to clicks.
      if (e.key === "Enter") {
        const t = e.target as HTMLElement;
        if (t?.getAttribute?.("role") === "button" || (t?.tabIndex >= 0 && !(t instanceof HTMLButtonElement || t instanceof HTMLInputElement || t instanceof HTMLAnchorElement))) {
          e.preventDefault();
          t.click();
        }
      }
      return;
    }
    const target = e.target as HTMLElement;
    // In a text field, Left and Right move the cursor until it reaches the end; then they leave it.
    if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && (dir === "ArrowLeft" || dir === "ArrowRight")) {
      const atEdge = dir === "ArrowRight" ? target.selectionEnd === target.value.length : target.selectionStart === 0;
      if (!atEdge) return;
    }
    if (target instanceof HTMLSelectElement) return;
    const active = document.activeElement as HTMLElement | null;
    const from = active && active !== document.body ? active.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
    const scope = active?.closest<HTMLElement>("[data-focus-scope]") ?? document;
    const next = nearest(from, dir, focusables(scope).filter((el) => el !== active));
    e.preventDefault();
    if (next) focus(next);
  }, true);

  // The TV's on-screen keyboard covers the bottom half: keep the field being typed in above it.
  window.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
      setTimeout(() => t.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
    }
  });

  // A new screen (or its contents) appeared: make sure something has focus.
  new MutationObserver(() => {
    if (!suspended()) setTimeout(() => focusFirst());
  }).observe(document.body, { childList: true, subtree: true });
  // …and for the first screen, which may already be there.
  setTimeout(() => focusFirst());
}
