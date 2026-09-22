import ts from "typescript";
import { validateScheduleTiming } from "@boringapi/core";
import { canonicalPath, applicationRole, RoleSource } from "@boringapi/core/conventions";
import { declarationOf, isTypeOnlyExport, moduleExports, originalSymbol, symbolType } from "@boringapi/compiler";
import type { ArchitectureDiagnostic } from "./architecture";
import { typeOnlyDependency } from "./type-dependencies";
import { setupBindingMatcher } from "./setup-bindings";

type FunctionBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/** Value boundaries are deliberately a small, inspectable composition language. */
export function checkBoundaries(program: ts.Program, apiDirectory: string, sources: ts.SourceFile[]): ArchitectureDiagnostic[] {
    const checker = program.getTypeChecker();
    const setupBindings = setupBindingMatcher(program, sources.find(source => applicationRole(apiDirectory, source.fileName).role === "setup"));
    const coreSource = program.getSourceFiles().find(file => canonicalPath(file.fileName) === canonicalPath(require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")));
    const contextExport = coreSource && moduleExports(checker, coreSource).find(symbol => symbol.name === "ExecutionContext");
    const contextSymbol = contextExport && originalSymbol(checker, contextExport);
    const contextBrand = contextSymbol && checker.getDeclaredTypeOfSymbol(contextSymbol).getProperties().find(property =>
        property.declarations?.some(declaration => ts.isPropertySignature(declaration) && ts.isComputedPropertyName(declaration.name) &&
            !!(checker.getTypeAtLocation(declaration.name.expression).flags & ts.TypeFlags.UniqueESSymbol)));
    const coreErrorExport = coreSource && moduleExports(checker, coreSource).find(symbol => symbol.name === "HttpError");
    const coreErrorSymbol = coreErrorExport && originalSymbol(checker, coreErrorExport);
    const applicationExport = coreSource && moduleExports(checker, coreSource).find(symbol => symbol.name === "Application");
    const applicationSymbol = applicationExport && originalSymbol(checker, applicationExport);
    const entryContexts = new Map(["job", "schedule", "event", "command"].map(kind => {
        const exported = coreSource && moduleExports(checker, coreSource).find(symbol => symbol.name === `${kind[0].toUpperCase()}${kind.slice(1)}Context`);
        return [kind, exported && originalSymbol(checker, exported)];
    }));
    function coreEntryContext(type: ts.Type, kind: string): boolean {
        if (!entryContexts.get(kind) || type.getSymbol() !== entryContexts.get(kind) || type.isUnionOrIntersection()) return false;
        const [payload, services] = checker.getTypeArguments(type as ts.TypeReference);
        return !!payload && data(payload) && !!services && !(services.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive));
    }
    function coreExecutionType(type: ts.Type): boolean { return !!contextSymbol && type.getSymbol() === contextSymbol && !type.isUnionOrIntersection(); }
    function executionContext(type: ts.Type): boolean {
        if (!coreExecutionType(type)) return false;
        const identity = type.getProperty("identity");
        return !!identity && data(checker.getTypeOfSymbolAtLocation(identity, identity.valueDeclaration ?? identity.declarations![0]));
    }
    function containsExecutionValue(type: ts.Type, seen = new Set<ts.Type>()): boolean {
        if (data(type)) return false;
        if (seen.has(type) || seen.size > 2048) return false;
        seen.add(type);
        // Retention also covers interfaces extending the nominal context. The public
        // operation-parameter exception still requires the exact Core type above.
        if (coreExecutionType(type) || contextBrand && type.getProperties().some(property => property.escapedName === contextBrand.escapedName)) return true;
        if (type.isUnionOrIntersection()) return type.types.some(part => containsExecutionValue(part, seen));
        if (type.getCallSignatures().length || type.getConstructSignatures().length) return [...type.getCallSignatures(), ...type.getConstructSignatures()].some(signature => containsExecutionValue(signature.getReturnType(), seen));
        if (type.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(type);
            return !!constraint && containsExecutionValue(constraint, seen);
        }
        // Standard-library containers carry values in their type arguments, including
        // write-only WeakSet contents. Do not walk their recursive method graphs.
        if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
            type.getSymbol()?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) {
            return checker.getTypeArguments(type as ts.TypeReference).some(part => containsExecutionValue(part, seen));
        }
        for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
            const indexed = checker.getIndexTypeOfType(type, kind);
            if (indexed && containsExecutionValue(indexed, seen)) return true;
        }
        return type.getProperties().some(property => {
            const site = property.valueDeclaration ?? property.declarations?.[0];
            if (!site) return false;
            const member = checker.getTypeOfSymbolAtLocation(property, site);
            // Accessors also expose stored values (e.g. mapped Readonly<Map<...>>).
            // Input-only context parameters are borrowed capabilities, not retained values.
            return containsExecutionValue(member, seen) || member.getCallSignatures().some(signature =>
                containsExecutionValue(signature.getReturnType(), seen));
        });
    }

    function enclosingFunction(node: ts.Node): ts.Node | undefined {
        let scope = node.parent;
        while (scope && !isFunction(scope)) scope = scope.parent;
        return scope;
    }
    // A bounded, conservative value-flow graph preserves context-bearing callbacks
    // through local parameters and mutable aliases. It never executes source.
    type ValueInput = { node: ts.Node; path: string[]; element?: string };
    const inputs = new Map<ts.Node, ValueInput[]>();
    const arrayContents = new Map<ts.Node, ValueInput[]>();
    const arrayWrites: { site: ts.Node; receiver: ts.Node; value: ValueInput }[] = [];
    const arrayReorders: { site: ts.Node; receiver: ts.Node }[] = [];
    const reorderedArrays = new Set<ts.Node>();
    const arrayIdentityMethods = new Set(["reverse", "sort", "copyWithin", "fill"]);
    function declaration(node: ts.Node): ts.Declaration | undefined {
        const shorthand = ts.isShorthandPropertyAssignment(node) ? node :
            ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? node.parent : undefined;
        const symbol = shorthand ? checker.getShorthandAssignmentValueSymbol(shorthand) : checker.getSymbolAtLocation(node);
        return symbol && declarationOf(checker, originalSymbol(checker, symbol));
    }
    function flow(target: ts.Node | undefined, input: ts.Node, path: string[] = [], element?: string) {
        if (!target || target.getSourceFile().isDeclarationFile) return;
        let values = inputs.get(target);
        if (!values) inputs.set(target, values = []);
        if (!values.some(value => value.node === input && value.element === element && JSON.stringify(value.path) === JSON.stringify(path))) values.push({ node: input, path, element });
    }
    function bindArguments(fn: FunctionBody | ts.ConstructorDeclaration, args: readonly ts.Expression[], applied?: ts.Expression, projected: readonly (ValueInput | undefined)[] = []) {
        const parameters = fn.parameters.filter(parameter => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"));
        let position = 0;
        let uncertain = false;
        function bind(input: ts.Node, path: string[], spread = false) {
            const first = Math.min(position, parameters.length - 1);
            for (let index = first; index >= 0 && index < parameters.length; index++) {
                const parameter = parameters[index];
                if (index >= position || parameter.dotDotDotToken) {
                    flow(parameter, input, path, parameter.dotDotDotToken ? (uncertain || spread ? "*" : String(position - index)) : undefined);
                }
                if (!uncertain && !spread) break;
            }
            if (spread) uncertain = true;
            else position++;
        }
        function spread(argument: ts.Expression) {
            const source = unwrap(argument);
            if (ts.isArrayLiteralExpression(source) && !source.elements.some(ts.isSpreadElement)) {
                for (const element of source.elements) {
                    if (ts.isOmittedExpression(element)) position++;
                    else bind(element, []);
                }
                return;
            }
            const type = checker.getTypeAtLocation(source) as ts.TypeReference;
            const tuple = type.target as ts.TupleType | undefined;
            if (tuple && tuple.objectFlags & ts.ObjectFlags.Tuple && tuple.elementFlags.every(flag => flag === ts.ElementFlags.Required)) {
                checker.getTypeArguments(type).forEach((_, index) => bind(source, [String(index)]));
            } else bind(source, ["*"], true);
        }
        for (const argument of args) {
            if (ts.isSpreadElement(argument)) spread(argument.expression);
            else bind(argument, []);
        }
        if (applied) spread(applied);
        for (const input of projected) {
            if (input) bind(input.node, input.path);
            else position++;
        }
    }
    function bindThis(fn: FunctionBody | ts.ConstructorDeclaration, receiver?: ts.Expression) {
        if (!receiver || ts.isArrowFunction(fn) || !fn.body) return;
        const visit = (node: ts.Node) => {
            if (node !== fn.body && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
            if (node.kind === ts.SyntaxKind.ThisKeyword) flow(node, receiver);
            ts.forEachChild(node, visit);
        };
        visit(fn.body);
    }
    function nativeFunctionMethod(callee: ts.Expression, method: string): boolean {
        const member = unwrap(callee);
        if (!(ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) ||
            (ts.isPropertyAccessExpression(member) ? member.name.text : memberKey(member.argumentExpression, true)) !== method) return false;
        const symbol = ts.isPropertyAccessExpression(member) ? checker.getSymbolAtLocation(member.name) :
            checker.getTypeAtLocation(member.expression).getProperty(method);
        return !!symbol?.declarations?.some(site => program.isSourceFileDefaultLibrary(site.getSourceFile()));
    }
    function localImplementations(node: ts.CallExpression | ts.NewExpression, callee: ts.Expression) {
        const implementations: { fn: FunctionBody | ts.ConstructorDeclaration; boundArgs: readonly ts.Expression[]; thisArg?: ts.Expression }[] = [];
        const seen = new Map<ts.Node, Set<string>>();
        let budget = 2048;
        let exhausted = false;
        // Callable annotations and mutable bindings can hide the implementation
        // from the resolved signature. Follow all possible local values instead.
        function visit(input: ts.Node, path: string[] = [], boundArgs: readonly ts.Expression[] = [], thisArg?: ts.Expression) {
            const source = unwrap(input);
            if (ts.isSourceFile(source) || source.getSourceFile().isDeclarationFile) return;
            if (path.length && /^(?:\d+|\*)$/.test(path[0]) && reorderedArrays.has(source)) path = ["*", ...path.slice(1)];
            const key = JSON.stringify([path, boundArgs.map(arg => [arg.getSourceFile().fileName, arg.pos, arg.end]),
                thisArg && [thisArg.getSourceFile().fileName, thisArg.pos]]);
            if (seen.get(source)?.has(key)) return;
            if (--budget < 0) { exhausted = true; return; }
            if (!seen.has(source)) seen.set(source, new Set());
            seen.get(source)!.add(key);
            if (path.length && /^(?:\d+|\*)$/.test(path[0])) for (const input of arrayContents.get(source) ?? []) {
                if (input.element === "*" || path[0] === "*" || path[0] === input.element) visit(input.node, [...input.path, ...path.slice(1)], boundArgs, thisArg);
            }
            if (ts.isCallExpression(source)) {
                if (!path.length && nativeFunctionMethod(source.expression, "bind")) {
                    const member = unwrap(source.expression) as ts.PropertyAccessExpression | ts.ElementAccessExpression;
                    visit(member.expression, [], [...source.arguments.slice(1), ...boundArgs], source.arguments[0] ?? thisArg);
                    return;
                }
                for (const input of arrayReturnInputs(source, path)) visit(input.node, input.path, boundArgs, thisArg);
            }
            if (isFunction(source) || ts.isConstructorDeclaration(source)) {
                if (!path.length && source.body) implementations.push({ fn: source, boundArgs, thisArg });
                return;
            }
            if (ts.isIdentifier(source)) { const target = declaration(source); if (target) visit(target, path, boundArgs, thisArg); return; }
            if (ts.isPropertyAccessExpression(source) || ts.isElementAccessExpression(source)) {
                visit(source.expression, [ts.isPropertyAccessExpression(source) ? source.name.text : memberKey(source.argumentExpression, true), ...path], boundArgs, thisArg);
                const target = declaration(source);
                if (target) visit(target, path, boundArgs, thisArg);
                return;
            }
            if (ts.isConditionalExpression(source)) { visit(source.whenTrue, path, boundArgs, thisArg); visit(source.whenFalse, path, boundArgs, thisArg); return; }
            if (ts.isPropertyAssignment(source)) { visit(source.initializer, path, boundArgs, thisArg); return; }
            if (ts.isShorthandPropertyAssignment(source)) { visit(source.name, path, boundArgs, thisArg); return; }
            if (path.length && ts.isObjectLiteralExpression(source)) {
                for (const property of source.properties) {
                    if (ts.isSpreadAssignment(property)) visit(property.expression, path, boundArgs, thisArg);
                    else if (path[0] === "*" || memberKey(property.name) === "*" || path[0] === memberKey(property.name)) visit(property, path.slice(1), boundArgs, thisArg);
                }
                return;
            }
            if (path.length && ts.isArrayLiteralExpression(source)) {
                const spread = source.elements.some(ts.isSpreadElement);
                source.elements.forEach((element, index) => {
                    if (ts.isSpreadElement(element)) visit(element.expression, ["*", ...path.slice(1)], boundArgs, thisArg);
                    else if (!ts.isOmittedExpression(element) && (spread || path[0] === "*" || path[0] === String(index))) visit(element, path.slice(1), boundArgs, thisArg);
                });
                return;
            }
            for (const input of inputs.get(source) ?? []) {
                if (input.element !== undefined && path.length && path[0] !== "*" && input.element !== "*" && path[0] !== input.element) continue;
                visit(input.node, [...input.path, ...(input.element !== undefined ? path.slice(1) : path)], boundArgs, thisArg);
            }
        }
        visit(callee);
        const signature = checker.getResolvedSignature(node)?.declaration;
        // Resolved overload signatures describe the call contract. Value flow must
        // use the implementation's parameters and body, including renamed/rest slots.
        if (!implementations.length && signature && !signature.getSourceFile().isDeclarationFile) {
            const candidates: readonly ts.Declaration[] = ts.isConstructorDeclaration(signature) ? signature.parent.members.filter(ts.isConstructorDeclaration) :
                isFunction(signature) && signature.name ? checker.getSymbolAtLocation(signature.name)?.declarations ?? [signature] : [signature];
            for (const candidate of candidates) if ((isFunction(candidate) || ts.isConstructorDeclaration(candidate)) && candidate.body)
                implementations.push({ fn: candidate, boundArgs: [] });
        }
        return { implementations, exhausted };
    }
    function nativeArrayCall(input: ts.Node, unsupported?: (message: string) => void):
        { receiver: ts.Expression; method: string; args: readonly ts.Expression[] } | undefined {
        const node = unwrap(input);
        if (!ts.isCallExpression(node)) return;
        let callee = unwrap(node.expression) as ts.Expression;
        let args: readonly ts.Expression[] = node.arguments;
        let thisArg: ts.Expression | undefined;
        let unsupportedForm: "apply" | "depth" | undefined;
        const visited = new Set<ts.Node>();
        for (let depth = 0; ; depth++) {
            if (depth >= 32) unsupportedForm ??= "depth";
            if (visited.has(callee)) return;
            visited.add(callee);
            if (ts.isIdentifier(callee)) {
                const target = declaration(callee);
                if (target && ts.isVariableDeclaration(target) && target.initializer && ts.getCombinedNodeFlags(target) & ts.NodeFlags.Const) {
                    callee = unwrap(target.initializer) as ts.Expression;
                    continue;
                }
            }
            if (ts.isCallExpression(callee) && nativeFunctionMethod(callee.expression, "bind")) {
                const member = unwrap(callee.expression) as ts.PropertyAccessExpression | ts.ElementAccessExpression;
                args = [...callee.arguments.slice(1), ...args];
                thisArg = callee.arguments[0] ?? thisArg;
                callee = unwrap(member.expression) as ts.Expression;
                continue;
            }
            if ((nativeFunctionMethod(callee, "call") || nativeFunctionMethod(callee, "apply")) &&
                (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
                const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : memberKey(callee.argumentExpression, true);
                thisArg = args[0] ?? thisArg;
                if (method === "call") args = args.slice(1);
                else {
                    const applied = args[1] && unwrap(value(args[1]));
                    if (!applied || !ts.isArrayLiteralExpression(applied) || applied.elements.some(ts.isSpreadElement)) {
                        unsupportedForm = "apply";
                        args = [];
                    } else args = applied.elements.filter((element): element is ts.Expression => !ts.isOmittedExpression(element));
                }
                callee = unwrap(callee.expression) as ts.Expression;
                continue;
            }
            break;
        }
        if (!(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) return;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : memberKey(callee.argumentExpression, true);
        const symbol = ts.isPropertyAccessExpression(callee) ? checker.getSymbolAtLocation(callee.name) :
            checker.getTypeAtLocation(callee.expression).getProperty(method);
        if (!symbol?.declarations?.some(site => program.isSourceFileDefaultLibrary(site.getSourceFile()))) return;
        const owner = checker.getTypeAtLocation(callee.expression);
        if (owner.getSymbol()?.name === "ArrayConstructor" && ["from", "of"].includes(method)) {
            if (unsupportedForm || method === "from" && args.some(ts.isSpreadElement)) {
                unsupported?.(unsupportedForm === "depth" ?
                    "Indirect native array call exceeds the supported alias/bind depth. Call Array.from directly with explicit arguments." :
                    "Native array call arguments cannot be analyzed through dynamic apply or spread. Call Array.from directly with explicit arguments, or use apply with an inline array or constant local tuple without spread.");
                return;
            }
            if (method === "from" && args[0]) return { receiver: args[0], method, args };
            if (method === "of") return { receiver: callee.expression, method, args };
        }
        if (!arrayType(owner)) return;
        if (unsupportedForm ||
            args.some(ts.isSpreadElement) && ["map", "flatMap", "forEach", "filter", "find", "findLast", "findIndex", "findLastIndex", "every", "some", "sort", "reduce", "reduceRight"].includes(method)) {
            unsupported?.(unsupportedForm === "depth" ?
                "Indirect native array call exceeds the supported alias/bind depth. Call the array method directly with explicit arguments." :
                "Native array call arguments cannot be analyzed through dynamic apply or spread. Call the array method directly with explicit arguments, or use apply with an inline array or constant local tuple without spread.");
            return;
        }
        return { receiver: thisArg ?? callee.expression, method, args };
    }
    function arrayReturnInputs(node: ts.CallExpression, selected: string[]): ValueInput[] {
        const native = nativeArrayCall(node);
        if (!native) return [];
        const { receiver, method, args } = native;
        if (method === "from" && (!args[1] || checker.getTypeAtLocation(args[1]).flags & ts.TypeFlags.Undefined)) return [{ node: receiver, path: selected }];
        if (method === "of") return args.map(argument => ({ node: ts.isSpreadElement(argument) ? argument.expression : argument,
            path: ts.isSpreadElement(argument) ? ["*", ...selected.slice(1)] : selected.slice(1) }));
        if (["pop", "shift", "at", "find", "findLast"].includes(method)) return [{ node: receiver, path: ["*", ...selected] }];
        if (arrayIdentityMethods.has(method)) return [{ node: receiver, path: selected.length ? ["*", ...selected.slice(1)] : [] }];
        if (!["slice", "splice", "filter", "concat", "flat"].includes(method) || selected.length && !/^(?:\d+|\*)$/.test(selected[0])) return [];
        const path = !selected.length || method === "slice" && !args.length ? selected : ["*", ...selected.slice(1)];
        const values: ValueInput[] = [{ node: receiver, path }];
        if (method === "concat") for (const argument of args) {
            const input = ts.isSpreadElement(argument) ? argument.expression : argument;
            const inputPath = arrayType(checker.getTypeAtLocation(input)) ? path : selected.slice(1);
            values.push({ node: input, path: ts.isSpreadElement(argument) ? ["*", ...inputPath] : inputPath });
        }
        if (method === "flat" && selected.length) {
            const depth = args[0] && unwrap(args[0]);
            const count = !depth ? 1 : ts.isNumericLiteral(depth) ? Math.max(0, Math.min(32, Math.floor(Number(depth.text)))) : 32;
            // A flat element can originate at any nesting level up to the depth.
            for (let level = 1; level <= count; level++) values.push({ node: receiver, path: ["*", ...Array<string>(level).fill("*"), ...selected.slice(1)] });
        }
        return values;
    }
    function arrayStorage(input: ts.Node): { roots: Set<ts.Node>; exhausted: boolean } {
        const roots = new Set<ts.Node>();
        const seen = new Map<ts.Node, Set<string>>();
        let budget = 2048;
        let exhausted = false;
        function visit(source: ts.Node, path: string[] = []) {
            const node = unwrap(source);
            if (ts.isSourceFile(node) || node.getSourceFile().isDeclarationFile) return;
            if (path.length && /^(?:\d+|\*)$/.test(path[0]) && reorderedArrays.has(node)) path = ["*", ...path.slice(1)];
            const key = JSON.stringify(path);
            if (seen.get(node)?.has(key)) return;
            if (--budget < 0) { exhausted = true; return; }
            if (!seen.has(node)) seen.set(node, new Set());
            seen.get(node)!.add(key);
            if (path.length && /^(?:\d+|\*)$/.test(path[0])) for (const input of arrayContents.get(node) ?? []) {
                if (input.element === "*" || path[0] === "*" || path[0] === input.element) visit(input.node, [...input.path, ...path.slice(1)]);
            }
            if (ts.isIdentifier(node)) { const target = declaration(node); if (target) visit(target, path); return; }
            if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
                visit(node.expression, [ts.isPropertyAccessExpression(node) ? node.name.text : memberKey(node.argumentExpression, true), ...path]);
                return;
            }
            if (ts.isConditionalExpression(node)) { visit(node.whenTrue, path); visit(node.whenFalse, path); return; }
            const native = nativeArrayCall(node);
            if (native && arrayIdentityMethods.has(native.method)) { visit(native.receiver, path.length ? ["*", ...path.slice(1)] : []); return; }
            if (native && ts.isCallExpression(node) && (path.length || ["pop", "shift", "at", "find", "findLast"].includes(native.method))) {
                for (const input of arrayReturnInputs(node, path)) visit(input.node, input.path);
                return;
            }
            if (path.length && ts.isObjectLiteralExpression(node)) {
                for (const property of node.properties) {
                    if (ts.isSpreadAssignment(property)) visit(property.expression, path);
                    else if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
                        (path[0] === "*" || memberKey(property.name) === "*" || path[0] === memberKey(property.name))) {
                        visit(ts.isPropertyAssignment(property) ? property.initializer : property.name, path.slice(1));
                    }
                }
                return;
            }
            if (path.length && ts.isArrayLiteralExpression(node)) {
                const spread = node.elements.some(ts.isSpreadElement);
                node.elements.forEach((element, index) => {
                    if (ts.isSpreadElement(element)) visit(element.expression, ["*", ...path.slice(1)]);
                    else if (!ts.isOmittedExpression(element) && (spread || path[0] === "*" || path[0] === String(index))) visit(element, path.slice(1));
                });
                return;
            }
            let forwarded = false;
            for (const value of inputs.get(node) ?? []) {
                if (value.element !== undefined && (!path.length || path[0] !== "*" && value.element !== "*" && path[0] !== value.element)) continue;
                forwarded = true;
                visit(value.node, [...value.path, ...(value.element !== undefined ? path.slice(1) : path)]);
            }
            if (forwarded) return;
            // A literal, a rest container or a copying/native call owns a distinct
            // array. Writes belong here, never on the declaration of just one alias.
            roots.add(node);
        }
        visit(input);
        return { roots, exhausted };
    }
    function memberKey(name: ts.Node, computed = false): string {
        if (ts.isComputedPropertyName(name)) { name = name.expression; computed = true; }
        if (!computed && ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
        const type = checker.getTypeAtLocation(name);
        return type.isStringLiteral() || type.isNumberLiteral() ? String(type.value) : "*";
    }
    // Declarations and assignments share the same target walk, including defaults,
    // nested patterns and rest targets. Keep the selected source member on each edge.
    function assignmentTargets(target: ts.Node, source: ts.Node, accept: (target: ts.Node, source: ts.Node, path: string[]) => void, path: string[] = []) {
        target = unwrap(target);
        if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            assignmentTargets(target.left, target.right, accept);
            assignmentTargets(target.left, source, accept, path);
        } else if (ts.isArrayLiteralExpression(target) || ts.isArrayBindingPattern(target)) {
            target.elements.forEach((element, index) => {
                if (!ts.isOmittedExpression(element)) assignmentTargets(element, source, accept, [...path, String(index)]);
            });
        } else if (ts.isObjectLiteralExpression(target) || ts.isObjectBindingPattern(target)) {
            const properties = ts.isObjectLiteralExpression(target) ? target.properties : target.elements;
            for (const property of properties) {
                if (ts.isSpreadAssignment(property) || ts.isBindingElement(property) && property.dotDotDotToken) {
                    assignmentTargets(ts.isSpreadAssignment(property) ? property.expression : property.name, source, accept, [...path, "*"]);
                } else if (ts.isPropertyAssignment(property)) {
                    assignmentTargets(property.initializer, source, accept, [...path, memberKey(property.name)]);
                } else if (ts.isShorthandPropertyAssignment(property)) {
                    assignmentTargets(property.name, source, accept, [...path, property.name.text]);
                    if (property.objectAssignmentInitializer) assignmentTargets(property.name, property.objectAssignmentInitializer, accept);
                } else if (ts.isBindingElement(property)) {
                    assignmentTargets(property, source, accept, [...path, memberKey(property.propertyName ?? property.name)]);
                }
            }
        } else if (ts.isBindingElement(target)) {
            assignmentTargets(target.name, source, accept, target.dotDotDotToken ? [...path.slice(0, -1), "*"] : path);
            if (target.initializer) assignmentTargets(target.name, target.initializer, accept);
        } else if (ts.isSpreadElement(target)) {
            assignmentTargets(target.expression, source, accept, [...path.slice(0, -1), "*"]);
        } else accept(target, source, path);
    }
    function assignments(node: ts.Node, accept: (target: ts.Node, source: ts.Node, path: string[]) => void) {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            assignmentTargets(node.left, node.right, accept);
        } else if (ts.isForOfStatement(node)) {
            if (ts.isVariableDeclarationList(node.initializer)) {
                for (const variable of node.initializer.declarations) assignmentTargets(variable.name, node.expression, accept, ["*"]);
            } else assignmentTargets(node.initializer, node.expression, accept, ["*"]);
        }
    }
    function sharedBinding(target: ts.Node | undefined): boolean {
        if (!target || target.getSourceFile().isDeclarationFile) return false;
        const scope = enclosingFunction(target);
        return !scope || applicationScopes.has(scope);
    }
    function sharedTarget(input: ts.Node, seen = new Set<ts.Node>()): boolean {
        const node = unwrap(input);
        if (seen.has(node)) return false;
        if (seen.size > 2048) return true;
        seen.add(node);
        if (arrayType(checker.getTypeAtLocation(node))) {
            const storage = arrayStorage(node);
            if (storage.exhausted || [...storage.roots].some(sharedBinding)) return true;
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return sharedTarget(node.expression, seen);
        if (ts.isConditionalExpression(node)) return sharedTarget(node.whenTrue, seen) || sharedTarget(node.whenFalse, seen);
        const native = nativeArrayCall(node);
        if (native && arrayIdentityMethods.has(native.method)) return sharedTarget(native.receiver, seen);
        if (node.kind === ts.SyntaxKind.ThisKeyword) return true; // Instance lifetime is not invocation-local by construction.
        if (ts.isIdentifier(node)) {
            const target = declaration(node);
            if (!target || target.getSourceFile().isDeclarationFile) return false;
            if (sharedBinding(target)) return true;
            return sharedTarget(target, seen);
        }
        return (inputs.get(node) ?? []).some(value => sharedTarget(value.node, seen));
    }
    function capturedExecution(node: ts.Node, path: string[] = []): boolean {
        let captured = false;
        let budget = 2048;
        const visited = new Map<ts.Node, Set<string>>();
        function visit(item: ts.Node, selected: string[] = []) {
            // Namespace/import-equals symbols can resolve to a SourceFile. Its
            // statements are checked independently; it is not an expression value.
            if (ts.isSourceFile(item) || ts.isTypeNode(item) || item.getSourceFile().isDeclarationFile) return;
            item = unwrap(item);
            if (selected.length && /^(?:\d+|\*)$/.test(selected[0]) && reorderedArrays.has(item)) selected = ["*", ...selected.slice(1)];
            const key = JSON.stringify(selected);
            if (visited.get(item)?.has(key)) return;
            if (--budget < 0) { captured = true; return; }
            if (!visited.has(item)) visited.set(item, new Set());
            visited.get(item)!.add(key);
            // An empty literal may have type never[] even when a wider alias later
            // stores callbacks in it. Inspect writes before pruning its initial type.
            for (const input of arrayContents.get(item) ?? []) {
                if (selected.length && !/^(?:\d+|\*)$/.test(selected[0])) continue;
                if (input.element !== "*" && selected.length && selected[0] !== "*" && selected[0] !== input.element) continue;
                visit(input.node, [...input.path, ...selected.slice(1)]);
                if (captured) return;
            }
            let type: ts.Type | undefined = checker.getTypeAtLocation(item);
            let executionMember = false;
            for (const name of selected) {
                if (!type) break;
                executionMember ||= coreExecutionType(type) || !!contextBrand && type.getProperties().some(property => property.escapedName === contextBrand.escapedName);
                if (name === "*") { type = undefined; break; }
                const property = type.getProperty(name);
                type = property ? checker.getTypeOfSymbolAtLocation(property, item) : checker.getIndexTypeOfType(type, /^\d+$/.test(name) ? ts.IndexKind.Number : ts.IndexKind.String);
            }
            if (type && data(type)) return; // A copied identity field or signal.aborted is ordinary data.
            if (executionMember || type && containsExecutionValue(type)) { captured = true; return; }
            for (const input of inputs.get(item) ?? []) {
                if (input.element !== undefined && selected.length && selected[0] !== "*" && input.element !== "*" && selected[0] !== input.element) continue;
                visit(input.node, [...input.path, ...(input.element !== undefined ? selected.slice(1) : selected)]);
                if (captured) return;
            }
            if (ts.isIdentifier(item)) { const target = declaration(item); if (target && target !== item) visit(target, selected); return; }
            if (ts.isPropertyAccessExpression(item) || ts.isElementAccessExpression(item)) {
                const name = ts.isPropertyAccessExpression(item) ? item.name.text : memberKey(item.argumentExpression, true);
                visit(item.expression, [name, ...selected]);
                return;
            }
            if (ts.isCallExpression(item)) {
                const callee = unwrap(item.expression);
                const symbol = ts.isPropertyAccessExpression(callee) ? checker.getSymbolAtLocation(callee.name) :
                    ts.isElementAccessExpression(callee) ? checker.getTypeAtLocation(callee.expression).getProperty(memberKey(callee.argumentExpression, true)) : undefined;
                // Native bind retains its receiver and every bound argument even
                // when the resulting callback returns only data.
                if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && symbol?.name === "bind" &&
                    symbol.declarations?.some(site => program.isSourceFileDefaultLibrary(site.getSourceFile()))) {
                    visit(callee.expression);
                    item.arguments.forEach(argument => visit(argument));
                }
                for (const input of arrayReturnInputs(item, selected)) visit(input.node, input.path);
                return; // Other calls contribute their indexed local return values above.
            }
            if (ts.isObjectLiteralExpression(item)) {
                for (const property of item.properties) {
                    if (ts.isSpreadAssignment(property)) visit(property.expression, selected);
                    else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
                        const name = memberKey(property.name);
                        if (!selected.length || selected[0] === "*" || name === "*" || name === selected[0]) {
                            const result = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : property;
                            visit(result, selected[0] === "*" ? [] : selected.slice(1));
                        }
                    }
                }
                return;
            }
            if (ts.isArrayLiteralExpression(item)) {
                const spread = item.elements.some(ts.isSpreadElement);
                item.elements.forEach((element, index) => {
                    if (!ts.isOmittedExpression(element) && (!selected.length || selected[0] === "*" || spread || selected[0] === String(index))) {
                        visit(ts.isSpreadElement(element) ? element.expression : element, spread || selected[0] === "*" ? [] : selected.slice(1));
                    }
                });
                return;
            }
            if (isFunction(item)) {
                if (selected.length) return;
                const inspect = (child: ts.Node) => {
                    if (ts.isTypeNode(child)) return;
                    if (ts.isIdentifier(child) && !ts.isTypeNode(child.parent)) {
                        const target = declaration(child);
                        if (target && target.getSourceFile() === item.getSourceFile() &&
                            !(target.pos >= item.pos && target.end <= item.end)) {
                            visit(child);
                        }
                    }
                    if (!captured) ts.forEachChild(child, inspect);
                };
                inspect(item);
            } else if (!captured && !ts.isVariableDeclaration(item) && !ts.isParameter(item) && !ts.isBindingElement(item)) {
                ts.forEachChild(item, child => { visit(child, selected); });
            }
        }
        visit(node, path);
        return captured;
    }

    const diagnostics: ArchitectureDiagnostic[] = [];
    const checked = new Set<ts.Node>();
    const operations = new Set<ts.Node>();
    const applicationScopes = new Set<ts.Node>();
    const factoryReturns = new Set<ts.Node>();
    const roleCache = new Map<string, RoleSource>();
    const dataCache = new Map<ts.Type, boolean>();
    const role = (node: ts.Node) => {
        const file = node.getSourceFile().fileName;
        let entry = roleCache.get(file);
        if (!entry) { entry = applicationRole(apiDirectory, file); roleCache.set(file, entry); }
        return entry;
    };
    const report = (node: ts.Node, code: ArchitectureDiagnostic["code"], message: string) =>
        diagnostics.push({ code, file: node.getSourceFile(), start: node.getStart(), length: node.getWidth(), message });
    const isFunction = (node: ts.Node): node is FunctionBody => ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

    function reflectionApi(node: ts.Expression): boolean {
        const symbol = checker.getTypeAtLocation(node).getSymbol();
        return !!symbol && ["ObjectConstructor", "Reflect"].includes(symbol.name) &&
            !!symbol.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    }

    function unwrap(node: ts.Node): ts.Node {
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
        return node;
    }
    function value(node: ts.Node, seen = new Set<ts.Node>()): ts.Node {
        node = unwrap(node);
        if (seen.has(node)) return node;
        seen.add(node);
        if (ts.isVariableDeclaration(node) && node.initializer && ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) return value(node.initializer, seen);
        if (ts.isPropertyAssignment(node)) return value(node.initializer, seen);
        const found = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node) :
            ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node) : undefined;
        const declaration = found && declarationOf(checker, originalSymbol(checker, found));
        return declaration && declaration !== node ? value(declaration, seen) : node;
    }
    function returns(fn: FunctionBody): ts.Expression[] {
        if (!fn.body) return [];
        const branches = (expression: ts.Expression): ts.Expression[] => {
            const node = unwrap(expression);
            return ts.isConditionalExpression(node) ? [...branches(node.whenTrue), ...branches(node.whenFalse)] : [expression];
        };
        if (!ts.isBlock(fn.body)) return branches(fn.body);
        const result: ts.Expression[] = [];
        function visit(node: ts.Node) {
            if (ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node) && node.expression) result.push(...branches(node.expression));
            else ts.forEachChild(node, visit);
        }
        ts.forEachChild(fn.body, visit);
        return result;
    }
    function data(type: ts.Type, seen = new Set<ts.Type>()): boolean {
        const cached = dataCache.get(type);
        if (cached !== undefined) return cached;
        const root = !seen.size;
        const result = dataShape(type, seen);
        // Cache complete root traversals only. A recursive back edge is provisional.
        if (root) dataCache.set(type, result);
        return result;
    }
    function dataShape(type: ts.Type, seen: Set<ts.Type>): boolean {
        if (seen.has(type)) return true;
        if (seen.size > 2048) return false;
        seen.add(type);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return false;
        if (type.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(type);
            return !!constraint && data(constraint, seen);
        }
        if (type.isUnionOrIntersection()) return type.types.every(part => data(part, seen));
        if (!(type.flags & ts.TypeFlags.Object)) return true;
        if (type.getCallSignatures().length || type.getConstructSignatures().length) return false;
        const reference = type as ts.TypeReference;
        const builtinContainer = ["Array", "ReadonlyArray", "Promise", "PromiseLike"].includes(type.getSymbol()?.name ?? "") &&
            type.getSymbol()?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
        if (reference.target?.objectFlags & ts.ObjectFlags.Tuple || builtinContainer) return checker.getTypeArguments(reference).every(part => data(part, seen));
        return checker.getIndexInfosOfType(type).every(info => data(info.type, seen)) && type.getProperties().every(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && data(checker.getTypeOfSymbolAtLocation(property, declaration), seen);
        });
    }
    function dependency(type: ts.Type, owner: RoleSource, seen = new Set<ts.Type>()): boolean {
        if (data(type)) return true;
        if (containsExecutionValue(type)) return false;
        if (seen.has(type)) return true;
        if (seen.size > 2048) return false;
        seen.add(type);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
        if (type.isUnionOrIntersection()) return type.types.every(part => dependency(part, owner, seen));
        const allowed = (node: ts.Node) => {
            const source = role(node);
            return source.role === "port" && source.module === owner.module || source.role === "facade" &&
                (isFunction(node) && !!node.body || ts.isPropertyAssignment(node) && isFunction(value(node)));
        };
        if (type.getCallSignatures().length) return type.getCallSignatures().every(signature => !!signature.declaration && allowed(signature.declaration));
        return type.getProperties().length > 0 && type.getProperties().every(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && (allowed(declaration) || dependency(checker.getTypeOfSymbolAtLocation(property, declaration), owner, seen));
        });
    }
    function serviceType(type: ts.Type, seen = new Set<ts.Type>()): boolean {
        if (seen.has(type) || data(type)) return false;
        seen.add(type);
        if (type.isUnionOrIntersection()) return type.types.some(part => serviceType(part, seen));
        if (type.getCallSignatures().some(signature => signature.declaration && role(signature.declaration).role === "service")) return true;
        return type.getProperties().some(property => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            return !!declaration && serviceType(checker.getTypeOfSymbolAtLocation(property, declaration), seen);
        });
    }
    function operation(fn: FunctionBody) {
        if (checked.has(fn)) return;
        checked.add(fn);
        operations.add(fn);
        for (const [index, parameter] of fn.parameters.entries()) {
            if (index === 0 && !parameter.dotDotDotToken && executionContext(checker.getTypeAtLocation(parameter))) continue;
            if (index === 0 && !parameter.dotDotDotToken && role(fn).role === "execution" &&
                applicationSymbol && checker.getTypeAtLocation(parameter).aliasSymbol === applicationSymbol) continue;
            if (!data(checker.getTypeAtLocation(parameter))) report(parameter, "BORING112", "Public operations accept data, with only an exact Core ExecutionContext allowed as the first parameter; not other callable capabilities, any or unknown. Inject typed ports into the facade factory.");
        }
        const signature = checker.getSignatureFromDeclaration(fn);
        const output = signature?.getReturnType();
        if (output && !data(output)) report(fn, "BORING112", "Public operations return data, not services, adapters, callbacks, any or unknown.");
        // Check the actual expressions too: a broad return annotation must not hide a capability.
        for (const expression of returns(fn)) {
            const actual = checker.getTypeAtLocation(value(expression));
            if (actual && !data(actual)) report(expression, "BORING112", "This return exposes a callable or unchecked value. Return a data result from the public operation.");
        }
    }
    function boundary(fn: FunctionBody) {
        if (!fn.body || checked.has(fn)) return;
        const expressions = returns(fn);
        const objects = expressions.map(expression => value(expression));
        const factory = objects.length > 0 && objects.every(object => ts.isObjectLiteralExpression(object) &&
            (!object.properties.length || object.properties.some(property => ts.isMethodDeclaration(property) || isFunction(value(property)))));
        if (!factory) { operation(fn); return; }
        checked.add(fn);
        applicationScopes.add(fn);
        for (const expression of expressions) factoryReturns.add(expression);
        function markReturns(node: ts.Node) {
            if (ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node) && node.expression) factoryReturns.add(node.expression);
            else ts.forEachChild(node, markReturns);
        }
        if (fn.body) ts.forEachChild(fn.body, markReturns);
        for (const parameter of fn.parameters) {
            if (!dependency(checker.getTypeAtLocation(parameter), role(fn))) report(parameter, "BORING112", "Facade factories receive data, own typed ports or public facades. Define effect contracts in ports/.");
        }
        for (const object of objects as ts.ObjectLiteralExpression[]) {
            for (const property of object.properties) {
                const target = value(property);
                const owner = role(target);
                const here = role(fn);
                if (!isFunction(target) || !target.body || owner.role !== here.role || owner.module !== here.module ||
                    ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name)) {
                    report(property, "BORING112", "Factory results contain named operations defined in this facade (or page), never raw services, ports, spreads or getters.");
                } else operation(target);
            }
        }
    }
    function exposed(node: ts.Node): boolean {
        // Use the instantiated value type first: a property of schema output can
        // otherwise trace back to its Zod declaration rather than its data value.
        // Conversion checks below still reject capability-erasing annotations.
        if (data(checker.getTypeAtLocation(unwrap(node)))) return true;
        const target = value(node);
        if (ts.isCallExpression(target)) {
            const callee = value(target.expression);
            return isFunction(callee) && ["facade", "page"].includes(role(callee).role);
        }
        if (isFunction(target)) {
            const signature = checker.getSignatureFromDeclaration(target);
            return ["facade", "page"].includes(role(target).role) && !!signature && data(signature.getReturnType());
        }
        if (ts.isVariableDeclaration(target)) return false;
        return data(checker.getTypeAtLocation(unwrap(target)));
    }
    function publicCapability(type: ts.Type): boolean {
        const owned = (value: ts.Type) => value.getCallSignatures().some(signature =>
            signature.declaration && ["facade", "page"].includes(role(signature.declaration).role));
        if (owned(type)) return true;
        return type.getProperties().some(property => {
            const site = property.valueDeclaration ?? property.declarations?.[0];
            return !!site && owned(checker.getTypeOfSymbolAtLocation(property, site));
        });
    }
    function servicesAccess(node: ts.Node, seen = new Set<ts.Node>()): boolean {
        node = unwrap(node);
        if (seen.has(node)) return false;
        seen.add(node);
        if (ts.isPropertyAccessExpression(node)) return node.name.text === "services" || servicesAccess(node.expression, seen);
        if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "services" || servicesAccess(node.expression, seen);
        if (ts.isIdentifier(node)) {
            const target = declaration(node);
            if (target && ts.isVariableDeclaration(target) && target.initializer) return servicesAccess(target.initializer, seen);
        }
        return false;
    }
    function callableValue(type: ts.Type, seen = new Set<ts.Type>()): boolean {
        if (seen.has(type) || data(type) || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
        if (seen.size > 2048) return true;
        seen.add(type);
        if (type.getCallSignatures().length || type.getConstructSignatures().length) return true;
        if (type.isUnionOrIntersection()) return type.types.some(part => callableValue(part, seen));
        return type.getProperties().some(property => {
            const site = property.valueDeclaration ?? property.declarations?.[0];
            return !!site && callableValue(checker.getTypeOfSymbolAtLocation(property, site), seen);
        });
    }
    function commonJsDeclaration(target: ts.Node): boolean {
        if (enclosingFunction(target)) return false;
        if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
            const base = unwrap(target.expression);
            const root = ts.isPropertyAccessExpression(base) && base.name.text === "exports" ? base.expression : base;
            if (!ts.isIdentifier(root) || !["exports", "module"].includes(root.text)) return false;
            return !checker.getSymbolAtLocation(root)?.declarations?.some(site =>
                !site.getSourceFile().isDeclarationFile && (ts.isVariableDeclaration(site) || ts.isParameter(site) || ts.isBindingElement(site)));
        }
        return false;
    }
    function capabilityMutation(target: ts.PropertyAccessExpression | ts.ElementAccessExpression, owner: RoleSource): boolean {
        const base = checker.getTypeAtLocation(target.expression);
        if (["facade", "page", "setup", "job", "schedule", "event", "command"].includes(owner.role)) return !data(base);
        // HTTP keeps its mutable payload/response data and supported CommonJS
        // declarations. Callable slots remain immutable even after structural typing.
        return ["endpoint", "hook", "execution"].includes(owner.role) && (publicCapability(base) || servicesAccess(target.expression) ||
            !commonJsDeclaration(target) && callableValue(checker.getTypeAtLocation(target)));
    }
    function setup(fn: FunctionBody) {
        applicationScopes.add(fn);
        if (fn === setupBindings.setup && setupBindings.parameter && !setupBindings.parameterContract) {
            report(setupBindings.parameter, "BORING113", "Preserve the generated/Core SetupContext type on the setup parameter. Any, unknown and foreign structural substitutes hide mandatory setup bindings from checks and inspection.");
        }
        for (const expression of returns(fn)) {
            exposureObject(expression);
        }
    }
    function exposureObject(expression: ts.Expression) {
        const object = value(expression);
        if (!ts.isObjectLiteralExpression(object)) {
            report(expression, "BORING113", "Setup returns an explicit object of public facade/page operations and data.");
            return;
        }
        for (const property of object.properties) {
            if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) ||
                ts.isComputedPropertyName(property.name) || !exposed(property)) {
                report(property, "BORING113", "Setup may expose only traced public facade/page operations and data. Inject raw adapters into facade factories; do not expose them or inline wrappers through ctx.services.");
            }
        }
    }
    function setupSetter(type: ts.Type): "set" | "assign" | undefined {
        const method = setupBindings.method(type);
        return method === "set" || method === "assign" ? method : undefined;
    }
    function operationalBinding(type: ts.Type): "publications" | "observability" | "readiness" | undefined {
        const method = setupBindings.method(type);
        return method === "publications" || method === "observability" || method === "readiness" ? method : undefined;
    }
    type CapabilityLoss = "data" | "setter" | undefined;
    interface ConversionState { active: Map<ts.Type, Set<ts.Type>>; remaining: number; }
    function capabilityLoss(actual: ts.Type, expected: ts.Type, seen: ConversionState = { active: new Map(), remaining: 2048 }): CapabilityLoss {
        if (actual === expected || data(actual) || seen.active.get(actual)?.has(expected)) return;
        if (--seen.remaining < 0) return "data";
        const targets = seen.active.get(actual) ?? new Set<ts.Type>();
        targets.add(expected);
        seen.active.set(actual, targets);
        // Back edges are provisional, not cached successes for a later union branch.
        try { return compareCapabilities(actual, expected, seen); }
        finally { targets.delete(expected); }
    }
    function promiseValue(type: ts.Type): ts.Type | undefined {
        const symbol = type.getSymbol();
        return symbol && ["Promise", "PromiseLike"].includes(symbol.name) && symbol.declarations?.some(declaration =>
            program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
    }
    function zodSchema(type: ts.Type): boolean {
        return !!type.getProperty("_def")?.declarations?.some(declaration =>
            /[/\\]node_modules[/\\]zod[/\\]/.test(declaration.getSourceFile().fileName));
    }
    function arrayType(type: ts.Type): boolean {
        return !!((type as ts.TypeReference).target?.objectFlags & ts.ObjectFlags.Tuple) ||
            ["Array", "ReadonlyArray"].includes(type.getSymbol()?.name ?? "") && !!type.getSymbol()?.declarations?.some(declaration =>
                program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    }
    function compareCapabilities(actual: ts.Type, expected: ts.Type, seen: ConversionState): CapabilityLoss {
        if (data(expected)) return "data";
        // The nominal Core context has invariant framework capabilities. Compare
        // only application identity data, not AbortSignal's recursive event APIs.
        if (coreExecutionType(actual) && coreExecutionType(expected)) {
            const source = actual.getProperty("identity")!;
            const target = expected.getProperty("identity")!;
            return capabilityLoss(checker.getTypeOfSymbolAtLocation(source, source.valueDeclaration ?? source.declarations![0]),
                checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration ?? target.declarations![0]), seen);
        }
        // Both sides retain the supported Zod capability. Its recursive SDK internals
        // are not application data fields and must not exhaust the comparison budget.
        if (zodSchema(actual) && zodSchema(expected)) return;
        if (actual.isUnion()) {
            for (const part of actual.types) { const loss = capabilityLoss(part, expected, seen); if (loss) return loss; }
            return;
        }
        if (expected.isUnion()) {
            const losses = expected.types.map(part => capabilityLoss(actual, part, seen));
            return losses.every(Boolean) ? losses.find(loss => loss === "setter") ?? "data" : undefined;
        }
        if (expected.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(expected);
            return constraint ? capabilityLoss(actual, constraint, seen) : undefined;
        }
        const setter = setupSetter(actual);
        if (setter && setupSetter(expected) !== setter) return "setter";
        if (expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
        const promisedSource = promiseValue(actual);
        const promisedTarget = promiseValue(expected);
        if (promisedSource && promisedTarget) return capabilityLoss(promisedSource, promisedTarget, seen);
        for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
            const target = checker.getIndexTypeOfType(expected, kind);
            if (!target) continue;
            const source = checker.getIndexTypeOfType(actual, kind);
            if (source) { const loss = capabilityLoss(source, target, seen); if (loss) return loss; }
            for (const property of actual.getProperties()) {
                if (kind === ts.IndexKind.Number && !/^\d+$/.test(property.name)) continue;
                const declaration = property.valueDeclaration ?? property.declarations?.[0];
                if (declaration) { const loss = capabilityLoss(checker.getTypeOfSymbolAtLocation(property, declaration), target, seen); if (loss) return loss; }
            }
        }
        for (const property of expected.getProperties()) {
            // Array operations are shared library machinery; compare indexed slots,
            // not a recursive graph of concat/map/etc. signatures.
            if (arrayType(actual) && arrayType(expected) && !/^\d+$/.test(property.name)) continue;
            const source = actual.getProperty(property.name);
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            const sourceDeclaration = source?.valueDeclaration ?? source?.declarations?.[0];
            if (!declaration) continue;
            const sourceType = source && sourceDeclaration ? checker.getTypeOfSymbolAtLocation(source, sourceDeclaration) :
                checker.getIndexTypeOfType(actual, /^\d+$/.test(property.name) ? ts.IndexKind.Number : ts.IndexKind.String);
            if (sourceType) {
                const loss = capabilityLoss(sourceType, checker.getTypeOfSymbolAtLocation(property, declaration), seen);
                if (loss) return loss;
            }
        }
        // Callback values flow out through results and in through parameters.
        for (const target of expected.getCallSignatures()) {
            for (const source of actual.getCallSignatures()) {
                if (!(target.getReturnType().flags & ts.TypeFlags.Void)) {
                    const loss = capabilityLoss(source.getReturnType(), target.getReturnType(), seen);
                    if (loss) return loss;
                }
                for (const [index, parameter] of source.getParameters().entries()) {
                    const incoming = target.getParameters()[index];
                    const destination = parameter.valueDeclaration ?? parameter.declarations?.[0];
                    const origin = incoming?.valueDeclaration ?? incoming?.declarations?.[0];
                    if (!incoming || !destination || !origin) continue;
                    const input = checker.getTypeOfSymbolAtLocation(incoming, origin);
                    // The instantiated signature supplies unconstrained generic inputs.
                    if (input.flags & ts.TypeFlags.TypeParameter && !checker.getBaseConstraintOfType(input)) continue;
                    const loss = capabilityLoss(input, checker.getTypeOfSymbolAtLocation(parameter, destination), seen);
                    if (loss) return loss;
                }
            }
        }
    }
    function checkConversion(node: ts.Node, actual: ts.Type, expected: ts.Type) {
        if (!(actual.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) &&
            containsExecutionValue(expected) && !containsExecutionValue(actual)) {
            report(node, "BORING115", "A type conversion cannot create an ExecutionContext. Forward the framework-created context from HTTP or application.execute.");
        }
        if (setupBindings.context(actual) && !setupBindings.context(expected)) {
            report(node, "BORING113", "Do not erase or structurally replace SetupContext. Keep its Core type and call setup bindings directly on the setup parameter.");
        }
        const loss = capabilityLoss(actual, expected);
        if (loss) report(node, loss === "setter" ? "BORING113" : "BORING112", loss === "setter"
            ? "Do not hide setup setters behind another callable contract. Preserve SetupContext and call its setters directly."
            : "A type conversion must not erase a callable capability into data, including nested properties, callbacks and tuple elements. Keep typed ports explicit.");
    }
    function setterPattern(pattern: ts.Node, type: ts.Type) {
        const object = ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern);
        const array = ts.isArrayBindingPattern(pattern) || ts.isArrayLiteralExpression(pattern);
        if (!object && !array) return;
        const entries = ts.isObjectLiteralExpression(pattern) ? pattern.properties : pattern.elements;
        entries.forEach((entry, index) => {
            if (ts.isOmittedExpression(entry) || ts.isSpreadAssignment(entry) || ts.isSpreadElement(entry) ||
                ts.isBindingElement(entry) && entry.dotDotDotToken) return;
            const target = ts.isBindingElement(entry) ? entry.name : ts.isPropertyAssignment(entry) ? entry.initializer : entry;
            const name = ts.isBindingElement(entry) ? entry.propertyName ?? entry.name :
                ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined;
            const key = array ? String(index) : name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text :
                name && ts.isComputedPropertyName(name) ? checker.getTypeAtLocation(name.expression) : undefined;
            const property = typeof key === "string" ? type.getProperty(key) : key?.isStringLiteral() ? type.getProperty(key.value) : undefined;
            const member = property ? checker.getTypeOfSymbolAtLocation(property, entry) :
                array ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) : undefined;
            if (!member) return;
            const setter = setupSetter(member);
            const binding = operationalBinding(member);
            if (setter) report(entry, "BORING113", "Do not destructure or alias setup setters. Call ctx.set or ctx.assign directly with approved operations or data.");
            else if (binding) report(entry, "BORING113", `Do not destructure or alias ctx.${binding}. Call the operational setup binding directly so inspection and checks share one static model.`);
            else setterPattern(target, member);
        });
    }
    function checkArguments(node: ts.CallExpression | ts.NewExpression) {
        const signature = checker.getResolvedSignature(node);
        if (!signature) return;
        const parameters = signature.getParameters();
        for (const [index, argument] of (node.arguments ?? []).entries()) {
            const parameter = parameters[Math.min(index, parameters.length - 1)];
            if (!parameter) continue;
            const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
            if (index >= parameters.length && !(declaration && ts.isParameter(declaration) && declaration.dotDotDotToken)) continue;
            // Check instantiated slots and declared constraints, including each rest-tuple position.
            const actual = checker.getTypeAtLocation(unwrap(argument));
            const targets = [checker.getTypeOfSymbolAtLocation(parameter, node), ...(declaration ? [checker.getTypeAtLocation(declaration)] : [])];
            if (data(actual) && !targets.some(coreExecutionType)) continue;
            for (let target of targets) {
                if (declaration && ts.isParameter(declaration) && declaration.dotDotDotToken && !ts.isSpreadElement(argument)) {
                    const property = target.getProperty(String(index - parameters.length + 1));
                    target = property ? checker.getTypeOfSymbolAtLocation(property, node) : checker.getIndexTypeOfType(target, ts.IndexKind.Number) ?? target;
                }
                const count = diagnostics.length;
                checkConversion(argument, actual, target);
                if (diagnostics.length !== count) break;
            }
        }
    }
    function errorClass(node: ts.Node): boolean {
        if (!ts.isClassDeclaration(node)) return false;
        const seen = new Set<ts.Type>();
        function error(type: ts.Type): boolean {
            if (seen.has(type) || seen.size > 32) return false;
            seen.add(type);
            if (type.getSymbol()?.name === "Error" && type.getSymbol()?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return true;
            return !!(type.flags & ts.TypeFlags.Object) && checker.getBaseTypes(type as ts.InterfaceType)?.some(error);
        }
        const instance = checker.getTypeAtLocation(node);
        return error(instance) && data(instance) && node.members.every(member => ts.isConstructorDeclaration(member) ||
            data(checker.getTypeAtLocation(member)) && (!ts.isPropertyDeclaration(member) || !member.initializer ||
                data(checker.getTypeAtLocation(unwrap(member.initializer)))));
    }
    const calls: { node: ts.CallExpression | ts.NewExpression; callee: ts.Expression; args: readonly ts.Expression[]; applied?: ts.Expression;
        projected?: (ValueInput | undefined)[]; thisArg?: ts.Expression; nativeResult?: "element" | "flat" | "reduce" | "none"; resolved: Set<string> }[] = [];
    for (const source of sources) {
        function collect(node: ts.Node) {
            if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) flow(node, node.initializer);
            if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && !ts.isIdentifier(node.name)) {
                assignmentTargets(node.name, node, (target, source, path) => flow(declaration(target), source, path));
            }
            assignments(node, (target, source, path) => {
                const site = declaration(target);
                flow(site, source, path);
                if (site && ts.isSetAccessorDeclaration(site)) flow(site.parameters[0], source, path);
                if (ts.isElementAccessExpression(target) && arrayType(checker.getTypeAtLocation(target.expression))) {
                    arrayWrites.push({ site: target, receiver: target.expression, value: { node: source, path, element: memberKey(target.argumentExpression, true) } });
                }
            });
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const native = nativeArrayCall(node, message => report(node, "BORING115", message));
                if (native && ts.isCallExpression(node)) {
                    const { method, receiver, args } = native;
                    const callback = args[method === "from" ? 1 : 0];
                    if (callback && ["map", "flatMap", "from", "forEach", "filter", "find", "findLast", "findIndex", "findLastIndex", "every", "some", "sort", "reduce", "reduceRight"].includes(method)) {
                        const element: ValueInput = { node: receiver, path: ["*"] };
                        const reduce = method === "reduce" || method === "reduceRight";
                        // An empty reduction returns its initial value without
                        // invoking the callback; one element can also be returned as-is.
                        if (reduce) flow(node, args[1] ?? receiver, args[1] ? [] : ["*"]);
                        const projected = reduce ? [args[1] ? { node: args[1], path: [] } : element, element, undefined, { node: receiver, path: [] }] :
                            method === "sort" ? [element, element] : method === "from" ? [element, undefined] : [element, undefined, { node: receiver, path: [] }];
                        const thisArg = method === "from" ? args[2] : reduce || method === "sort" ? undefined : args[1];
                        calls.push({ node, callee: callback, args: [], projected, thisArg, nativeResult: reduce ? "reduce" : method === "flatMap" ? "flat" :
                            ["map", "from"].includes(method) ? "element" : "none", resolved: new Set() });
                    }
                }
                if (native && ["reverse", "sort", "copyWithin", "shift", "unshift", "splice"].includes(native.method)) arrayReorders.push({ site: node, receiver: native.receiver });
                if (native && ["push", "unshift", "splice", "fill"].includes(native.method)) {
                    const arguments_ = native.method === "fill" ? native.args.slice(0, 1) : native.args.slice(native.method === "splice" ? 2 : 0);
                    for (const argument of arguments_ ?? []) arrayWrites.push({ site: node, receiver: native.receiver,
                        value: ts.isSpreadElement(argument) ? { node: argument.expression, path: ["*"], element: "*" } : { node: argument, path: [], element: "*" } });
                }
                const callee = unwrap(node.expression) as ts.Expression;
                const signature = checker.getResolvedSignature(node)?.declaration;
                const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? memberKey(callee.argumentExpression, true) : undefined;
                if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && ["call", "apply"].includes(method ?? "") &&
                    signature && program.isSourceFileDefaultLibrary(signature.getSourceFile()) && checker.getTypeAtLocation(callee.expression).getCallSignatures().length) {
                    calls.push({ node, callee: callee.expression, args: method === "call" ? node.arguments?.slice(1) ?? [] : [],
                        applied: method === "apply" ? node.arguments?.[1] : undefined, resolved: new Set() });
                } else {
                    calls.push({ node, callee, args: node.arguments ?? [], resolved: new Set() });
                }
            }
            ts.forEachChild(node, collect);
        }
        if (!source.isDeclarationFile) collect(source);
    }
    // Calls, callback results, writes and permutations form one graph. A write
    // can expose a callable, whose result can in turn expose more array storage.
    let changed = true;
    const flowFailures = new Set<ts.Node>();
    const exceeded = (site: ts.Node, message: string) => {
        if (!flowFailures.has(site)) { flowFailures.add(site); report(site, "BORING115", message); }
    };
    const mutations: { site: ts.Node; receiver: ts.Node; value?: ValueInput }[] = [...arrayReorders, ...arrayWrites];
    for (let round = 0; changed && round < 64; round++) {
        changed = false;
        for (const call of calls) {
            const result = localImplementations(call.node, call.callee);
            if (result.exhausted) exceeded(call.node, "Local callable flow exceeds the supported analysis bound. Keep execution-local helpers explicit.");
            for (const { fn, boundArgs, thisArg } of result.implementations) {
                const key = `${fn.getSourceFile().fileName}:${fn.pos}:${fn.end}:${boundArgs.map(arg => `${arg.getSourceFile().fileName}:${arg.pos}:${arg.end}`).join(",")}:${thisArg?.getSourceFile().fileName ?? ""}:${thisArg?.pos ?? ""}`;
                if (call.resolved.has(key)) continue;
                call.resolved.add(key);
                bindArguments(fn, [...boundArgs, ...call.args], call.applied, call.projected);
                bindThis(fn, thisArg ?? call.thisArg);
                if (isFunction(fn) && call.nativeResult !== "none") for (const result of returns(fn)) {
                    if (call.nativeResult === "reduce") bindArguments(fn, [], undefined, [{ node: result, path: [] }]);
                    if (data(checker.getTypeAtLocation(call.node))) continue;
                    if (call.nativeResult === "element" || call.nativeResult === "flat") {
                        let contents = arrayContents.get(call.node);
                        if (!contents) arrayContents.set(call.node, contents = []);
                        const type = checker.getTypeAtLocation(result);
                        const parts = type.isUnion() ? type.types : [type];
                        if (call.nativeResult === "element" || parts.some(part => !arrayType(part))) contents.push({ node: result, path: [], element: "*" });
                        if (call.nativeResult === "flat" && parts.some(arrayType)) contents.push({ node: result, path: ["*"], element: "*" });
                    } else flow(call.node, result);
                }
                changed = true;
            }
        }
        for (const mutation of mutations) {
            const storage = arrayStorage(mutation.receiver);
            if (storage.exhausted) exceeded(mutation.site, "Array alias flow exceeds the supported analysis bound. Keep execution-local storage explicit.");
            for (const root of storage.roots) {
                if (!mutation.value) {
                    if (!reorderedArrays.has(root)) { reorderedArrays.add(root); changed = true; }
                    continue;
                }
                let contents = arrayContents.get(root);
                if (!contents) arrayContents.set(root, contents = []);
                if (!contents.includes(mutation.value)) { contents.push(mutation.value); changed = true; }
            }
        }
    }
    if (changed) for (const call of calls) exceeded(call.node, "Local callable flow exceeds the supported analysis bound. Keep execution-local helpers explicit.");
    if (changed) for (const mutation of mutations) exceeded(mutation.site, "Array alias flow exceeds the supported analysis bound. Keep execution-local storage explicit.");
    for (const source of sources) {
        const owner = role(source);
        if (!["facade", "page", "setup", "config", "execution", "job", "schedule", "event", "command", "service", "port", "schemas", "endpoint", "hook"].includes(owner.role)) continue;
        if (owner.role === "config") {
            for (const symbol of moduleExports(checker, source)) {
                if (isTypeOnlyExport(checker, symbol)) continue;
                const site = declarationOf(checker, symbol) ?? source;
                const type = symbolType(checker, symbol, source);
                const output = type.getProperty("_output");
                if (symbol.name === "schema" && zodSchema(type) && output && data(checker.getTypeOfSymbolAtLocation(output, site))) continue;
                if (symbol.name === "load" && isFunction(value(site)) && type.getCallSignatures().every(signature => data(signature.getReturnType()))) continue;
                report(site, "BORING115", "Configuration exports only a data-producing Zod schema and load(env) returning data. Dependencies belong in setup.");
            }
        }
        if (["job", "schedule", "event", "command"].includes(owner.role)) {
            const kind = owner.role;
            const code = kind === "job" ? "BORING116" : "BORING117";
            const exports = moduleExports(checker, source);
            const keys = kind === "schedule" ? ["payload", "input", "version", "timing", "policy", "handler"] : kind === "event" ? ["payload", "event", "version", "policy", "handler"] : kind === "command" ? ["input", "output", "timeoutMs", "handler"] : ["payload", "version", "policy", "handler"];
            for (const name of keys) if (!exports.some(symbol => symbol.name === name)) report(source, code, `${kind} declaration requires ${name}. Use generated handler types.`);
            const unsupported = Symbol();
            let literalBudget = 0;
            const literal = (node: ts.Node, seen = new Set<ts.Node>()): any => {
                const target = value(node);
                if (++literalBudget > 2048 || seen.has(target)) return unsupported;
                const nested = new Set([...seen, target]);
                if (ts.isNumericLiteral(target)) return Number.isFinite(Number(target.text)) ? Number(target.text) : unsupported;
                if (ts.isPrefixUnaryExpression(target) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(target.operator) && ts.isNumericLiteral(unwrap(target.operand))) {
                    const number = (target.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * Number((unwrap(target.operand) as ts.NumericLiteral).text);
                    return Number.isFinite(number) ? number : unsupported;
                }
                if (ts.isStringLiteralLike(target)) return target.text;
                if (target.kind === ts.SyntaxKind.TrueKeyword) return true;
                if (target.kind === ts.SyntaxKind.FalseKeyword) return false;
                if (target.kind === ts.SyntaxKind.NullKeyword) return null;
                if (ts.isArrayLiteralExpression(target)) {
                    const items = target.elements.map(item => literal(item, nested));
                    return items.includes(unsupported) ? unsupported : items;
                }
                if (ts.isObjectLiteralExpression(target)) {
                    const object: Record<string, unknown> = Object.create(null);
                    for (const property of target.properties) {
                        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) return unsupported;
                        const key = property.name.text;
                        if (key in object || key === "__proto__") return unsupported;
                        object[key] = literal(property.initializer, nested);
                        if (object[key] === unsupported) return unsupported;
                    }
                    return object;
                }
                return unsupported;
            };
            const integer = (n: unknown, max = 2147483647) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max;
            for (const symbol of exports) {
                const site = declarationOf(checker, symbol) ?? source;
                const type = symbolType(checker, symbol, source);
                if (!keys.includes(symbol.name)) { report(site, code, `Unsupported ${kind} export: ${symbol.name}`); continue; }
                if ((symbol.name === "payload" || kind === "command" && ["input", "output"].includes(symbol.name)) && zodSchema(type)) {
                    if (["_input", "_output"].every(key => {
                        const property = type.getProperty(key);
                        return property && data(checker.getTypeOfSymbolAtLocation(property, site));
                    })) continue;
                }
                if (symbol.name === "handler") {
                    const fn = value(site);
                    if (isFunction(fn) && fn.getSourceFile() === source && fn.parameters.length === 1 && coreEntryContext(checker.getTypeAtLocation(fn.parameters[0]), kind) && type.getCallSignatures().every(signature => data(signature.getReturnType()))) continue;
                } else {
                    literalBudget = 0;
                    const constant = literal(site);
                    if (["version", "timeoutMs"].includes(symbol.name) && integer(constant)) continue;
                    if (symbol.name === "policy" && constant && typeof constant === "object" && Object.keys(constant).sort().join(",") === "maxAttempts,retryDelayMs,timeoutMs" && integer(constant.maxAttempts, 100) && integer(constant.retryDelayMs) && integer(constant.timeoutMs)) continue;
                    if (kind === "schedule" && symbol.name === "input" && constant !== unsupported && data(type)) continue;
                    if (kind === "schedule" && symbol.name === "timing" && constant !== unsupported) {
                        try { validateScheduleTiming(constant); continue; } catch { /* Emit a positioned static diagnostic. */ }
                    }
                    if (kind === "event" && symbol.name === "event" && constant && typeof constant === "object" && Object.keys(constant).sort().join(",") === "type,version" && typeof constant.type === "string" && /^[a-z][a-z0-9./-]*$/.test(constant.type) && integer(constant.version)) continue;
                }
                report(site, code, `${kind} exports require data-only Zod contracts, literal policy/metadata/input, and a local handler with its exact generated context.`);
            }
        }
        if (owner.role === "execution") {
            for (const symbol of moduleExports(checker, source)) {
                if (isTypeOnlyExport(checker, symbol)) continue;
                const site = declarationOf(checker, symbol) ?? source;
                const fn = value(site);
                if (symbol.name !== "default" && isFunction(fn) && fn.getSourceFile() === source) operation(fn);
                else report(site, "BORING115", "Controlled execution entries export named functions returning data, not registries or retained capabilities.");
            }
        }
        if (owner.role === "schemas") {
            for (const symbol of moduleExports(checker, source)) {
                if (isTypeOnlyExport(checker, symbol)) continue;
                const type = symbolType(checker, symbol, source);
                if (!zodSchema(type) && !data(type)) report(symbol.declarations?.[0] ?? source, "BORING112",
                    "Schemas export data, types and Zod schemas, not executable helpers or capability objects. Put business operations behind a facade.");
            }
        }
        if (owner.role === "port") {
            for (const statement of source.statements) {
                if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
                    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && typeOnlyDependency(statement))) {
                    report(statement, "BORING111", "Ports contain only type imports, interfaces, type aliases and type exports. Put implementations in infra/.");
                }
            }
        }
        if (owner.role === "service") {
            for (const symbol of moduleExports(checker, source)) {
                if (isTypeOnlyExport(checker, symbol)) continue;
                const type = symbolType(checker, symbol, source);
                const declaration = declarationOf(checker, symbol);
                if (!type.getCallSignatures().length && !data(type) && !(declaration && errorClass(value(declaration)))) {
                    report(symbol.declarations?.[0] ?? source, "BORING114", "Export service operations as named functions, not callable containers, service classes or unchecked values. Domain error classes may carry data but no methods.");
                }
            }
        }
        if (["facade", "page", "setup"].includes(owner.role)) {
            if (source.isDeclarationFile) report(source, "BORING112", "Public operation boundaries require an implementation, not an ambient declaration.");
            for (const symbol of moduleExports(checker, source)) {
                const declaration = declarationOf(checker, symbol);
                if (!declaration) continue;
                const declaredSite = symbol.declarations?.[0] ?? declaration;
                const site = declaredSite.getSourceFile() === source ? declaredSite :
                    source.statements.find(ts.isExportDeclaration) ?? source;
                if (isTypeOnlyExport(checker, symbol)) {
                    const original = originalSymbol(checker, symbol);
                    const type = original.flags & ts.SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(original) : symbolType(checker, original, declaration);
                    if (role(declaration).role === "service" || serviceType(type)) report(site, "BORING112", "Service types stay private. Publish data in schemas and dependency contracts in ports.");
                    continue;
                }
                const target = value(declaration);
                if (symbol.name === "default" || !isFunction(target) || role(target).role !== owner.role || role(target).module !== owner.module) {
                    report(site, owner.role === "setup" ? "BORING113" : "BORING112", "Export named functions owned by this facade/page. Re-export only same-role facade parts; service and adapter values stay private.");
                    continue;
                }
                if (owner.role === "setup") setup(target); else boundary(target);
            }
        }
        function visit(node: ts.Node) {
            if (["job", "schedule", "event", "command"].includes(owner.role) && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) {
                const symbol = checker.getSymbolAtLocation(node);
                const declaration = symbol && declarationOf(checker, originalSymbol(checker, symbol));
                if (declaration && declaration.getSourceFile().isDeclarationFile && /[\\/]core[\\/](?:index|lifecycle|setupContext)\.d\.ts$/.test(declaration.getSourceFile().fileName) &&
                    (ts.isClassDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isConstructorDeclaration(declaration))) {
                    report(node, "BORING116", "Trigger entries receive their context and injected facades. Application construction, execution admission and job binding belong to bootstrap/setup, not trigger entries.");
                }
            }
            if ((owner.role === "service" || owner.role === "schemas") && isFunction(node) && node.body) {
                const output = checker.getSignatureFromDeclaration(node)?.getReturnType();
                if (output) {
                    for (const expression of returns(node)) {
                        const actual = checker.getTypeAtLocation(value(expression));
                        checkConversion(expression, promiseValue(actual) ?? actual, promiseValue(output) ?? output);
                    }
                }
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) checkArguments(node);
            if (ts.isVariableDeclaration(node) && node.initializer && !ts.isIdentifier(node.name)) setterPattern(node.name, checker.getTypeAtLocation(node.initializer));
            if (ts.isParameter(node) && !ts.isIdentifier(node.name)) setterPattern(node.name, checker.getTypeAtLocation(node));
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) setterPattern(unwrap(node.left), checker.getTypeAtLocation(node.right));
            if (["facade", "page", "setup", "job", "schedule", "event", "command"].includes(owner.role) && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                let root: ts.Expression = node.left;
                while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
                if (ts.isIdentifier(root) && ["module", "exports"].includes(root.text)) {
                    const symbol = checker.getSymbolAtLocation(root);
                    if (!symbol?.declarations?.some(declaration => !declaration.getSourceFile().isDeclarationFile &&
                        (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isBindingElement(declaration)))) {
                        report(node, "BORING112", "Public facade/page/setup boundaries use named ES exports. CommonJS boundary exports are unsupported; literal CommonJS dependencies elsewhere remain checked.");
                    }
                }
            }
            if (["facade", "page", "setup", "job", "schedule", "event", "command"].includes(owner.role) && ts.isExportAssignment(node)) {
                report(node, "BORING112", "Public boundaries use named ES exports, not export assignments or default exports.");
            }
            if (["facade", "page", "setup", "config", "execution", "job", "schedule", "event", "command", "service", "schemas"].includes(owner.role) && ts.isVariableDeclaration(node) && node.initializer && node.type) {
                checkConversion(node, checker.getTypeAtLocation(unwrap(node.initializer)), checker.getTypeAtLocation(node));
            }
            if (["facade", "page"].includes(owner.role) && ts.isReturnStatement(node) && node.expression &&
                !factoryReturns.has(node.expression) && !data(checker.getTypeAtLocation(value(node.expression)))) {
                report(node, "BORING112", "Helpers cannot return hidden capabilities. Only an explicit facade factory exposes its own operation object.");
            }
            if (["facade", "page"].includes(owner.role) && ts.isArrowFunction(node) && !ts.isBlock(node.body) &&
                !checked.has(node) && !data(checker.getTypeAtLocation(value(node.body)))) {
                report(node, "BORING112", "Helpers cannot return hidden capabilities. Return data or expose explicit facade-owned operations.");
            }
            if (["facade", "page", "setup", "config", "execution", "job", "schedule", "event", "command", "service", "schemas"].includes(owner.role) && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                checkConversion(node, checker.getTypeAtLocation(unwrap(node.right)), checker.getTypeAtLocation(node.left));
            }
            if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
                const setter = setupSetter(checker.getTypeAtLocation(node));
                const binding = setupBindings.access(node);
                if (setter) {
                    const call = node.parent;
                    if (!ts.isCallExpression(call) || call.expression !== node) {
                        report(node, "BORING113", "Do not alias setup setters. Use explicit ctx.set or ctx.assign with approved public operations or data.");
                    } else if (setter === "assign" && call.arguments[0]) exposureObject(call.arguments[0]);
                    else if (!call.arguments[1] || !exposed(call.arguments[1])) {
                        report(call, "BORING113", "Imperative setup writes obey the same exposure contract: public facade/page operations or data, never raw adapters or wrappers.");
                    }
                } else if (binding && !binding.direct) {
                    report(node, "BORING113", `Call ctx.${binding.name}(...) directly on the setup parameter, using property access or a string-literal element access. Aliases, destructuring, computed keys, casts, call, apply and bind are unsupported so inspection and checks share one static model.`);
                }
            }
            if (ts.isBinaryExpression(node) || ts.isForOfStatement(node)) {
                const mutations = new Set<ts.Node>();
                const retained = new Set<ts.Node>();
                assignments(node, (target, source, path) => {
                    if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && capabilityMutation(target, owner) && !mutations.has(target)) {
                        mutations.add(target);
                        report(target, "BORING113", "Do not mutate capability objects or their exports. Compose explicit facade operations in setup.");
                    }
                    // Rebinding a local identifier does not mutate the shared value
                    // it previously referenced. Member writes must still follow aliases.
                    const shared = ts.isIdentifier(target) ? sharedBinding(declaration(target)) : sharedTarget(target);
                    if (shared && capturedExecution(source, path) && !retained.has(target)) {
                        retained.add(target);
                        report(target, "BORING115", "Do not retain execution capabilities or callbacks beyond their invocation.");
                    }
                });
            }
            if (["facade", "page", "setup", "job", "schedule", "event", "command"].includes(owner.role) && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
                reflectionApi(node.expression) &&
                ["assign", "defineProperty", "defineProperties", "setPrototypeOf", "set", "deleteProperty"].includes(ts.isPropertyAccessExpression(node) ? node.name.text :
                    ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "set")) {
                report(node, "BORING113", "Dynamic capability composition is unsupported. Use explicit operation objects and setup properties.");
            }
            if (["facade", "page", "setup", "job", "schedule", "event", "command"].includes(owner.role) && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
                node.initializer && reflectionApi(node.initializer)) {
                report(node, "BORING113", "Do not destructure reflection APIs at application boundaries. Use explicit operation objects.");
            }
            if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && containsExecutionValue(checker.getTypeAtLocation(node))) {
                let scope: ts.Node | undefined = node.parent;
                while (scope && !isFunction(scope)) scope = scope.parent;
                if (!scope || applicationScopes.has(scope)) report(node, "BORING115", "Execution context belongs to one invocation; do not retain it in module, facade factory, page factory or setup state.");
            }
            if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) && sharedTarget(node.expression.expression)) {
                const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isStringLiteralLike(node.expression.argumentExpression) ? node.expression.argumentExpression.text : "set";
                if (["push", "unshift", "splice", "fill", "set", "add"].includes(method) && node.arguments.some(argument => capturedExecution(argument))) report(node, "BORING115", "Do not store execution capabilities or capturing callbacks in application-lived collections.");
            }
            if (ts.isDeleteExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
                capabilityMutation(node.expression, owner)) {
                report(node, "BORING113", "Do not delete injected public operations.");
            }
            if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
                checkConversion(node, checker.getTypeAtLocation(unwrap(node.expression)), checker.getTypeAtLocation(node));
            }
            if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) &&
                !ts.isExportSpecifier(node.parent) && !ts.isTypeNode(node.parent)) {
                const symbol = checker.getSymbolAtLocation(node);
                const original = symbol && originalSymbol(checker, symbol);
                const declaration = original && declarationOf(checker, original);
                if (original && original === coreErrorSymbol && ["facade", "service"].includes(owner.role)) {
                    report(node, "BORING115", "Business operations throw ApplicationError or domain errors; HttpError belongs to HTTP entry points.");
                }
                if (declaration && !ts.isParameter(declaration) && role(declaration).role === "service" && symbolType(checker, original!, declaration).getCallSignatures().length) {
                    const defining = (ts.isFunctionDeclaration(node.parent) || ts.isVariableDeclaration(node.parent)) && node.parent.name === node;
                    const calling = ts.isCallExpression(node.parent) && node.parent.expression === node;
                    let caller: ts.Node | undefined = node.parent;
                    while (caller && !operations.has(caller)) caller = caller.parent;
                    if (!defining && !(calling && caller && owner.role === "facade" && owner.module === role(declaration).module)) {
                        report(node, "BORING114", "Only an operation in the owning facade calls a service. Do not invoke it during module loading/composition, alias, pass, return, re-export or call a peer service.");
                    }
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return diagnostics;
}
