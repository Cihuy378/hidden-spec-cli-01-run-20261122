// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (MIT). It reads unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and JSON tool calls (section 9), matches
// lines at three tiers with re-indentation (section 5), and writes every file or none (section 10). Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in patch order: each may print as one `R` line. */
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file split the way SPEC.md section 3 says: its own break, its lines, its final break. */
interface SplitFile {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line as one tier of SPEC.md section 5 sees it. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const trimmed = line.replace(/[ \t]+$/, '');
  if (tier === 1) return trimmed;
  return trimmed.replace(/^[ \t]+/, '');
}

/** Every position at or after `from` where `old` occurs in `lines` at one tier. */
function occurrences(lines: string[], old: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const hits: number[] = [];
  if (old.length === 0) return hits;
  const start = Math.max(0, from);
  for (let i = start; i + old.length <= lines.length; i += 1) {
    if (eofOnly && i + old.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (tierKey(lines[i + k]!, tier) !== tierKey(old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier at which `old` occurs at or after `from` (tier 0 only when strict). */
function firstTier(lines: string[], old: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; hits: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const hits = occurrences(lines, old, tier, from, eofOnly);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/** One line of a replacement: `ctx` is its index in O when it is a context line, else -1. */
interface NewItem {
  text: string;
  ctx: number;
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * The lines that replace a match at `at`: context lines are the file's own matched lines,
 * and at tier 2 every other non-blank line starting with O's first indent is re-indented
 * to the file's first matched line's indent (SPEC.md section 5). Only for a non-empty O.
 */
function buildReplacement(old: string[], next: NewItem[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const fileLead = leadingWs(fileLines[at]!);
  const oldLead = leadingWs(old[0]!);
  for (const item of next) {
    if (item.ctx >= 0) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    let line = item.text;
    if (tier === 2 && line.trim() !== '' && line.startsWith(oldLead)) line = fileLead + line.slice(oldLead.length);
    out.push(line);
  }
  return out;
}

/** The plain texts of replacement items, for an insertion with no match to re-indent from. */
function plainReplacement(next: NewItem[]): string[] {
  return next.map((item) => item.text);
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: where its old lines start, its O and N, and its `\` markers. */
interface UnifiedHunk {
  start: number;
  old: string[];
  next: NewItem[];
  noBreakAfterLast: boolean;
  noBreakAfterPlus: boolean;
}

/** One unified section, resolved to the paths its edit touches. */
interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: UnifiedHunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The `a/` and `b/` paths of a `diff --git` line, or null when it is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const parts = line.slice('diff --git '.length).split(' ');
  if (parts.length !== 2) return null;
  const a = parts[0]!;
  const b = parts[1]!;
  if (!a.startsWith('a/') || a.length < 3) return null;
  if (!b.startsWith('b/') || b.length < 3) return null;
  return [a.slice(2), b.slice(2)];
}

/** The path a `--- ` or `+++ ` line names (null for /dev/null), prefixes stripped. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** O, N and the `\` markers of one hunk body (trailing empty lines already stripped). */
function hunkBody(body: string[]): { old: string[]; next: NewItem[]; noBreakAfterLast: boolean; noBreakAfterPlus: boolean } {
  const old: string[] = [];
  const next: NewItem[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      old.push(text);
      next.push({ text, ctx: old.length - 1 });
    } else if (l.startsWith('-')) {
      old.push(l.slice(1));
    } else if (l.startsWith('+')) {
      next.push({ text: l.slice(1), ctx: -1 });
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let j = 0; j < body.length; j += 1) {
    const l = body[j]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = j;
    if (l.startsWith('+')) lastPlus = j;
  }
  const follows = (j: number): boolean => j >= 0 && j + 1 < body.length && body[j + 1]!.startsWith('\\');
  return { old, next, noBreakAfterLast: follows(lastCtxPlus), noBreakAfterPlus: follows(lastPlus) };
}

interface SectionDraft {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
  hunksStarted: boolean;
}

function freshDraft(): SectionDraft {
  return { pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined, gitOld: undefined, gitNew: undefined, newFile: false, deletedFile: false, hunks: [], hunksStarted: false };
}

function resolveDraft(d: SectionDraft): UnifiedSection {
  const oldPath = d.pairOld !== undefined ? d.pairOld : d.renameFrom !== undefined ? d.renameFrom : d.gitOld !== undefined ? d.gitOld : null;
  const newPath = d.pairNew !== undefined ? d.pairNew : d.renameTo !== undefined ? d.renameTo : d.gitNew !== undefined ? d.gitNew : null;
  return { oldPath, newPath, create: oldPath === null || d.newFile, remove: newPath === null || d.deletedFile, hunks: d.hunks };
}

/** A hunk body line: context, old, new, a `\` marker, or an empty (context) line. */
function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

/** Parse a unified patch (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: SectionDraft | null = null;
  const finish = (): void => {
    if (cur !== null) sections.push(resolveDraft(cur));
    cur = null;
  };
  const startFromGit = (line: string, at: number): void => {
    const paths = gitPaths(line);
    if (paths === null) throw new Exit2(`error: parse ${at + 1}`);
    finish();
    cur = freshDraft();
    cur.gitOld = paths[0];
    cur.gitNew = paths[1];
  };
  const takePair = (at: number): void => {
    cur!.pairOld = dashPath(lines[at]!);
    cur!.pairNew = dashPath(lines[at + 1]!);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const nextIsPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
    if (line.startsWith('diff --git ')) {
      startFromGit(line, i);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && nextIsPlus) {
      if (cur === null) {
        cur = freshDraft();
        takePair(i);
      } else if (!cur.hunksStarted && cur.pairOld === undefined) {
        takePair(i);
      } else {
        finish();
        cur = freshDraft();
        takePair(i);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!cur.hunksStarted) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ') && cur.pairNew === undefined) {
        cur.pairNew = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ') && cur.renameFrom === undefined) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ') && cur.renameTo === undefined) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const start = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (!isBodyLine(l)) break;
        body.push(l);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const built = hunkBody(body);
      cur.hunks.push({ start, old: built.old, next: built.next, noBreakAfterLast: built.noBreakAfterLast, noBreakAfterPlus: built.noBreakAfterPlus });
      cur.hunksStarted = true;
      i = j;
      continue;
    }
    i += 1;
  }
  finish();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply one section's hunks in order to a working copy of the file's lines. */
function applyUnifiedHunks(work: SplitFile, hunks: UnifiedHunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    if (h.old.length === 0) {
      const at = Math.max(0, Math.min(h.start + d, work.lines.length));
      const atEnd = at === work.lines.length;
      work.lines.splice(at, 0, ...plainReplacement(h.next));
      if (atEnd) work.final = !h.noBreakAfterLast;
      d += h.next.length;
      continue;
    }
    const found = firstTier(work.lines, h.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.start - 1 + d;
    let best = found.hits[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.hits) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const replacement = buildReplacement(h.old, h.next, work.lines, best, found.tier);
    const touchesEnd = best + h.old.length === work.lines.length;
    work.lines.splice(best, h.old.length, ...replacement);
    if (touchesEnd) work.final = !h.noBreakAfterLast;
    d += h.next.length - h.old.length;
  }
}

function unifiedSectionEdit(s: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    if (s.create) {
      const np = s.newPath ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const added: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        let sawPlus = false;
        for (const item of h.next) {
          if (item.ctx < 0) {
            added.push(item.text);
            sawPlus = true;
          }
        }
        if (sawPlus) noBreak = h.noBreakAfterPlus;
      }
      tree.now.set(np, joinFile({ br: '\n', lines: added, final: !noBreak }));
      return;
    }
    if (s.remove) {
      const op = s.oldPath ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (s.oldPath !== s.newPath) {
      const op = s.oldPath ?? '';
      const np = s.newPath ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const work = splitFile(before);
      applyUnifiedHunks(work, s.hunks, op, strict);
      tree.now.set(op, null);
      tree.now.set(np, joinFile(work));
      tree.moves.push({ from: op, to: np });
      return;
    }
    const p = s.oldPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const work = splitFile(before);
    applyUnifiedHunks(work, s.hunks, p, strict);
    tree.now.set(p, joinFile(work));
  };
}

/** One SEARCH/REPLACE block: its path, its old lines and its new lines. */
interface SearchBlock {
  path: string;
  old: string[];
  next: NewItem[];
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevPath: string | undefined;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let path: string | undefined;
    for (let j = searchAt - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchAt + 1}`);
    prevPath = path;
    blocks.push({
      path,
      old: lines.slice(searchAt + 1, eq),
      next: lines.slice(eq + 1, rep).map((text) => ({ text, ctx: -1 })),
    });
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => searchBlockEdit(b, strict));
}

function searchBlockEdit(b: SearchBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile({ br: '\n', lines: plainReplacement(b.next), final: true }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const work = splitFile(before);
    const found = firstTier(work.lines, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.hits.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.hits[0]!;
    const replacement = buildReplacement(b.old, b.next, work.lines, at, found.tier);
    work.lines.splice(at, b.old.length, ...replacement);
    tree.now.set(b.path, joinFile(work));
  };
}

/** One V4A chunk: its anchor (null for none), its O and N, and its end-of-file mark. */
interface V4aChunk {
  anchor: string | null;
  old: string[];
  next: NewItem[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function isV4aStart(line: string): boolean {
  return V4A_STARTS.some((p) => line.startsWith(p));
}

/** Parse a V4A patch (SPEC.md section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isV4aStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const rawStart = i + 1;
    const raw: string[] = [];
    let j = rawStart;
    while (j < last && !isV4aStart(lines[j]!)) {
      raw.push(lines[j]!);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    sections.push(parseV4aSection(kind, path, raw, rawStart, i + 1));
    i = j;
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, raw: string[], rawStart: number, updateLine: number): V4aSection {
  if (kind === 'add') {
    const content: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l.startsWith('+')) content.push(l.slice(1));
      else if (l === '') content.push('');
      else throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    return { kind: 'add', path, content };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${rawStart + 1}`);
    return { kind: 'delete', path };
  }
  let k = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      const built = hunkBody(cur.body);
      chunks.push({ anchor: cur.anchor, old: built.old, next: built.next, eof: cur.eof });
      cur = null;
    }
  };
  for (; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      closeChunk();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${rawStart + k + 1}`);
      cur.eof = true;
      closeChunk();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${rawStart + k + 1}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${rawStart + k + 1}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { kind: 'update', path, moveTo, chunks };
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinFile({ br: '\n', lines: s.content, final: true }));
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const work = splitFile(before);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const anchorAt = firstTier(work.lines, [c.anchor], strict, cursor, false);
        if (anchorAt === null) throw new Fail('no-match', s.path);
        cursor = anchorAt.hits[0]! + 1;
      }
      if (c.old.length === 0) {
        const at = c.eof ? work.lines.length : Math.min(cursor, work.lines.length);
        work.lines.splice(at, 0, ...plainReplacement(c.next));
        cursor = at + c.next.length;
        continue;
      }
      const found = firstTier(work.lines, c.old, strict, cursor, c.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const at = found.hits[0]!;
      const replacement = buildReplacement(c.old, c.next, work.lines, at, found.tier);
      work.lines.splice(at, c.old.length, ...replacement);
      cursor = at + replacement.length;
    }
    const out = joinFile(work);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push({ from: s.path, to: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ path: string; was: string | null; now: string | null }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, was, now });
  }
  if (!check) {
    const byPath = (a: { path: string }, b: { path: string }): number => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    const gone = changed.filter((c) => c.now === null).sort(byPath);
    const kept = changed.filter((c) => c.now !== null).sort(byPath);
    for (const c of gone) rmSync(c.path, { force: true });
    for (const c of kept) {
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.now!);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  const paired = new Set<string>();
  for (const m of tree.moves) {
    const oldRec = changed.find((c) => c.path === m.from);
    const newRec = changed.find((c) => c.path === m.to);
    if (oldRec !== undefined && newRec !== undefined && oldRec.was !== null && oldRec.now === null && newRec.was === null && newRec.now !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      paired.add(m.from);
      paired.add(m.to);
    }
  }
  for (const c of changed) {
    if (paired.has(c.path)) continue;
    rows.push({ key: c.path, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const linesOut = rows.map((r) => r.line);
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
