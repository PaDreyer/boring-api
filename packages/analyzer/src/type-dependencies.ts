import ts from "typescript";

/** Only explicitly erased edges qualify; empty and mixed clauses retain effects. */
export function typeOnlyDependency(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
    if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (!clause) return false;
        if (clause.isTypeOnly) return true;
        return !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly);
    }
    return node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly);
}
