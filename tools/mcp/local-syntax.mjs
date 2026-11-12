import ts from 'typescript';

const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const fetchModules = new Set(['node-fetch', 'cross-fetch', 'undici']);
const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
};

export function localCalls(file, source, sdkMappings = []) {
  const options = { allowJs: true, noLib: true, noResolve: true, types: [] };
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (parsed.parseDiagnostics.length) return null;
  const program = ts.createProgram([file], options, {
    getSourceFile: (name) => (name === file ? parsed : undefined),
    getDefaultLibFileName: () => '',
    writeFile() {},
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: (name) => name === file,
    readFile: (name) => (name === file ? source : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const imports = new Map();
  const mutations = new Set();
  const symbol = (node) => checker.getSymbolAtLocation(node);
  const root = (input) => {
    let node = unwrap(input);
    while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
      node = unwrap(node.expression);
    return node && ts.isIdentifier(node) ? symbol(node) : undefined;
  };
  const mutated = (node) => {
    let binding = root(node);
    const seen = new Set();
    while (binding && !seen.has(binding)) {
      seen.add(binding);
      mutations.add(binding);
      const declarations = binding.getDeclarations();
      const declaration = declarations?.length === 1 ? declarations[0] : undefined;
      binding =
        declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          ? root(declaration.initializer)
          : undefined;
    }
  };
  function walk(node, visit) {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  }
  walk(parsed, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      if (clause?.name) imports.set(symbol(clause.name), { module, name: 'default' });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        imports.set(symbol(clause.namedBindings.name), { module, name: '*' });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const binding of clause.namedBindings.elements)
          if (!binding.isTypeOnly)
            imports.set(symbol(binding.name), {
              module,
              name: binding.propertyName?.text ?? binding.name.text,
            });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      mutated(node.left);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      mutated(node.operand);
    if (ts.isDeleteExpression(node)) mutated(node.expression);
  });
  const declaration = (node) => {
    const binding = symbol(node);
    if (mutations.has(binding)) return undefined;
    const declarations = binding?.getDeclarations();
    if (declarations?.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return undefined;
    const value = declarations[0];
    return ts.isIdentifier(value.name) &&
      ts.isVariableDeclarationList(value.parent) &&
      value.parent.flags & ts.NodeFlags.Const
      ? value.initializer
      : undefined;
  };
  function values(input, seen = new Set()) {
    const node = unwrap(input);
    if (!node || seen.size >= 16 || seen.has(node)) return null;
    const next = new Set([...seen, node]);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isIdentifier(node)) return values(declaration(node), next);
    if (ts.isConditionalExpression(node)) {
      const a = values(node.whenTrue, next),
        b = values(node.whenFalse, next);
      return a && b && a.length + b.length <= 8 ? [...new Set([...a, ...b])] : null;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = values(node.left, next),
        b = values(node.right, next);
      return a && b && a.length * b.length <= 8 ? a.flatMap((x) => b.map((y) => x + y)) : null;
    }
    if (ts.isTemplateExpression(node)) {
      let result = [node.head.text];
      for (const span of node.templateSpans) {
        const fragments = values(span.expression, next);
        if (!fragments || result.length * fragments.length > 8) return null;
        result = result.flatMap((value) =>
          fragments.map((fragment) => value + fragment + span.literal.text),
        );
      }
      return result;
    }
    return null;
  }
  function property(input, key, seen = new Set()) {
    const node = unwrap(input);
    if (!node || seen.has(node) || seen.size >= 16) return { known: false };
    if (ts.isIdentifier(node)) return property(declaration(node), key, new Set([...seen, node]));
    if (
      !ts.isObjectLiteralExpression(node) ||
      node.properties.some(
        (entry) =>
          !ts.isPropertyAssignment(entry) ||
          !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)),
      )
    )
      return { known: false };
    const entries = node.properties.filter((entry) => entry.name.text === key);
    return entries.length <= 1 ? { known: true, node: entries[0]?.initializer } : { known: false };
  }
  function origin(input, seen = new Set()) {
    const node = unwrap(input);
    if (!node || seen.has(node) || seen.size >= 16) return null;
    const next = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const binding = symbol(node);
      if (mutations.has(binding)) return null;
      if (!binding && node.text === 'fetch') return { kind: 'fetch', path: [] };
      const imported = imports.get(binding);
      if (imported) return { kind: 'module', ...imported, path: [] };
      return origin(declaration(node), next);
    }
    if (ts.isPropertyAccessExpression(node) && !mutations.has(root(node))) {
      const base = origin(node.expression, next);
      return base ? { ...base, path: [...base.path, node.name.text] } : null;
    }
    if (ts.isNewExpression(node)) {
      const constructor = origin(node.expression, next);
      if (
        constructor?.kind === 'module' &&
        sdkMappings.some((mapping) => mapping.moduleSpecifiers.includes(constructor.module))
      )
        return { kind: 'sdk', module: constructor.module, path: [] };
    }
    return null;
  }
  const calls = [];
  let unresolvedCalls = 0;
  walk(parsed, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = origin(node.expression);
    if (!callee) return;
    const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    if (callee.kind === 'sdk') {
      const mappings = sdkMappings.filter(
        (mapping) =>
          mapping.moduleSpecifiers.includes(callee.module) &&
          mapping.symbol === callee.path.join('.'),
      );
      if (!mappings.length) {
        unresolvedCalls++;
        return;
      }
      for (const mapping of mappings) calls.push({ line, sdk: mapping });
      return;
    }
    let endpoint, methodValues;
    const isFetch =
      callee.kind === 'fetch' ||
      (callee.kind === 'module' &&
        fetchModules.has(callee.module) &&
        ((callee.name === 'default' && !callee.path.length && callee.module !== 'undici') ||
          (callee.name === 'fetch' && !callee.path.length) ||
          (callee.name === '*' && callee.path.join('.') === 'fetch')));
    const axios =
      callee.kind === 'module' &&
      callee.module === 'axios' &&
      ['default', '*'].includes(callee.name);
    if (
      isFetch ||
      (callee.module === 'undici' && callee.name === 'request' && !callee.path.length)
    ) {
      endpoint = node.arguments[0];
      const method = node.arguments[1] ? property(node.arguments[1], 'method') : { known: true };
      methodValues = method.known ? (method.node ? values(method.node) : ['GET']) : null;
    } else if (axios) {
      const action = callee.path.join('.');
      if (verbs.has(action)) {
        endpoint = node.arguments[0];
        methodValues = [action.toUpperCase()];
      } else if (!action || action === 'request') {
        const config = node.arguments[0],
          url = property(config, 'url'),
          method = property(config, 'method');
        endpoint = url.known ? url.node : undefined;
        methodValues = method.known ? (method.node ? values(method.node) : ['GET']) : null;
      } else return;
    } else return;
    const urls = values(endpoint);
    if (!urls || !methodValues) {
      unresolvedCalls++;
      return;
    }
    for (const url of urls)
      for (const method of methodValues) calls.push({ line, url, method: method.toUpperCase() });
  });
  return { calls, unresolvedCalls };
}
