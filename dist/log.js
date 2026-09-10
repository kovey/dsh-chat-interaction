/**
 * File-backed logging, ported from the dsh-feishu plugin.
 *
 * The layer runs INSIDE the harness host process (TUI or headless service):
 * stdout belongs to the TUI, so every line goes to a log file; only errors
 * are additionally echoed to stderr.
 * @module dsh-chat-interaction/log
 */
import fs from 'node:fs';
import path from 'node:path';
let logFile = null;
/** (Re)point the file logger; creates parent directories. */
export function setLogFile(p) {
    logFile = p || null;
    if (logFile) {
        try {
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
        }
        catch { /* best effort */ }
    }
}
export function getLogFile() {
    return logFile;
}
function safeJson(v) {
    try {
        return JSON.stringify(v);
    }
    catch {
        return String(v);
    }
}
/** Write one line to the log file; errors also go to stderr. */
export function log(level, ...msg) {
    const text = msg.map((m) => (typeof m === 'string' ? m : safeJson(m))).join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
    if (logFile) {
        try {
            fs.appendFileSync(logFile, line);
        }
        catch { /* best effort */ }
    }
    if (level === 'error') {
        try {
            console.error(line);
        }
        catch { /* best effort */ }
    }
}
/**
 * Adapter SDKs (Lark, WeCom) accept a `{error, warn, info, debug, trace}`
 * logger object. This builds one that routes into our file — never stdout.
 */
export function sdkLogger(prefix = 'sdk') {
    return {
        error: (...m) => log('error', `[${prefix}]`, ...m),
        warn: (...m) => log('warn', `[${prefix}]`, ...m),
        info: (...m) => log('info', `[${prefix}]`, ...m),
        debug: (...m) => log('debug', `[${prefix}]`, ...m),
        trace: (...m) => log('trace', `[${prefix}]`, ...m),
    };
}
