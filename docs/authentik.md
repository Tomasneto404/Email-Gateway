# Authentik SSO for the admin UI

The admin UI can sign people in with [Authentik](https://goauthentik.io) over OpenID Connect.
The flow is authorization code + PKCE (S256), with `state` bound to a browser cookie and an ID-token `nonce`.
Authentik group membership decides each user's role. Local password + TOTP accounts keep working as a
break-glass path; set `LOCAL_LOGIN_ENABLED=false` to turn them off.

| Authentik group (configurable) | Gateway role |
|---|---|
| `mail-gateway-admins` (`AUTHENTIK_ADMIN_GROUP`) | `admin`: full control, sees message bodies |
| `mail-gateway-viewers` (`AUTHENTIK_VIEWER_GROUP`) | `viewer`: read-only, message bodies hidden |
| `mail-gateway-viewers` + `mail-gateway-body-viewers` (`AUTHENTIK_BODIES_GROUP`) | `viewer` who can read message bodies |
| none of the above | **no access**; the login is refused and audited |

Admin wins if a user is in both groups.

How SSO users behave:

- **Provisioning.** A user is created on their first SSO login. Their role is re-synced on every login, and changes are audited as `user.role_synced`.
- **Local edits.** Roles and body access of SSO users can't be edited in the UI; Authentik is the source of truth.
  You can still disable them locally (kill switch), and that takes effect immediately.
- **MFA.** SSO users don't get gateway TOTP. Enforce MFA in the Authentik flow instead.
- **Account linking.** An SSO login is never linked to an existing local account with the same email, because that would allow account takeover.
  Delete the local account first if you want to switch a person to SSO.

## 1. Authentik: provider and application

1. **Applications → Providers → Create → OAuth2/OpenID Provider**
   - Name: `mail-gateway`
   - Authorization flow: your explicit or implicit consent flow (one that enforces MFA)
   - Client type: **Confidential**
   - Redirect URIs: `https://<PUBLIC_URL host>/admin/auth/authentik/callback`, as a strict match
   - Signing key: any RS256 certificate, for example the default `authentik Self-signed Certificate`
   - Scopes: `openid`, `email` and `profile`. Authentik's default `profile` mapping already includes the `groups` claim.
   - Subject mode: *Based on the User's hashed ID* (default). The gateway keys users by `sub`.
2. **Applications → Applications → Create**
   - Name/slug: `mail-gateway`. The slug becomes part of the issuer URL.
   - Provider: `mail-gateway`
   - Launch URL: `https://<PUBLIC_URL host>/ui/`
   - Bind the groups below under *Policy / Group / User Bindings* so that only they can use the app.
3. **Directory → Groups**: create `mail-gateway-admins`, `mail-gateway-viewers` and, optionally, `mail-gateway-body-viewers`, then add people.

If you use a custom property mapping, make sure the ID token contains `email` and a list-valued `groups` claim.
The claim name is set by `AUTHENTIK_GROUPS_CLAIM`.

## 2. Gateway configuration (api service)

```env
PUBLIC_URL=https://mail-gw.internal.example        # what browsers see (HAProxy front)
AUTHENTIK_ENABLED=true
AUTHENTIK_ISSUER=https://authentik.example.com/application/o/mail-gateway/
AUTHENTIK_CLIENT_ID=<client id>
AUTHENTIK_CLIENT_SECRET=<client secret>            # or AUTHENTIK_CLIENT_SECRET_FILE=/run/secrets/authentik_client_secret
# optional overrides
AUTHENTIK_ADMIN_GROUP=mail-gateway-admins
AUTHENTIK_VIEWER_GROUP=mail-gateway-viewers
AUTHENTIK_BODIES_GROUP=mail-gateway-body-viewers
AUTHENTIK_SCOPES=openid profile email
AUTHENTIK_GROUPS_CLAIM=groups
```

- `AUTHENTIK_ISSUER` must match exactly what Authentik publishes in
  `/.well-known/openid-configuration`, including the trailing slash.
- The gateway server must be able to reach Authentik for discovery, the token exchange and JWKS.
- Logout ends the gateway session and then sends the browser to Authentik's end-session endpoint (RP-initiated logout).
  Register `<PUBLIC_URL>/ui/login` as an allowed post-logout redirect if your provider requires it.

## 3. Check it

1. Open `<PUBLIC_URL>/ui/login` and confirm that the **Sign in with Authentik** button appears.
2. Sign in as a member of `mail-gateway-admins`. You should land on the dashboard, and **Admin users** should list you with source *Authentik SSO*.
3. Sign in as a user without any mapped group. You should come back to the login page with "not in a mail-gateway group".
   The **Activity log** shows the refused `auth.login` with reason `no_mapped_group`.
4. Move a user from viewers to admins in Authentik, then log in again. The role updates and `user.role_synced` is logged.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Invalid SSO state (login CSRF protection)` | The callback was opened in a different browser or session than the login, or the state cookie expired after 10 min. Start again from `/ui/login`. |
| `SSO token exchange failed: ... issuer` | `AUTHENTIK_ISSUER` doesn't exactly match the discovery document; check the trailing slash and the slug. |
| `did not provide an email claim` | Add the `email` scope or mapping. |
| Redirect URI mismatch shown by Authentik | `PUBLIC_URL` differs from what's registered; scheme, host and port must match. |
| Login works, but every change fails with `CSRF_FAILED` | `PUBLIC_URL` is unset or wrong behind a TLS-terminating proxy. The browser's Origin must match `PUBLIC_URL`. |

Automated coverage: `test/integration/authentik-sso.test.ts` runs the whole flow against an Authentik-shaped
mock issuer (`/application/o/<slug>/`) that sends a `groups` claim. It covers PKCE/nonce, group mapping,
role re-sync, denial without a group, login CSRF, end-session and the local-account collision.
