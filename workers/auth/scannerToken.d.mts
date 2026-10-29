export declare const SCANNER_TOKEN_AUDIENCE: 'nexus-scanner';
export declare const SCANNER_TOKEN_COOKIE: 'nexus_scanner';
export type AuthMode = 'off' | 'report' | 'enforce';
export interface ScannerTokenPayload {
  v: 1; kid: string; sub: string; aud: 'nexus-scanner'; scope: Array<'data' | 'ai'>;
  src: 'launch' | 'combo'; iat: number; exp: number;
}
export type ScannerTokenResult =
  | { status: 'valid'; payload: ScannerTokenPayload }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };
export interface ScannerTokenEnv { AUTH_MODE?: string; SCANNER_TOKEN_PUBLIC_KEYS?: string }
export declare function authMode(env: ScannerTokenEnv | undefined): AuthMode;
export declare function verifyScannerToken(request: Request, env: ScannerTokenEnv, scope: 'data' | 'ai', nowSeconds?: number): Promise<ScannerTokenResult>;
export declare function denial(result: ScannerTokenResult, mode: AuthMode, headers?: Record<string, string>): Response | null;
export declare function logAuth(result: ScannerTokenResult, mode: AuthMode, route: string): void;
export declare function keepPrivate(response: Response): Response;
