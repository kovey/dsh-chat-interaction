/** Harness home: $DSH_HOME when set, else ~/.dsh (harness convention). */
export declare function dshHome(): string;
/** `<repo>/.dsh` (preferred) or `<repo>/.claude` (legacy), anchored on the git common dir. */
export declare function projStateDir(cwd?: string): string;
export declare function inGitRepo(cwd?: string): boolean;
/** `~` expansion with DSH-home awareness (`~/.dsh` resolves to $DSH_HOME). */
export declare function expandHome(p: string | null | undefined): string;
/**
 * Every state path one channel needs inside one project context.
 * `channel` is the adapter name (`feishu`, `wecom`, ...).
 */
export declare function statePaths(channel: string, cwd?: string, cfg?: {
    cardStoreDir?: string;
    mediaRetentionDays?: number;
}): {
    proj: string;
    activeChat: string;
    p2pChat: string;
    modeFile: string;
    allowlist: string;
    /**
     * Who may answer an approval card (one platform user id per line).
     * Empty file + `requireApproverList: false` = anyone in the bound chat,
     * which is the historical behaviour; a filled list restricts it.
     */
    approvers: string;
    /** Append-only JSONL of every approval decision (who/when/which card). */
    approvalLedger: string;
    cardStore: string;
    globalActiveChat: string;
    /** Downloaded inbound images — per project AND per channel. */
    mediaDir: string;
    /** Task-active marker dir — per project AND per channel. */
    taskActiveDir: string;
};
/** Remember the most-recent inbound chat (permission hook / reply routing). */
export declare function writeActiveChat(paths: ReturnType<typeof statePaths>, chatId: string, cwd?: string): void;
export declare function readFileSafe(p: string): string;
export declare function writeFileSafe(p: string, content: string): boolean;
/** Prune files older than `maxAgeMs` inside a directory (best effort). */
export declare function pruneOldFiles(dir: string, maxAgeMs: number): void;
