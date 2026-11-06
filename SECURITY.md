# Security policy

Please report vulnerabilities privately via GitHub Security Advisories on this repository (not public issues).

Built-in protections: scrypt password hashing, HttpOnly + SameSite cookies, Origin-based CSRF checks, strict Content-Security-Policy, escaped Markdown rendering with URL scheme filtering, path normalization (no traversal / hidden folders), per-token scopes and vault restrictions, login throttling, hash-chained audit log.

Operators: run behind HTTPS, keep sign-up closed unless needed, protect the data directory (contains `auth.json` with password hashes and token hashes).
