import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const CHINESE = /[\u4e00-\u9fff]/;
const isScope = (node) =>
  ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node);
const scopeOf = (node) => {
  for (let parent = node.parent; parent; parent = parent.parent) if (isScope(parent)) return parent;
};
const nameOf = (node) =>
  ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;

/** Inspect source without executing it or guessing at values supplied at runtime. */
export function analyzeSource(text, file = 'fixture.cjs', depth = 0) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const scopes = new Map();
  const messages = new Map();
  const used = new Set();
  function declare(node, name, initializer) {
    const scope = scopeOf(node);
    if (!scope || !ts.isIdentifier(name)) return;
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope).set(name.text, initializer);
  }
  function collect(node) {
    if (ts.isVariableDeclaration(node))
      declare(
        node,
        node.name,
        ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const
          ? node.initializer
          : undefined,
      );
    if (ts.isParameter(node)) declare(node, node.name, undefined);
    ts.forEachChild(node, collect);
  }
  collect(source);

  // Each value is either an exact string or a fixed prefix before the first
  // unknown runtime value. Keep conditional alternatives separate.
  function values(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return [{ text: node.text, complete: true }];
    if (ts.isNumericLiteral(node)) return [{ text: node.text, complete: true }];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return values(node.expression, next);
    if (ts.isIdentifier(node)) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        const scope = scopes.get(parent);
        if (scope?.has(node.text)) return values(scope.get(node.text), next);
      }
      return [];
    }
    if (ts.isConditionalExpression(node))
      return [...values(node.whenTrue, next), ...values(node.whenFalse, next)];
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    )
      return [...values(node.left, next), ...values(node.right, next)];
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    )
      return values(node.right, next);
    const join = (left, right) =>
      left.flatMap((value) =>
        !value.complete
          ? [value]
          : right.length
            ? right.map((tail) => ({
                text: value.text + tail.text,
                complete: tail.complete,
              }))
            : [{ text: value.text, complete: false }],
      );
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return join(values(node.left, next), values(node.right, next));
    if (ts.isTemplateExpression(node)) {
      let parts = [{ text: node.head.text, complete: true }];
      for (const span of node.templateSpans) {
        parts = join(parts, values(span.expression, next));
        parts = join(parts, [{ text: span.literal.text, complete: true }]);
      }
      return parts;
    }
    if (
      ts.isCallExpression(node) &&
      ['t', 'translateUI', 'formatUI', 'String'].includes(nameOf(node.expression))
    )
      return values(node.arguments[0], next);
    return [];
  }
  function raised(node) {
    for (const value of values(node)) {
      if (!CHINESE.test(value.text)) continue;
      used.add(value.text);
      if (!messages.has(value.text))
        messages.set(value.text, {
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          prefix: !value.complete,
        });
    }
  }
  function walk(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) used.add(node.text);
    if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node))
      for (const value of values(node)) if (value.text) used.add(value.text);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : nameOf(node.expression);
      const args = node.arguments || [];
      // Both fail(message, code) and fail(code, message) occur in production.
      // Chinese text in either position must be covered, as must custom *Error
      // constructors. Error codes themselves do not contain Chinese text.
      if (callee && (/Error$/.test(callee) || ['fail', 'failure'].includes(callee)))
        args.forEach(raised);
      if (callee === 'send' && values(args[0]).some((value) => value.text === 'notice'))
        raised(args[1]);
      // Print/export executes JavaScript source in an isolated Electron window.
      // Those errors are UI messages too, even though the outer AST sees a string.
      if (callee === 'executeJavaScript' && depth < 2)
        for (const code of values(args[0]).filter((value) => value.complete)) {
          const embedded = analyzeSource(code.text, file + ':executeJavaScript', depth + 1);
          for (const [message, location] of embedded.messages) messages.set(message, location);
          for (const literal of embedded.used) used.add(literal);
        }
    }
    if (ts.isPropertyAssignment(node) && nameOf(node.name) === 'message') raised(node.initializer);
    // Presenters build a message through branches before sanitizing it with
    // String(message).replace(...).slice(...). Inspect each assignment directly;
    // do not pretend to evaluate arbitrary runtime control flow or transforms.
    if (ts.isVariableDeclaration(node) && nameOf(node.name) === 'message') raised(node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (nameOf(node.left) === 'message' ||
        (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'message'))
    )
      raised(node.right);
    ts.forEachChild(node, walk);
  }
  walk(source);
  return { messages, used };
}

export function sourceFiles(directories) {
  const files = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name.startsWith('translations.en')) continue;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.(?:[cm]?[jt]s|tsx)$/.test(item.name)) files.push(file);
    }
  }
  directories.forEach(visit);
  return files.sort();
}

export function analyzeFiles(files) {
  const messages = new Map();
  const used = new Set();
  for (const file of files) {
    const result = analyzeSource(fs.readFileSync(file, 'utf8'), file);
    for (const [message, location] of result.messages) messages.set(message, location);
    for (const value of result.used) used.add(value);
  }
  return { messages, used };
}
