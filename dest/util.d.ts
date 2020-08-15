/// <reference types="node" />
import { Writable } from "stream";
export declare class InterleavedStreams {
    private outputs;
    readonly stdout: Writable;
    readonly stderr: Writable;
    constructor();
    isEmpty(): boolean;
    isOutEmpty(): boolean;
    isErrEmpty(): boolean;
    output(): void;
}
export declare function captureOutputStreams<T>(fn: () => Promise<T>, debug?: boolean): Promise<{
    streams: InterleavedStreams;
    res: T;
}>;
export declare function makeGetter<T>(getter: (name: string) => T): {
    [name: string]: T;
};
export declare type Placeholder<T> = () => T;
export declare class PropContext<T> {
    private getters;
    /** readable for debug purpose */
    readonly masterAsyncId: Map<number, number>;
    private placeholders;
    private placeholderSet;
    private hook;
    constructor();
    getPlaceholder(name: string): Placeholder<T>;
    run<U>(getter: (name: string) => T, fn: () => Promise<U>): Promise<U>;
    resolvePlaceholder(placeholder: Placeholder<T>): T;
}
export declare function filterUndefined<T>(items: (T | undefined)[]): T[];
export declare function clearConsole(): void;
export declare function padZero(num: number, max: number): string;
export declare function isStringArray(arr: any): arr is string[];
export declare function uniq<T>(arr: T[]): T[];
export declare function date(): string;
export declare function onExit(fn: () => void): {
    cancel: () => void;
};
export declare function debounce<T>(fn: (items: T[]) => void, delay: number): (items: T[]) => void;
export declare function oneAtATime<T>(fn: (items: T[]) => Promise<void>): (item: T[]) => void;
export declare function every(promises: Promise<boolean>[]): Promise<boolean>;
export declare function rm(path: string): Promise<void>;
export declare function rmSync(path: string): void;
export declare function cp(src: string, dest: string): Promise<void>;
export declare function mkdirp(dir: string): Promise<void>;
export declare function mkdirpSync(dir: string): void;
export declare function mkdtempIn(dir: string): Promise<string>;
export declare function clearDir(dir: string): Promise<void>;
export declare function isSameFS(entry1: string, entry2: string): Promise<boolean>;
export declare function error(message: string): never;
export declare function invalid(): never;
export declare function bug(): never;
export declare function never(a: never): never;
