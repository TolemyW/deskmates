// T1 fake OpenID Provider for ADR-0022 SSO tests: discovery, JWKS, authorization and token
// endpoints over real loopback HTTP, RS256 ID tokens signed with `jose`. It enforces what a real
// IdP enforces (registered client and redirect URI, single-use codes, S256 PKCE) and exposes
// knobs that make it misbehave the ways the Gateway must refuse: another issuer or audience, a
// wrong nonce, an expired token, a signature from a key outside its JWKS, an outage, a rotated key.

import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type CryptoKey, type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/** What the user "is" at the IdP, and how this one token should be wrong. */
export interface FakeIdpLogin {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Seconds since epoch; defaults to now. */
  authTime?: number;
  /** IdP session id to put in the ID token (`sid`). */
  sid?: string;
  tamper?: {
    iss?: string;
    aud?: string;
    nonce?: string;
    /** Seconds relative to now for `exp`; negative gives an expired token. */
    expiresIn?: number;
    /** Sign with a key that is not in the JWKS. */
    rogueKey?: boolean;
    /** Leave `auth_time` out of the token. */
    omitAuthTime?: boolean;
  };
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  login: FakeIdpLogin;
  used: boolean;
}

async function newKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = randomBytes(8).toString("hex");
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export class FakeIdp {
  readonly clientId = "deskmates-test-client";
  readonly clientSecret = "fake-idp-client-secret";
  /** When true every endpoint answers 503, as an IdP outage would. */
  down = false;
  /** Number of discovery documents served, to see caching and recovery. */
  discoveryCount = 0;
  /**
   * For real-browser checks: who `GET /authorize` signs in, with no login page. Unset, the
   * endpoint answers 404 and tests drive `authorize()` directly.
   */
  browserLogin: FakeIdpLogin | undefined;
  private keys: SigningKey[] = [];
  private rogue: SigningKey | undefined;
  private readonly codes = new Map<string, PendingCode>();
  private server: Server | undefined;
  private base = "";

  private constructor(private readonly path: string) {}

  static async start(path = "/idp"): Promise<FakeIdp> {
    const idp = new FakeIdp(path);
    idp.keys = [await newKey()];
    idp.rogue = await newKey();
    idp.server = createServer((request, response) => {
      idp.handle(request, response).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
    idp.server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => idp.server?.once("listening", () => resolve()));
    const { port } = idp.server.address() as AddressInfo;
    idp.base = `http://127.0.0.1:${port}`;
    return idp;
  }

  get issuer(): string {
    return `${this.base}${this.path}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Publish a new signing key and retire the old one from the JWKS (key rotation). */
  async rotateKey(): Promise<void> {
    this.keys = [await newKey()];
  }

  /**
   * The user signs in at the IdP: validate the authorization request as an IdP would and return
   * the redirect back to the client with a fresh code (or the error a real IdP would send).
   */
  authorize(authorizationUrl: string, login: FakeIdpLogin): string {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== `${this.issuer}/authorize`)
      throw new Error(`authorization URL is not this IdP's: ${url.href}`);
    const p = url.searchParams;
    const redirectUri = p.get("redirect_uri") ?? "";
    const state = p.get("state") ?? "";
    if (p.get("client_id") !== this.clientId) throw new Error("unknown client_id");
    if (p.get("response_type") !== "code") throw new Error("response_type must be code");
    if (p.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
    if (!p.get("scope")?.split(" ").includes("openid")) throw new Error("openid scope required");
    const code = base64url(randomBytes(24));
    this.codes.set(code, {
      clientId: this.clientId,
      redirectUri,
      codeChallenge: p.get("code_challenge") ?? "",
      nonce: p.get("nonce") ?? "",
      login,
      used: false,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    return back.href;
  }

  /** The parameters the last authorization URL carried, for assertions. */
  static params(authorizationUrl: string): URLSearchParams {
    return new URL(authorizationUrl).searchParams;
  }

  /**
   * A back-channel logout token (OpenID Connect Back-Channel Logout 1.0, section 2.4) for this
   * client, with knobs to make it invalid in each way the Gateway must refuse.
   */
  async logoutToken(input: {
    sub?: string;
    sid?: string;
    jti?: string;
    tamper?: {
      iss?: string;
      aud?: string;
      /** Seconds relative to now for `iat`. */
      iatOffset?: number;
      noEvent?: boolean;
      nonce?: string;
      rogueKey?: boolean;
      typ?: string;
    };
  }): Promise<string> {
    const tamper = input.tamper ?? {};
    const key = tamper.rogueKey ? (this.rogue as SigningKey) : (this.keys[0] as SigningKey);
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      jti: input.jti ?? randomBytes(12).toString("hex"),
      ...(tamper.noEvent
        ? {}
        : { events: { "http://schemas.openid.net/event/backchannel-logout": {} } }),
      ...(input.sid !== undefined ? { sid: input.sid } : {}),
      ...(tamper.nonce !== undefined ? { nonce: tamper.nonce } : {}),
    };
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: tamper.typ ?? "logout+jwt" })
      .setIssuer(tamper.iss ?? this.issuer)
      .setAudience(tamper.aud ?? this.clientId)
      .setIssuedAt(now + (tamper.iatOffset ?? 0))
      .setExpirationTime(now + (tamper.iatOffset ?? 0) + 120);
    if (input.sub !== undefined) jwt.setSubject(input.sub);
    return jwt.sign(key.privateKey);
  }

  private async idToken(pending: PendingCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const { login } = pending;
    const tamper = login.tamper ?? {};
    const key = tamper.rogueKey ? (this.rogue as SigningKey) : (this.keys[0] as SigningKey);
    const claims: Record<string, unknown> = {
      nonce: tamper.nonce ?? pending.nonce,
      ...(tamper.omitAuthTime ? {} : { auth_time: login.authTime ?? now }),
      ...(login.email !== undefined ? { email: login.email } : {}),
      ...(login.emailVerified !== undefined ? { email_verified: login.emailVerified } : {}),
      ...(login.name !== undefined ? { name: login.name } : {}),
      ...(login.sid !== undefined ? { sid: login.sid } : {}),
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(tamper.iss ?? this.issuer)
      .setAudience(tamper.aud ?? pending.clientId)
      .setSubject(login.sub)
      .setIssuedAt(now - 5)
      .setExpirationTime(now + (tamper.expiresIn ?? 300))
      .sign(key.privateKey);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.base);
    const json = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (this.down) return json(503, { error: "temporarily_unavailable" });
    if (url.pathname === `${this.path}/.well-known/openid-configuration`) {
      this.discoveryCount += 1;
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.pathname === `${this.path}/authorize` && this.browserLogin) {
      response.statusCode = 302;
      response.setHeader("location", this.authorize(url.href, this.browserLogin));
      response.end();
      return;
    }
    if (url.pathname === `${this.path}/jwks`)
      return json(200, { keys: this.keys.map((key) => key.publicJwk) });
    if (url.pathname === `${this.path}/token` && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const pending = this.codes.get(form.get("code") ?? "");
      if (!pending || pending.used) return json(400, { error: "invalid_grant" });
      pending.used = true;
      if (
        form.get("client_id") !== pending.clientId ||
        form.get("client_secret") !== this.clientSecret
      )
        return json(401, { error: "invalid_client" });
      if (form.get("redirect_uri") !== pending.redirectUri)
        return json(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      if (challenge !== pending.codeChallenge) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: base64url(randomBytes(16)),
        token_type: "Bearer",
        expires_in: 300,
        id_token: await this.idToken(pending),
      });
    }
    json(404, { error: "not_found" });
  }
}
