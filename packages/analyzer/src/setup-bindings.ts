import ts from "typescript";
import { canonicalPath } from "@boringapi/core/conventions";
import { declarationOf, moduleExports, originalSymbol } from "@boringapi/compiler";

export const operationalBindingNames = ["publications", "observability", "readiness"] as const;
export type OperationalBindingName = typeof operationalBindingNames[number];
export type SetupMethodName = "set" | "assign" | OperationalBindingName;
export type SetupFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
export type OperationalBindingAccess = {
    name: OperationalBindingName;
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression;
    call?: ts.CallExpression;
    direct: boolean;
};

function unwrap(node: ts.Node): ts.Node {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
}

function functionValue(checker: ts.TypeChecker, node: ts.Node, seen = new Set<ts.Node>()): SetupFunction | undefined {
    node = unwrap(node);
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return node;
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
        return functionValue(checker, node.initializer, seen);
    }
    const found = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node) :
        ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node) : undefined;
    const declaration = found && declarationOf(checker, originalSymbol(checker, found));
    return declaration ? functionValue(checker, declaration, seen) : undefined;
}

export function setupFunction(checker: ts.TypeChecker, source: ts.SourceFile | undefined): SetupFunction | undefined {
    const symbol = source && moduleExports(checker, source).find(entry => entry.name === "setup");
    const declaration = symbol && declarationOf(checker, symbol);
    return declaration ? functionValue(checker, declaration) : undefined;
}

/** One semantic model shared by mandatory checks and static inspection. */
export function setupBindingMatcher(program: ts.Program, setupSource?: ts.SourceFile) {
    const checker = program.getTypeChecker();
    const coreSource = program.getSourceFiles().find(file =>
        canonicalPath(file.fileName) === canonicalPath(require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")));
    const setupContextExport = coreSource && moduleExports(checker, coreSource).find(symbol => symbol.name === "SetupContext");
    const setupContextSymbol = setupContextExport && originalSymbol(checker, setupContextExport);
    const methodDeclarations = new Map<ts.Declaration, SetupMethodName>();
    if (setupContextSymbol) {
        const type = checker.getDeclaredTypeOfSymbol(setupContextSymbol);
        for (const name of ["set", "assign", ...operationalBindingNames] as const) {
            const property = type.getProperty(name);
            for (const declaration of property?.declarations ?? []) methodDeclarations.set(declaration, name);
        }
    }
    const setup = setupFunction(checker, setupSource);
    const parameter = setup?.parameters.length === 1 ? setup.parameters[0] : undefined;
    const parameterSymbol = parameter && ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined;

    function method(type: ts.Type): SetupMethodName | undefined {
        for (const signature of type.getCallSignatures()) {
            const declaration = signature.declaration;
            const name = declaration && methodDeclarations.get(declaration);
            if (name) return name;
        }
        return undefined;
    }

    function context(type: ts.Type): boolean {
        return (["set", "assign", ...operationalBindingNames] as const).every(name => {
            const property = type.getProperty(name);
            const site = property?.valueDeclaration ?? property?.declarations?.[0];
            return !!property && !!site && method(checker.getTypeOfSymbolAtLocation(property, site)) === name;
        });
    }

    const parameterType = parameter && checker.getTypeAtLocation(parameter);
    const parameterContract = !!parameterType && context(parameterType);

    function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
        for (let current = node.parent; current; current = current.parent) {
            if (ts.isFunctionLike(current)) return current;
        }
        return undefined;
    }

    function access(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): OperationalBindingAccess | undefined {
        const literalName = ts.isPropertyAccessExpression(node) ? node.name.text :
            ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
        const name = method(checker.getTypeAtLocation(node));
        if (!name || !operationalBindingNames.includes(name as OperationalBindingName)) return;
        const binding = name as OperationalBindingName;
        const receiver = node.expression;
        const receiverSymbol = ts.isIdentifier(receiver) && checker.getSymbolAtLocation(receiver);
        const literalMember = literalName === binding;
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
        return { name: binding, node, call, direct: !!call && !node.questionDotToken && !call.questionDotToken &&
            literalMember && !!parameterSymbol && receiverSymbol === parameterSymbol && enclosingFunction(call) === setup };
    }

    return { setup, parameter, parameterContract, context, method, access };
}
