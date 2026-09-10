/**
 * Ambient declarations for the OPTIONAL platform SDKs, so the package
 * compiles and tests run without them installed. Both are lazy-loaded at
 * runtime via dynamic import and degrade gracefully when absent.
 */

declare module '@larksuiteoapi/node-sdk' {
    export const WSClient: any
    export const Client: any
    export const EventDispatcher: any
    export const LoggerLevel: any
    const sdk: any
    export default sdk
}

declare module '@wecom/crypto' {
    export function getSignature(token: string, timestamp: string, nonce: string, encrypt: string): string
    export function decrypt(aesKey: string, encrypt: string): { message: string; id: string }
    export function encrypt(aesKey: string, message: string, id: string): string
}

/**
 * 企业微信智能机器人官方 Node SDK（WS 长连接）。可选 peer：由
 * adapters/wecom-bot.ts 惰性 `import()`，未安装时仅该渠道不可用。
 */
declare module '@wecom/aibot-node-sdk' {
    const sdk: any
    export default sdk
    export const WSClient: any
    export function generateReqId(prefix: string): string
    export type WsFrame<T = any> = {
        cmd?: string
        headers: { req_id: string; [k: string]: any }
        body?: T
        errcode?: number
        errmsg?: string
    }
}
