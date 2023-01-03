export enum ApiFileType {
    handler = "handler",
    folder = "folder",
    input = "input",
    output = "output",
    unknown = "unknown",
    setup = "setup",
    notfound = "notfound",
    base = "base",
}

export type ApiFile = {
    type: ApiFileType;
    name: string;
    extension: string;
    path: string;
    meta?: any;
}


export class FileNode {
    parent: FileNode | undefined;
    nodes: FileNode[];
    file: ApiFile;
    depth: number;

    constructor(
        parent: FileNode | undefined,
        nodes: FileNode[],
        file: ApiFile,
        depth: number,
    ) {
        this.parent = parent;
        this.nodes = nodes;
        this.file = file;
        this.depth = depth;
        this.depth = depth;
    }
}