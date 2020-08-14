import * as BS from "browser-sync";
import { InterleavedStreams, Placeholder } from "./util";
export declare class Builder {
    private config?;
    private tasks;
    private frozen;
    constructor(config?: Partial<Config> | undefined);
    task(deps: TaskNode[], task: Task): TaskNode;
    freeze(): Runner;
    src(...args: Parameters<typeof src>): TaskNode;
    merge(deps: TaskNode[], ...args: Parameters<typeof merge>): TaskNode;
    asyncBuild(deps: TaskNode[], ...args: Parameters<typeof customBuild>): TaskNode;
}
declare class TaskNode {
    _builder: Builder;
    _instance: TaskInstance;
    constructor(_builder: Builder, _instance: TaskInstance);
    then(task: Task): TaskNode;
    if(condition: boolean, task: Task): TaskNode;
    dest(...args: Parameters<typeof dest>): TaskNode;
    cache(...args: Parameters<typeof cache>): TaskNode;
    filterFiles(...args: Parameters<typeof filterFiles>): TaskNode;
    browserSync(...args: Parameters<typeof browserSync>): TaskNode;
    asyncBuild(...args: Parameters<typeof customBuild>): TaskNode;
}
declare class Runner {
    private tasks;
    private isRunning;
    config: Config;
    /** @param tasks topologically sorted DAG */
    constructor(tasks: TaskInstance[], config?: Partial<Config>);
    dotGraph(): string;
    clear(): Promise<void>;
    build(): Promise<void>;
    watch(): Promise<void>;
    private prepareTaskNodes;
    private runTaskNodes;
    private makeDependentsWaiting;
    private beginWatching;
    private getDirForTask;
}
interface Config {
    tmpDir: string;
    watchDebounce: number;
}
declare type TaskState = "WAITING" | "PENDING" | "RESOLVED" | "REJECTED" | "NOCHANGE";
declare class TaskInstance {
    task: Task;
    deps: TaskInstance[];
    readonly i: number;
    state: TaskState;
    outDir?: string;
    constructor(task: Task, deps: TaskInstance[], i: number);
    isWaiting(): boolean;
    isRunning(): boolean;
    isError(): boolean;
    isNotChanged(): boolean;
    isDone(): boolean;
    isReady(): boolean;
    run(args: BuildArgs): Promise<{
        streams: InterleavedStreams;
        res: {
            res: BuildResult;
            ok: true;
            time: number;
        } | {
            ok: false;
            time: number;
        };
    }>;
}
interface Task {
    name: string;
    displayName: string;
    volatile: boolean;
    clear?(): Promise<void>;
    watch?(cb: () => void): Promise<void>;
    build(args: BuildArgs): Promise<BuildResult>;
}
interface BuildArgs {
    inDirs: (string | undefined)[];
    getDir(name: string): string;
}
interface BuildResult {
    outDir?: string;
    notChanged: boolean;
}
interface OptionalDisplayName {
    displayName?: string;
}
export declare const buildDirPlaceholders: {
    [name: string]: Placeholder<string>;
};
export declare function src(path: string, opts?: OptionalDisplayName): Task;
export declare function dest(path: string, opts?: OptionalDisplayName): Task;
export declare function cache(opts?: OptionalDisplayName): Task;
export declare function merge(opts?: {
    pairs?: {
        from?: string;
        to?: string;
    }[];
} & OptionalDisplayName): Task;
export declare function filterFiles(pattern: string, opts?: OptionalDisplayName): Task;
export declare function browserSync(opts?: OptionalDisplayName & BS.Options): Task;
/** placeholders will be resolved using `buildDirContext` */
export declare function path(literals: TemplateStringsArray, ...placeholders: (string | string[] | Placeholder<string>)[]): string;
/** @param build use `buildDirPlaceholder` to get directories */
export declare function customBuild(build: () => Promise<void>, opts?: Pick<ExecOption, "displayName" | "volatile">): Task;
interface ExecOption extends OptionalDisplayName {
    volatile?: boolean;
    persistentOutput?: boolean;
    neverFails?: boolean;
}
/** placeholders will be resolved using `buildDirContext` */
export declare function exec(opts?: ExecOption): (literals: TemplateStringsArray, ...placeholders: (string | string[] | Placeholder<string>)[]) => Task;
export {};
