/// <reference types="node" />
import * as BS from "browser-sync";
import { Writable } from "stream";
export declare class Forestini {
    private frozen;
    private running;
    private taskNodes;
    readonly tmpRoot: string;
    readonly watchDebounce: number;
    constructor(opts?: {
        tmpRoot?: string;
        debounce?: number;
    });
    task(deps: TaskNode[], task: Task): TaskNode;
    freeze(): this;
    dotGraph(): string;
    clearDest(): Promise<void>;
    build(): Promise<void>;
    watch(): Promise<void>;
    private prepareTaskNodes;
    private runTaskNodes;
    private makeDependentsWaiting;
    private beginWatching;
    private assertFrozen;
    private assertNotFrozen;
    private assertNotRunning;
    private isRegisteredTask;
    private isRegisteredTaskNodes;
    private node2index;
    src(...args: Parameters<typeof src>): TaskNode;
    dest(deps: TaskNode[], ...args: Parameters<typeof dest>): TaskNode;
    exec(deps: TaskNode[], ...args: Parameters<typeof exec>): TaskNode;
    copy(deps: TaskNode[], ...args: Parameters<typeof copy>): TaskNode;
    cache(deps: TaskNode[], ...args: Parameters<typeof cache>): TaskNode;
    browserSync(deps: TaskNode[], ...args: Parameters<typeof browserSync>): TaskNode;
}
export interface TaskNode {
    then(task: Task): TaskNode;
    dest(...args: Parameters<typeof dest>): TaskNode;
    exec(...args: Parameters<typeof exec>): TaskNode;
    copy(...args: Parameters<typeof copy>): TaskNode;
    cache(...args: Parameters<typeof cache>): TaskNode;
    browserSync(...args: Parameters<typeof browserSync>): TaskNode;
}
export interface TaskArgs {
    inDirs: string[];
    outDir?: string;
    cacheDir?: string;
}
export interface TaskBuildArgs extends TaskArgs {
    console: Console;
    stdout: Writable;
    stderr: Writable;
}
export interface BuildResult {
    notChanged?: boolean;
}
export interface Task {
    readonly name: string;
    readonly displayName: string;
    readonly needsCache: boolean;
    readonly hasOutput: boolean;
    readonly persistentOutput: boolean;
    readonly volatile: boolean;
    beginWatching?(args: TaskArgs, cb: () => void): Promise<void>;
    build(args: TaskBuildArgs): Promise<BuildResult>;
    clearDest?(): Promise<void>;
}
export declare function src(path: string, name?: string): Task;
export declare function dest(path: string, name?: string): Task;
export declare function exec(cmd: ExecCommand, opts?: {
    name?: string;
    needsCache?: boolean;
    hasOutput?: boolean;
    persistentOutput?: boolean;
    volatile?: boolean;
    verify?: (args: TaskArgs) => boolean;
}): Task;
declare type ExecCommand = string | ((args: {
    i?: string;
    is: string[];
    inDirs: string[];
    o?: string;
    outDir?: string;
    c?: string;
    cacheDir?: string;
}) => string[]);
export declare function copy(opts?: {
    name?: string;
    map?: ({
        from?: string;
        to?: string;
        filter?: RegExp | ((filename: string) => boolean);
    } | undefined)[];
}): Task;
export declare function cache(name?: string): Task;
export declare function browserSync(opts?: {
    name?: string;
    config?: BS.Options;
}): Task;
export interface Disposable {
    dispose(): void;
}
export declare function disposable(dispose: () => void): Disposable;
export declare function cmd(literals: TemplateStringsArray, ...placeholders: (string | string[])[]): string[];
export {};
