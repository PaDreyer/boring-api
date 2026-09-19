import ts from "typescript";

export function moduleExports(checker: ts.TypeChecker, source: ts.SourceFile): ts.Symbol[] {
    // TS 4.9 binds CommonJS exports to SourceFile.symbol but does not return that
    // symbol from getSymbolAtLocation(source). Use the binder's module symbol so
    // JS consumers and unused CommonJS facades have the same catalog as TS files.
    const symbol = checker.getSymbolAtLocation(source) ?? (source as ts.SourceFile & { symbol?: ts.Symbol }).symbol;
    if (!symbol) return [];
    const exports = symbol.exports?.has(ts.InternalSymbolName.ExportEquals)
        ? checker.getTypeOfSymbolAtLocation(symbol, source).getProperties()
        : checker.getExportsOfModule(symbol);
    return exports.sort((a, b) => a.name.localeCompare(b.name));
}

export function originalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Retain erased imports/exports along the alias chain before resolving its value. */
export function isTypeOnlyExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
    const seen = new Set<ts.Symbol>();
    while (symbol.flags & ts.SymbolFlags.Alias) {
        if (symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return true;
        if (seen.has(symbol)) break;
        seen.add(symbol);
        const target = checker.getImmediateAliasedSymbol(symbol);
        if (!target) break;
        symbol = target;
    }
    return !(originalSymbol(checker, symbol).flags & ts.SymbolFlags.Value);
}

export function declarationOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Declaration | undefined {
    const original = originalSymbol(checker, symbol);
    return original.declarations?.find(declaration =>
        (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) ??
        original.valueDeclaration ?? original.declarations?.[0];
}

export function exported(checker: ts.TypeChecker, source: ts.SourceFile, name: string): ts.Symbol | undefined {
    return moduleExports(checker, source).find(symbol => symbol.name === name);
}

export function symbolType(checker: ts.TypeChecker, symbol: ts.Symbol, fallback: ts.Node): ts.Type {
    const original = originalSymbol(checker, symbol);
    return checker.getTypeOfSymbolAtLocation(original, declarationOf(checker, original) ?? fallback);
}

