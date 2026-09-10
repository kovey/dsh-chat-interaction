/**
 * Project state resolution, ported from dsh-feishu and generalized per channel.
 *
 * Anchors per-project state on the MAIN repo root (git-common-dir) so
 * worktrees of the same project share one state dir; falls back to ~/.dsh
 * for global files. Every path is namespaced by channel name, so Feishu and
 * WeCom state never collide inside one project.
 * @module dsh-chat-interaction/state
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
/** Harness home: $DSH_HOME when set, else ~/.dsh (harness convention). */
export function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
/** `<repo>/.dsh` (preferred) or `<repo>/.claude` (legacy), anchored on the git common dir. */
export function projStateDir(cwd = process.cwd()) {
    try {
        let out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
        if (out) {
            if (!path.isAbsolute(out))
                out = path.resolve(cwd, out);
            const repoRoot = path.dirname(out);
            const dsh = path.join(repoRoot, '.dsh');
            const claude = path.join(repoRoot, '.claude');
            if (fs.existsSync(dsh))
                return dsh;
            if (fs.existsSync(claude))
                return claude;
            return dsh;
        }
    }
    catch { /* not a repo */ }
    const localDsh = path.join(cwd, '.dsh');
    return fs.existsSync(localDsh) ? localDsh : path.join(cwd, '.claude');
}
export function inGitRepo(cwd = process.cwd()) {
    try {
        execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
        return true;
    }
    catch {
        return false;
    }
}
/** `~` expansion with DSH-home awareness (`~/.dsh` resolves to $DSH_HOME). */
export function expandHome(p) {
    if (!p)
        return '';
    if (p === '~')
        return os.homedir();
    if (p === '~/.dsh')
        return dshHome();
    if (p.startsWith('~/.dsh/'))
        return path.join(dshHome(), p.slice('~/.dsh/'.length));
    if (p.startsWith('~/'))
        return path.join(os.homedir(), p.slice(2));
    return p;
}
/**
 * Every state path one channel needs inside one project context.
 * `channel` is the adapter name (`feishu`, `wecom`, ...).
 */
export function statePaths(channel, cwd = process.cwd(), cfg = {}) {
    const proj = projStateDir(cwd);
    return {
        proj,
        activeChat: path.join(proj, `${channel}-active-chat.txt`),
        p2pChat: path.join(proj, `${channel}-last-p2p-chat.txt`),
        modeFile: path.join(proj, `${channel}-permission-mode.txt`),
        allowlist: path.join(proj, `${channel}-permission-allowlist.txt`),
        cardStore: expandHome(cfg.cardStoreDir || `~/.dsh/${channel}-cards`),
        globalActiveChat: path.join(dshHome(), `${channel}-active-chat.txt`),
        /** Downloaded inbound images — per project AND per channel. */
        mediaDir: path.join(proj, `${channel}-media`),
        /** Task-active marker dir — per project AND per channel. */
        taskActiveDir: path.join(proj, `${channel}-task-active`),
    };
}
/** Remember the most-recent inbound chat (permission hook / reply routing). */
export function writeActiveChat(paths, chatId, cwd = process.cwd()) {
    if (!chatId)
        return;
    try {
        fs.writeFileSync(paths.activeChat, chatId + '\n');
    }
    catch { /* best effort */ }
    // Only non-repo contexts may write the GLOBAL file (multi-project isolation).
    if (!inGitRepo(cwd)) {
        try {
            fs.writeFileSync(paths.globalActiveChat, chatId + '\n');
        }
        catch { /* best effort */ }
    }
}
export function readFileSafe(p) {
    try {
        return fs.readFileSync(p, 'utf8').trim();
    }
    catch {
        return '';
    }
}
export function writeFileSafe(p, content) {
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return true;
    }
    catch {
        return false;
    }
}
/** Prune files older than `maxAgeMs` inside a directory (best effort). */
export function pruneOldFiles(dir, maxAgeMs) {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            try {
                if (fs.statSync(fp).isFile() && now - fs.statSync(fp).mtimeMs > maxAgeMs)
                    fs.unlinkSync(fp);
            }
            catch { /* per-file best effort */ }
        }
    }
    catch { /* dir missing etc. */ }
}
