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
