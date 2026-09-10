export interface PendingOption {
    /** Value returned when the user picks this option (A / 1 / answer / ...). */
    value: string;
    label?: string;
}
export interface PendingEntry {
    kind: string;
    question: string;
    createdAt: number;
    /** Choices offered by the card that opened this question. */
    options?: PendingOption[];
    /** The message text that opened the question (disambiguation replay). */
    originalText?: string;
    /** Short summary shown on receipts (permission-mode cards). */
    summary?: string;
}
export interface PendingStoreOptions {
    /** Root dir; entries live in `<dir>/<channel>/<chatId>.json`. */
    dir: string;
    ttlMs?: number;
}
export declare class PendingStore {
    readonly dir: string;
    readonly ttlMs: number;
    constructor(opts: PendingStoreOptions);
    private file;
    has(channel: string, chatId: string): boolean;
    get(channel: string, chatId: string): PendingEntry | null;
    set(channel: string, chatId: string, entry: Omit<PendingEntry, 'createdAt'>): void;
    clear(channel: string, chatId: string): void;
    /** List `kind:question` strings for the auth-state tool. */
    listAll(): string[];
}
