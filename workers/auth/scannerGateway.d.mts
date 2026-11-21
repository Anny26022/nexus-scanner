export declare const GATEWAY_HEADER: 'X-Nexus-Gateway';
export declare const USER_HEADER: 'X-Nexus-User';
export type AuthMode = 'off' | 'report' | 'enforce';
export type GatewayResult =
  | { status: 'valid'; user: string }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };
export interface GatewayEnv { AUTH_MODE?: string; SCANNER_GATEWAY_SECRET?: string }
export declare function authMode(env: GatewayEnv | undefined): AuthMode;
export declare function verifyGateway(request: Request, env: GatewayEnv): GatewayResult;
export declare function denial(result: GatewayResult, mode: AuthMode, headers?: Record<string, string>): Response | null;
export declare function logAuth(result: GatewayResult, mode: AuthMode, route: string): void;
export declare function withoutCredentials(request: Request): Request;
export declare function keepPrivate(response: Response): Response;
