#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { loadConfig, VERSION } from '../server/config.js';
import { createApp } from '../server/app.js';
import { runMcpStdio } from '../server/mcp.js';
import { Auth } from '../server/auth.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  } else pos.push(rest[i]);
}

const HELP = `VaultFree ${VERSION}

  vaultfree serve [--port N] [--host H] [--data DIR]   start the server
  vaultfree user add <name> [--admin] [--password P]   create a user (prints a random password if omitted)
  vaultfree user passwd <name> [--password P]          reset a password
  vaultfree user list
  vaultfree verify                                     check vault integrity (hashes, audit chain)
  vaultfree mcp --url URL --token vf_... [--vault ID]  run the MCP server for AI clients (stdio)

Environment: VAULTFREE_DATA, VAULTFREE_PORT, VAULTFREE_HOST, VAULTFREE_ALLOW_SIGNUP,
VAULTFREE_USERS_CAN_CREATE_VAULTS, VAULTFREE_TRUST_PROXY, VAULTFREE_SECURE_COOKIES`;

const cfg = loadConfig(process.env, {
  ...(flags.data ? { dataDir: flags.data } : {}),
  ...(flags.port ? { port: Number(flags.port) } : {}),
  ...(flags.host ? { host: flags.host } : {}),
});

async function main() {
  switch (cmd) {
    case 'serve': {
      const app = await createApp(cfg);
      const addr = await app.listen();
      console.log(`VaultFree ${VERSION} listening on http://${addr.address}:${addr.port}  (data: ${cfg.dataDir})`);
      if (!app.auth.hasUsers) console.log('No users yet: open the page and create the first account (it becomes admin).');
      const stop = async () => { await app.close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }
    case 'user': {
      const auth = new Auth(cfg.dataDir);
      const [sub, name] = pos;
      if (sub === 'list') return console.table(auth.listUsers().map(({ username, role, disabled }) => ({ username, role, disabled })));
      const pw = typeof flags.password === 'string' ? flags.password : randomBytes(9).toString('base64url');
      if (sub === 'add') {
        await auth.createUser({ username: name, password: pw, role: flags.admin ? 'admin' : 'user' });
        console.log(`Created ${name}. Password: ${pw}`);
      } else if (sub === 'passwd') {
        await auth.setPassword(name, pw);
        console.log(`Password for ${name} set to: ${pw}`);
      } else console.log(HELP);
      await auth.queue;
      break;
    }
    case 'verify': {
      const { VaultManager } = await import('../server/vaults.js');
      const vm = await new VaultManager(cfg.dataDir).load();
      let bad = 0;
      for (const v of vm.vaults.values()) {
        const r = await v.verify();
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${v.id}: ${r.notes} notes, ${r.objects} objects, ${r.auditEntries} audit entries`);
        r.problems.forEach((p) => console.log('     - ' + p));
        if (!r.ok) bad++;
      }
      process.exit(bad ? 1 : 0);
      break;
    }
    case 'mcp': {
      const url = flags.url || process.env.VAULTFREE_URL;
      const token = flags.token || process.env.VAULTFREE_TOKEN;
      if (!url || !token) { console.error('mcp needs --url and --token (or VAULTFREE_URL / VAULTFREE_TOKEN)'); process.exit(2); }
      runMcpStdio({ url, token, defaultVault: flags.vault || process.env.VAULTFREE_VAULT });
      break;
    }
    case 'version': console.log(VERSION); break;
    default: console.log(HELP);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
