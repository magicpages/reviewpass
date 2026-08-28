// TypeScript 7 is the Go rewrite and no longer exposes the classic compiler
// API, so the parser comes from a 5.x alias. Parsing only — no typechecker, no
// `node_modules` required, which is what makes indexing an ephemeral worktree
// practical.
import ts from 'ts-parser';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A symbol graph of the repository: what is declared where, and where each
 * declaration is referenced.
 *
 * Why this exists: only a small fraction of real findings come from remembered
 * rules or guidelines. The overwhelming majority come from reading code — and
 * reading it *beyond the diff*, which is exactly what a code graph buys. Grep
 * gets close but cannot distinguish a declaration from a mention, or tell which
 * of forty files actually calls the function being changed.
 *
 * Built on TypeScript's parser rather than its typechecker. The typechecker
 * would resolve overloads exactly, but it needs `node_modules` present, and
 * reviewpass reviews in an ephemeral worktree off a bare mirror where installing
 * dependencies would dominate the runtime. Parsing needs nothing but the source.
 */

export type SymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method' | 'property';

export interface Declaration {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  endLine: number;
  exported: boolean;
  /** The enclosing class or interface, when the symbol is a member. */
  container?: string;
}

export interface Reference {
  name: string;
  path: string;
  line: number;
  /**
   * `call` distinguishes invoking something from merely naming it, and
   * `construct` a `new X()` from both — a constructed sub-app configured with
   * options is the peer evidence that shows an unconfigured one is incomplete.
   */
  kind: 'call' | 'construct' | 'mention' | 'key';
  /**
   * Characters spanned by the whole expression, arguments included. A proxy for
   * how completely a site uses the API: the peer that passes the options object
   * is longer than the one that passes nothing, and it is the one worth showing.
   */
  span: number;
}

export interface ImportEdge {
  fromPath: string;
  /** Module specifier as written. */
  specifier: string;
  names: string[];
}

export interface FileGraph {
  path: string;
  declarations: Declaration[];
  references: Reference[];
  imports: ImportEdge[];
}

const SOURCE_RE = /\.(m?[jt]sx?|cts|mts)$/;
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
  'out', 'vendor', '.cache', '.yarn', '.pnpm-store', '__snapshots__',
]);

/** Every source file worth indexing, relative to the repository root. */
export function listSourceFiles(root: string, limit = 20_000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && SOURCE_RE.test(e.name)) {
        try {
          // A generated bundle is megabytes of noise.
          if (statSync(full).size < 512 * 1024) out.push(relative(root, full));
        } catch { /* unreadable file */ }
      }
    }
  };
  walk(root);
  return out;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Parse one file into declarations, references and import edges. */
export function parseFile(path: string, text: string): FileGraph {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const declarations: Declaration[] = [];
  const references: Reference[] = [];
  const imports: ImportEdge[] = [];

  // Callee identifiers, so a call site is not also counted as a mention of
  // its own callee.
  const calleeIdentifiers = new Set<ts.Node>();

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const declare = (name: string, kind: SymbolKind, node: ts.Node, container?: string) => {
    if (!name || name.length < 2) return;
    declarations.push({
      name,
      kind,
      path,
      line: lineOf(node.getStart(sf)),
      endLine: lineOf(node.getEnd()),
      exported: isExported(node),
      container,
    });
  };

  const visit = (node: ts.Node, container?: string): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.push(el.name.text);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(clause.namedBindings.name.text);
        }
      }
      imports.push({ fromPath: path, specifier: node.moduleSpecifier.text, names });
    }

    if (ts.isFunctionDeclaration(node) && node.name) declare(node.name.text, 'function', node);
    else if (ts.isClassDeclaration(node) && node.name) declare(node.name.text, 'class', node);
    else if (ts.isInterfaceDeclaration(node)) declare(node.name.text, 'interface', node);
    else if (ts.isTypeAliasDeclaration(node)) declare(node.name.text, 'type', node);
    else if (ts.isEnumDeclaration(node)) declare(node.name.text, 'enum', node);
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text, 'method', node, container);
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text, 'property', node, container);
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        // An arrow function assigned to a const is a function in practice.
        const kind: SymbolKind =
          d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
            ? 'function'
            : 'const';
        declare(d.name.text, kind, node);
      }
    }

    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = node.name;
      const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      if (text && text.length >= 3) {
        const start = node.getStart(sf);
        references.push({
          name: text, path, line: lineOf(start), kind: 'key',
          // The whole assignment, so `$set: { role: 'owner' }` outranks a bare
          // `$set: x` when peers are ranked by how much they do.
          span: node.getEnd() - start,
        });
        if (ts.isIdentifier(key)) calleeIdentifiers.add(key);
      }
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = node.expression;
      const name = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)
          ? target.name.text
          : undefined;
      if (name && name.length > 2) {
        const start = node.getStart(sf);
        references.push({
          name,
          path,
          line: lineOf(start),
          kind: ts.isNewExpression(node) ? 'construct' : 'call',
          span: node.getEnd() - start,
        });
        // The callee identifier is visited again as a child; recording it as a
        // bare mention would duplicate every call site.
        calleeIdentifiers.add(ts.isIdentifier(target) ? target : (target as ts.PropertyAccessExpression).name);
      }
    } else if (
      ts.isIdentifier(node) &&
      node.text.length > 3 &&
      !isOwnDeclarationName(node) &&
      !calleeIdentifiers.has(node)
    ) {
      const start = node.getStart(sf);
      references.push({
        name: node.text,
        path,
        line: lineOf(start),
        kind: 'mention',
        span: node.getEnd() - start,
      });
    }

    const nextContainer =
      (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name
        ? node.name.text
        : container;
    ts.forEachChild(node, (child) => visit(child, nextContainer));
  };

  visit(sf);
  return { path, declarations, references, imports };
}

/**
 * Is this identifier the name being declared, rather than a use of one?
 * `isDeclarationName` is not part of the public API, and counting a declaration
 * as a reference to itself would make every symbol look used.
 */
function isOwnDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node & { name?: ts.Node };
  return Boolean(parent && parent.name === node);
}

export async function parsePath(root: string, rel: string): Promise<FileGraph | null> {
  try {
    return parseFile(rel, await readFile(join(root, rel), 'utf8'));
  } catch {
    // A file that will not parse is skipped rather than failing the index.
    return null;
  }
}
