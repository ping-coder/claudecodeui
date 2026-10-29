/**
 * Keeps mixed-direction text readable in right-to-left interface languages.
 *
 * In a right-to-left paragraph the bidi algorithm moves the neutral characters
 * at the edge of Latin text and numbers: "/src/app.ts" shows as "src/app.ts/",
 * ".gitignore" as "gitignore.", "⌘K" as "K⌘", and an English sentence ends
 * with its full stop on the wrong side. An isolate keeps a run in its own order
 * and keeps it from mixing with the text around it.
 *
 * Only the languages i18next reports as rtl are touched; every other language
 * gets byte-identical strings.
 */
import type { i18n as I18n } from 'i18next';

import { stripBidiIsolates } from '@/shared/direction';

/** First Strong Isolate: the run takes the direction of its first strong letter, left-to-right when it has none. */
export const FSI = '\u2068';
/** Left-to-Right Isolate. */
export const LRI = '\u2066';
/** Pop Directional Isolate: closes an FSI, LRI or RLI. */
export const PDI = '\u2069';

const ISOLATE = /[\u2066-\u2069]/;

/**
 * A plain number stays bare. Its digits never reorder, and an isolate would cut
 * it off from the "%" or "/" a translation puts next to it: "{{percent}}%" would
 * show the sign on the wrong side and "{{done}}/{{count}}" in reverse.
 */
const PLAIN_NUMBER = /^\d+(?:[.,]\d+)*$/;

/** Wraps a value in FSI…PDI, unless it is empty or a plain number. */
export const isolateValue = (value: string): string =>
  value === '' || PLAIN_NUMBER.test(value) ? value : `${FSI}${value}${PDI}`;

type FormatFunction = (value: unknown, format: string | undefined, lng: string | undefined, options: object) => unknown;
type ResolvedOptions = { lng?: string; i18nResolved?: { res?: unknown; usedLng?: string } };

/**
 * Isolates every interpolated value, and every string that fell back to English,
 * while the interface language is right-to-left.
 *
 * Call it right after init, which must set interpolation.alwaysFormat (so every
 * {{value}} goes through the format function, not only the ones that name a
 * format), postProcess: ['bidiFallback'] and postProcessPassResolved (so the
 * post-processor learns which language a string came from).
 */
export function installBidiIsolation(i18n: I18n): void {
  const rtlByLanguage = new Map<string, boolean>();
  const isRtl = (lng: string | undefined): boolean => {
    const code = lng || i18n.language;
    if (!code) return false;
    let rtl = rtlByLanguage.get(code);
    if (rtl === undefined) {
      rtl = i18n.dir(code) === 'rtl';
      rtlByLanguage.set(code, rtl);
    }
    return rtl;
  };

  // The interpolator keeps the format function it was built with; the built-in
  // one only accepts calls that name a format, so it runs only for those.
  const interpolator = i18n.services.interpolator as unknown as { format: FormatFunction };
  const formatNamed = interpolator.format;
  interpolator.format = (value, format, lng, options) => {
    const rtl = isRtl(lng);
    // A list is isolated item by item, so its separators follow the sentence.
    const input = rtl && format && /(^|,)\s*list\b/i.test(format) && Array.isArray(value)
      ? value.map((item) => isolateValue(String(item)))
      : value;
    const output = format ? formatNamed(input, format, lng, options) : input;
    if (!rtl || output === undefined || output === null) return output;
    return isolateValue(String(output));
  };

  // A string that came from the English fallback (a key missing in this language,
  // or a defaultValue in the code) is English: isolate it left-to-right, so its
  // full stop stays at its end. Nested $t() results are not post-processed.
  i18n.use({
    type: 'postProcessor',
    name: 'bidiFallback',
    process(value: string, _key: string | string[], options: ResolvedOptions) {
      if (typeof value !== 'string' || value === '') return value;
      const lng = options.lng || i18n.language;
      if (!isRtl(lng)) return value;
      const resolved = options.i18nResolved;
      const fromFallback = !resolved || resolved.res === undefined || (resolved.usedLng !== undefined && !isRtl(resolved.usedLng));
      return fromFallback ? `${LRI}${value}${PDI}` : value;
    },
  });
}

/** Whether an element's own text shows and can be selected, given its parent's. */
type TextState = { selectable: boolean; shown: boolean };

const SHOWN: TextState = { selectable: true, shown: true };

/**
 * user-select: none passes to the children, which can switch it back on; "auto" follows the
 * parent (Firefox computes "auto" under a parent with none, jsdom does not inherit it at all).
 * Text in visibility: hidden is not painted, and the browser leaves it out of a copy too.
 */
function textStateOf(style: CSSStyleDeclaration, parent: TextState): TextState {
  const userSelect = style.userSelect || style.webkitUserSelect || 'auto';
  const selectable = userSelect === 'auto' ? parent.selectable : userSelect !== 'none';
  const { visibility } = style;
  return { selectable, shown: selectable && visibility !== 'hidden' && visibility !== 'collapse' };
}

/**
 * Whether an element is laid out with room to show what it holds. checkVisibility() sees
 * display: none and what a closed <details> keeps off screen, but calls display: contents hidden
 * although its children show. A collapsed section is a box with overflow hidden and no height
 * (a 0fr grid row); an image clips too, and one still loading has no size yet.
 */
function laidOut(element: Element, style: CSSStyleDeclaration): boolean {
  const { display } = style;
  if (display === 'contents') return true;
  if (display === 'none' || (typeof element.checkVisibility === 'function' && !element.checkVisibility())) return false;
  if (display === 'inline' || !element.hasChildNodes() || style.overflow === '' || style.overflow === 'visible') return true;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** A node and all its ancestors. */
function ancestry(node: Node): Set<Node> {
  const nodes = new Set<Node>();
  for (let at: Node | null = node; at; at = at.parentNode) nodes.add(at);
  return nodes;
}

/**
 * The selection as HTML, keeping only what the browser's own copy keeps. A range's
 * cloneContents() would also bring the script in a closed <details>, a collapsed tool output,
 * a hidden menu and the select-none gutter of a diff. Links and images get absolute URLs, as in
 * the browser's copy; inline styles (code highlighting) stay, the computed styles the browser
 * adds do not.
 */
function selectionHtml(selection: Selection, view: Window): string {
  const doc = view.document;
  const out = doc.createElement('div');
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const { startContainer, startOffset, endContainer, endOffset, commonAncestorContainer: root } = selection.getRangeAt(index);
    const startPath = ancestry(startContainer);
    const endPath = ancestry(endContainer);

    // Copies the part of `node` the range covers into `into`; true when something that shows was
    // copied. An element that shows is copied even when empty (an image, a line break); one that
    // does not, only around a child that shows (a selectable line in a select-none row).
    const copyNode = (into: Node, node: Node, parent: TextState): boolean => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!parent.shown) return false;
        const text = (node as Text).data;
        const part = text.slice(node === startContainer ? startOffset : 0, node === endContainer ? endOffset : text.length);
        if (part) into.appendChild(doc.createTextNode(part));
        return part !== '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const element = node as Element;
      const style = view.getComputedStyle(element);
      if (!laidOut(element, style)) return false;
      const state = textStateOf(style, parent);
      const clone = element.cloneNode(false) as Element;
      for (const name of ['href', 'src']) {
        const value = clone.getAttribute(name);
        try {
          if (value) clone.setAttribute(name, new URL(value, doc.baseURI).href);
        } catch {
          // Not a URL: left as written.
        }
      }
      const copied = copyChildren(clone, element, state) || state.shown;
      if (copied) into.appendChild(clone);
      return copied;
    };

    // Copies the children of `parent` the range covers, in one pass: the range starts at an offset
    // in `parent` or inside the child on the path to its start container, and ends likewise.
    // (Range.intersectsNode() on each child would count its siblings every time.)
    const copyChildren = (into: Node, parent: Node, state: TextState): boolean => {
      // A closed <details> shows only its summary.
      const summary = parent instanceof HTMLDetailsElement && !parent.open ? parent.querySelector(':scope > summary') : undefined;
      let started = !startPath.has(parent);
      let copied = false;
      let offset = 0;
      for (let child = parent.firstChild; child; child = child.nextSibling, offset += 1) {
        if (parent === endContainer && offset === endOffset) break;
        if ((parent === startContainer && offset === startOffset) || startPath.has(child)) started = true;
        if (started && (summary === undefined || child === summary)) copied = copyNode(into, child, state) || copied;
        if (endPath.has(child)) break;
      }
      return copied;
    };

    const rootElement = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : root.parentElement;
    const state = rootElement ? textStateOf(view.getComputedStyle(rootElement), SHOWN) : SHOWN;
    if (root.nodeType === Node.TEXT_NODE) copyNode(out, root, state);
    else copyChildren(out, root, state);
  }
  return out.innerHTML;
}

/**
 * Text taken by hand out of a right-to-left interface leaves its isolates behind: a command
 * selected in a hint ("Run claude login once in a terminal") would otherwise paste into a shell
 * as "\u2068claude: command not found". Covers a copy (text and HTML) and a drag (a selection,
 * a link or an image dropped elsewhere). Only LRI, RLI, FSI and PDI go, those in the user's or
 * the model's own text too.
 *
 * Left alone, since the text is the user's: a copy from an input or a textarea, and a drag from
 * those or from an editor. Also left alone: a copy a handler already took care of (the code
 * editor, the terminal). The copied text is the selection's, which unlike the browser's own copy
 * has no image alt text and keeps text-transform (an uppercase label comes out in capitals).
 * Not covered: a middle-click paste on Linux takes the primary selection, which no event lets
 * a page change.
 *
 * Returns the function that removes the listeners.
 */
export function installIsolateFreeCopy(i18n: I18n, doc: Document = document): () => void {
  const rightToLeft = () => i18n.dir(i18n.resolvedLanguage ?? i18n.language) === 'rtl';
  const onCopy = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (event.defaultPrevented || !clipboard || !rightToLeft()) return;
    const active = doc.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString();
    if (!ISOLATE.test(text)) return;
    clipboard.setData('text/plain', stripBidiIsolates(text));
    if (doc.defaultView) clipboard.setData('text/html', stripBidiIsolates(selectionHtml(selection, doc.defaultView)));
    event.preventDefault();
  };
  // The browser has filled the drag data by now, the HTML as its own copy would write it.
  const onDragStart = (event: DragEvent) => {
    const data = event.dataTransfer;
    if (event.defaultPrevented || !data || !rightToLeft()) return;
    const target = event.target as Node | null;
    const source = target?.nodeType === Node.ELEMENT_NODE ? (target as Element) : target?.parentElement;
    // A read-only CodeMirror view is contenteditable="false"; its own handler writes the file's text.
    if (source?.closest('input, textarea, [contenteditable]')) return;
    for (const type of ['text/plain', 'text/html']) {
      const value = data.getData(type);
      if (ISOLATE.test(value)) data.setData(type, stripBidiIsolates(value));
    }
  };
  doc.addEventListener('copy', onCopy);
  doc.addEventListener('dragstart', onDragStart);
  return () => {
    doc.removeEventListener('copy', onCopy);
    doc.removeEventListener('dragstart', onDragStart);
  };
}
