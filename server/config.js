import path from 'node:path';

export const VERSION = '0.1.0';

export function loadConfig(env = process.env, overrides = {}) {
  const bool = (v, d) => (v == null ? d : /^(1|true|yes|on)$/i.test(v));
  const publicUrl = (env.VAULTFREE_PUBLIC_URL || '').replace(/\/+$/, '');
  const https = publicUrl.startsWith('https://');
  return {
    publicUrl,
    tunnelToken: env.VAULTFREE_TUNNEL_TOKEN || '',
    dataDir: path.resolve(env.VAULTFREE_DATA || './data'),
    port: Number(env.VAULTFREE_PORT || env.PORT || 3000),
    host: env.VAULTFREE_HOST || '127.0.0.1',
    allowSignup: bool(env.VAULTFREE_ALLOW_SIGNUP, false),
    usersCanCreateVaults: bool(env.VAULTFREE_USERS_CAN_CREATE_VAULTS, true),
    trustProxy: bool(env.VAULTFREE_TRUST_PROXY, https),
    secureCookies: bool(env.VAULTFREE_SECURE_COOKIES, https),
    demo: bool(env.VAULTFREE_DEMO, false),
    demoTtlHours: Math.max(1, Number(env.VAULTFREE_DEMO_TTL_HOURS) || 24),
    demoMaxSandboxes: Math.max(1, Number(env.VAULTFREE_DEMO_MAX) || 200),
    ...overrides,
  };
}
