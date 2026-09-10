export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogFn = (level: LogLevel, ...msg: unknown[]) => void;
/** (Re)point the file logger; creates parent directories. */
export declare function setLogFile(p: string | null | undefined): void;
export declare function getLogFile(): string | null;
/** Write one line to the log file; errors also go to stderr. */
export declare function log(level: LogLevel, ...msg: unknown[]): void;
/**
 * Adapter SDKs (Lark, WeCom) accept a `{error, warn, info, debug, trace}`
 * logger object. This builds one that routes into our file — never stdout.
 */
export declare function sdkLogger(prefix?: string): Record<LogLevel, (...m: unknown[]) => void>;
